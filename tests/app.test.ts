import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import { createApp } from "../src/server/app.js";
import { now, uid, hash, passwordHash } from "../src/server/core.js";
import { claimJob, processOne } from "../src/server/worker.js";
import { recoverJobs } from "../src/server/jobs.js";
import { probeMedia } from "../src/server/media.js";
import type { Asset, Job } from "../src/shared/types.js";
import * as providers from "../src/server/providers.js";

let fixture: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let cookie: string;
let owner: string;
async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  session = cookie,
) {
  return fixture.app.inject({
    method,
    url: `/api${url}`,
    headers: { cookie: session, origin: "http://127.0.0.1:4318" },
    ...(payload === undefined
      ? {}
      : { payload: payload as Record<string, unknown> }),
  });
}
async function upload(bytes: Buffer, name: string) {
  return uploadMany([{ bytes, name }]);
}
async function uploadMany(files: { bytes: Buffer; name: string }[]) {
  const boundary = `crosscut-${uid()}`;
  const body = Buffer.concat([
    ...files.flatMap(({ bytes, name }) => [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from("\r\n"),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return fixture.app.inject({
    method: "POST",
    url: "/api/assets",
    headers: {
      cookie,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}
async function imageAsset(): Promise<Asset> {
  const bytes = await sharp({
    create: { width: 320, height: 480, channels: 3, background: "#3d6350" },
  })
    .png()
    .toBuffer();
  const response = await upload(bytes, "产品图.png");
  expect(response.statusCode, response.body).toBe(200);
  return response.json().items[0];
}
async function queuedChat(): Promise<Job> {
  await call("POST", "/providers", {
    name: "事务测试",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "fixture-model",
    capabilities: ["chat"],
    apiKey: "synthetic-fixture-key",
  });
  return (
    await call("POST", "/jobs", {
      toolId: "agent-chat",
      input: { text: "fixture" },
      idempotencyKey: uid(),
    })
  ).json().items[0];
}
beforeEach(async () => {
  await mkdir(resolve("data/test-runs"), { recursive: true });
  directory = await mkdtemp(resolve("data/test-runs/api-"));
  fixture = await createApp({ dataDir: directory, serveStatic: false });
  const response = await call(
    "POST",
    "/auth/setup",
    {
      email: "qa@example.test",
      name: "验收用户",
      password: "Synthetic-test-password-42",
    },
    "",
  );
  expect(response.statusCode, response.body).toBe(200);
  cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  owner = response.json().user.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.app.close();
  await rm(directory, { recursive: true, force: true });
});

describe("本地空间权限与输入边界", () => {
  it("需要登录，限制初始化、外站写入和异常Host，并且会话可撤销", async () => {
    expect((await call("GET", "/projects", undefined, "")).statusCode).toBe(
      401,
    );
    expect(
      (
        await call("POST", "/auth/setup", {
          email: "next@example.test",
          name: "二次",
          password: "Synthetic-test-password-42",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie, origin: "https://example.test" },
          payload: { name: "禁止" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await fixture.app.inject({
          url: "/api/health",
          headers: { host: "attacker.test:4318" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/auth/login",
          { email: "qa@example.test", password: "incorrect" },
          "",
        )
      ).statusCode,
    ).toBe(401);
    const state = (await call("GET", "/auth/status")).json();
    expect(state.initialized).toBe(true);
    expect(state.user.id).toBe(owner);
    expect((await call("POST", "/auth/logout")).statusCode).toBe(200);
    expect((await call("GET", "/projects")).statusCode).toBe(401);
  });

  it("项目、素材、草稿、对话、任务和雷达均隔离用户", async () => {
    const asset = await imageAsset();
    const project = (
      await call("POST", "/projects", { name: "自有项目" })
    ).json();
    const draft = (
      await call("POST", "/drafts", {
        title: "测试",
        toolId: "slideshow",
        input: { sourceIds: [asset.id] },
      })
    ).json();
    const conversation = (
      await call("POST", "/conversations", { title: "创意" })
    ).json();
    const radar = (
      await call("POST", "/radar", { title: "自有参考", assetId: asset.id })
    ).json();
    const job = (
      await call("POST", "/jobs", {
        toolId: "slideshow",
        input: { sourceIds: [asset.id] },
        idempotencyKey: uid(),
      })
    ).json().items[0];
    const second = uid(),
      raw = uid();
    fixture.store.run(
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
      second,
      "second@example.test",
      "第二用户",
      passwordHash("Synthetic-other-password"),
      now(),
    );
    fixture.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(raw),
      second,
      new Date(Date.now() + 3600000).toISOString(),
    );
    const secondCookie = `crosscut_session=${raw}`;
    for (const path of [
      `/assets/${asset.id}/file`,
      `/jobs/${job.id}`,
      `/jobs/${job.id}/download`,
      `/batches/${job.batchId}`,
      `/batches/${job.batchId}/download`,
      `/conversations/${conversation.id}`,
    ])
      expect(
        (await call("GET", path, undefined, secondCookie)).statusCode,
      ).toBe(404);
    for (const [path, payload] of [
      [`/projects/${project.id}`, { name: "越权" }],
      [`/assets/${asset.id}`, { deleted: true }],
    ] as const)
      expect(
        (await call("PATCH", path, payload, secondCookie)).statusCode,
      ).toBe(404);
    expect(
      (
        await call(
          "POST",
          "/drafts",
          { id: draft.id, title: "越权", toolId: "slideshow", input: {} },
          secondCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          "POST",
          `/radar/${radar.id}/favorite`,
          { favorite: true },
          secondCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", "/projects", undefined, secondCookie)).json().total,
    ).toBe(0);
    for (const action of ["cancel", "retry"])
      expect(
        (
          await call(
            "POST",
            `/batches/${job.batchId}/${action}`,
            undefined,
            secondCookie,
          )
        ).statusCode,
      ).toBe(404);
    expect((await call("GET", `/jobs/${job.id}`)).json().status).toBe("queued");
    await call("DELETE", `/drafts/${draft.id}`);
    expect(
      (
        await call(
          "PATCH",
          `/drafts/${draft.id}`,
          { deleted: false },
          secondCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", "/drafts?trash=1")).json().items[0].input,
    ).toEqual({ sourceIds: [asset.id] });
  });

  it("校验实际文件内容、Range、回收站以及恢复后的原字节", async () => {
    expect(
      (await upload(Buffer.from("not really an image"), "pretend.png"))
        .statusCode,
    ).toBe(400);
    const asset = await imageAsset();
    const full = await call("GET", `/assets/${asset.id}/file`);
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toContain("image/png");
    const range = await fixture.app.inject({
      url: `/api/assets/${asset.id}/file`,
      headers: { cookie, range: "bytes=0-15" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(full.rawPayload.subarray(0, 16));
    expect(
      (
        await fixture.app.inject({
          url: `/api/assets/${asset.id}/file`,
          headers: { cookie, range: "bytes=9999999-" },
        })
      ).statusCode,
    ).toBe(416);
    await call("PATCH", `/assets/${asset.id}`, { deleted: true });
    expect((await call("GET", `/assets/${asset.id}/file`)).statusCode).toBe(
      410,
    );
    expect((await call("GET", "/assets?trash=1")).json().total).toBe(1);
    await call("PATCH", `/assets/${asset.id}`, {
      deleted: false,
      tags: ["产品", "产品"],
    });
    expect((await call("GET", `/assets/${asset.id}/file`)).rawPayload).toEqual(
      full.rawPayload,
    );
    expect((await call("GET", "/assets")).json().items[0].tags).toEqual([
      "产品",
    ]);
  });
});

describe("SQLite业务和任务一致性", () => {
  it("分析生成完成保留期间人工编辑，未编辑的新版本仍接收生成结果", async () => {
    const file = join(directory, "analysis-source.mp4");
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x64:d=0.5:r=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const source = (
      await upload(await readFile(file), "analysis-source.mp4")
    ).json().items[0];
    await call("POST", "/providers", {
      name: "分析事务测试",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "fixture-model",
      capabilities: ["video.analysis"],
      apiKey: "synthetic-fixture-key",
    });
    const analysis = (
      await call("POST", "/analyses", { assetId: source.id, mode: "semantic" })
    ).json();
    fixture.store.run(
      "UPDATE jobs SET status='cancelled' WHERE tool_id!='analysis-prompt'",
    );
    vi.spyOn(providers, "runProvider")
      .mockImplementationOnce(async () => {
        await call("PATCH", `/analyses/${analysis.id}/prompt`, {
          version: 1,
          prompt: "保留我刚刚编辑的具体方案",
        });
        return { artifacts: [], result: { prompt: "较晚返回的模型方案" } };
      })
      .mockResolvedValue({
        artifacts: [],
        result: { prompt: "第二版模型方案" },
      });
    await processOne(fixture.store);
    const first = (await call("GET", `/analyses/${analysis.id}`)).json();
    expect(first.versions[0].prompt).toBe("保留我刚刚编辑的具体方案");
    expect(
      first.versions[0].jobs.find(
        (job: Job) => job.toolId === "analysis-prompt",
      ).result.prompt,
    ).toBe("较晚返回的模型方案");
    await call("POST", `/analyses/${analysis.id}/retry`, { section: "prompt" });
    await processOne(fixture.store);
    const latest = (await call("GET", `/analyses/${analysis.id}`)).json();
    expect(latest.versions[0].prompt).toBe("第二版模型方案");
    expect(latest.versions[1].prompt).toBe("保留我刚刚编辑的具体方案");
  });
  it("提交占位前收到取消时不会调用收费服务", async () => {
    const job = await queuedChat();
    const original = fixture.store.run.bind(fixture.store);
    let injected = false;
    vi.spyOn(fixture.store, "run").mockImplementation((sql, ...values) => {
      if (!injected && sql.includes("SET submission_started=1")) {
        injected = true;
        original("UPDATE jobs SET cancel_requested=1 WHERE id=?", job.id);
      }
      return original(sql, ...values);
    });
    const remote = vi.spyOn(providers, "runProvider").mockResolvedValue({
      artifacts: [],
      result: { text: "must not submit" },
    });
    await processOne(fixture.store);
    expect(injected).toBe(true);
    expect(remote).not.toHaveBeenCalled();
    expect((await call("GET", `/jobs/${job.id}`)).json().status).toBe(
      "cancelled",
    );
  });
  it("提交占位抢先完成时取消不会假报正在停止", async () => {
    const job = await queuedChat();
    claimJob(fixture.store);
    const original = fixture.store.run.bind(fixture.store);
    let injected = false;
    vi.spyOn(fixture.store, "run").mockImplementation((sql, ...values) => {
      if (!injected && sql.includes("SET cancel_requested=1,updated_at")) {
        injected = true;
        original("UPDATE jobs SET submission_started=1 WHERE id=?", job.id);
      }
      return original(sql, ...values);
    });
    const response = await call("POST", `/jobs/${job.id}/cancel`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SUBMISSION_IN_PROGRESS");
    expect((await call("GET", `/jobs/${job.id}`)).json().cancelRequested).toBe(
      false,
    );
  });
  it("收费响应后的本地完成事务失败会阻止重复提交并回滚产物关联", async () => {
    const job = await queuedChat();
    const remote = vi
      .spyOn(providers, "runProvider")
      .mockImplementation(async (ctx) => {
        const path = join(ctx.outputDir, "response.txt");
        await writeFile(
          path,
          "Synthetic response for commit-failure verification",
        );
        return {
          artifacts: [
            {
              path,
              name: "response.txt",
              kind: "document",
              mime: "text/plain",
            },
          ],
          result: { text: "fixture" },
        };
      });
    const original = fixture.store.run.bind(fixture.store);
    vi.spyOn(fixture.store, "run").mockImplementation((sql, ...values) => {
      if (sql.includes("INSERT INTO usage_events"))
        throw new Error("Synthetic database commit failure");
      return original(sql, ...values);
    });
    await processOne(fixture.store);
    const completed = (await call("GET", `/jobs/${job.id}`)).json();
    expect(completed.status).toBe("needs_review");
    expect(completed.errorCode).toBe("RESULT_COMMIT_FAILED");
    expect(completed.outputs).toEqual([]);
    expect(fixture.store.all("SELECT id FROM assets")).toEqual([]);
    expect(await readdir(fixture.store.storage.media)).toEqual([]);
    expect((await call("POST", `/jobs/${job.id}/retry`)).statusCode).toBe(409);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["RESULT_PROCESSING_FAILED", "needs_review", 409],
    ["PROVIDER_RATE_LIMIT", "failed", 200],
  ])(
    "同步服务错误 %s 按是否已受理控制重试",
    async (code, status, retryStatus) => {
      const job = await queuedChat();
      const remote = vi
        .spyOn(providers, "runProvider")
        .mockRejectedValue(
          new providers.ProviderError(
            code,
            "Synthetic provider boundary failure",
          ),
        );
      await processOne(fixture.store);
      const completed = (await call("GET", `/jobs/${job.id}`)).json();
      expect(completed.status).toBe(status);
      expect(completed.errorCode).toBe(code);
      const retried = await call("POST", `/jobs/${job.id}/retry`);
      expect(retried.statusCode).toBe(retryStatus);
      if (retryStatus === 409) {
        expect(retried.json().error.code).toBe("REVIEW_REQUIRED");
        await processOne(fixture.store);
      } else {
        expect(retried.json().status).toBe("queued");
        expect(
          fixture.store.get(
            "SELECT submission_started FROM jobs WHERE id=?",
            job.id,
          )?.submission_started,
        ).toBe(0);
      }
      expect(remote).toHaveBeenCalledTimes(1);
    },
  );
  it("多文件部分上传失败明确返回已保存项，草稿回收可以恢复", async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const response = await uploadMany([
      { name: "valid.png", bytes: png },
      { name: "invalid.png", bytes: Buffer.from("invalid content") },
      { name: "not-processed.png", bytes: png },
    ]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("PARTIAL_UPLOAD");
    expect(response.json().error.details.items).toHaveLength(1);
    const saved = response.json().error.details.items[0];
    expect((await call("GET", `/assets/${saved.id}/file`)).rawPayload).toEqual(
      png,
    );
    expect((await call("GET", "/assets")).json().total).toBe(1);
    const draft = (
      await call("POST", "/drafts", {
        title: "可恢复草稿",
        toolId: "slideshow",
        input: {},
      })
    ).json();
    await call("DELETE", `/drafts/${draft.id}`);
    expect((await call("GET", "/drafts")).json().total).toBe(0);
    expect((await call("GET", "/drafts?trash=1")).json().items[0].id).toBe(
      draft.id,
    );
    await call("PATCH", `/drafts/${draft.id}`, { deleted: false });
    expect((await call("GET", "/drafts")).json().items[0].id).toBe(draft.id);
  });

  it("批次操作保留成功项、跳过待核对项，取消与失败重试只处理符合状态的任务", async () => {
    await call("POST", "/providers", {
      name: "批次测试",
      kind: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "fixture-model",
      capabilities: ["video.task"],
      apiKey: "synthetic-fixture-key",
    });
    const batch = (
      await call("POST", "/jobs", {
        toolId: "text-video",
        input: { prompt: "fixture", count: 4 },
        idempotencyKey: uid(),
      })
    ).json();
    fixture.store.run(
      "UPDATE jobs SET status='succeeded' WHERE id=?",
      batch.items[0].id,
    );
    fixture.store.run(
      "UPDATE jobs SET status='failed' WHERE id=?",
      batch.items[1].id,
    );
    fixture.store.run(
      "UPDATE jobs SET status='needs_review',error_code='SUBMISSION_UNKNOWN' WHERE id=?",
      batch.items[2].id,
    );
    const cancelled = (
      await call("POST", `/batches/${batch.batchId}/cancel`)
    ).json();
    expect(cancelled.items).toHaveLength(1);
    expect(cancelled.items[0].status).toBe("cancelled");
    const retried = (
      await call("POST", `/batches/${batch.batchId}/retry`)
    ).json();
    expect(retried.items).toHaveLength(1);
    expect(retried.items[0].id).toBe(batch.items[1].id);
    const summary = (await call("GET", `/batches/${batch.batchId}`)).json();
    expect(summary.counts).toEqual({
      succeeded: 1,
      queued: 1,
      needs_review: 1,
      cancelled: 1,
      failed: 0,
      running: 0,
    });
  });
  it("批次失败重试不会重发远端终态或待核对的付费任务", async () => {
    await call("POST", "/providers", {
      name: "批次边界",
      kind: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "fixture-model",
      capabilities: ["video.task"],
      apiKey: "synthetic-fixture-key",
    });
    const batch = (
      await call("POST", "/jobs", {
        toolId: "text-video",
        input: { prompt: "fixture", count: 4 },
        idempotencyKey: uid(),
      })
    ).json();
    for (const [index, code] of [
      "REMOTE_FAILED",
      "REMOTE_EXPIRED",
      "SUBMISSION_UNKNOWN",
    ].entries())
      fixture.store.run(
        "UPDATE jobs SET status='failed',remote_task_id=?,error_code=? WHERE id=?",
        `remote-${index}`,
        code,
        batch.items[index].id,
      );
    fixture.store.run(
      "UPDATE jobs SET status='failed',submission_started=1,error_code='PROVIDER_RATE_LIMIT' WHERE id=?",
      batch.items[3].id,
    );
    const response = (
      await call("POST", `/batches/${batch.batchId}/retry`)
    ).json();
    expect(response.items.map((item: Job) => item.id)).toEqual([
      batch.items[3].id,
    ]);
    expect(response.errors).toHaveLength(3);
    expect(
      fixture.store.get(
        "SELECT submission_started FROM jobs WHERE id=?",
        batch.items[3].id,
      )?.submission_started,
    ).toBe(0);
    for (const job of batch.items.slice(0, 3))
      expect((await call("GET", `/jobs/${job.id}`)).json().status).toBe(
        "failed",
      );
  });
  it("保存项目关联、草稿和雷达指标，重开数据库后仍然存在", async () => {
    const asset = await imageAsset();
    const project = (
      await call("POST", "/projects", { name: "独立品牌", market: "美国" })
    ).json();
    expect(
      (
        await call("PATCH", `/projects/${project.id}/assets`, {
          assetIds: [asset.id],
        })
      ).statusCode,
    ).toBe(200);
    const draft = (
      await call("POST", "/drafts", {
        title: "未完创作",
        toolId: "slideshow",
        projectId: project.id,
        input: { sourceIds: [asset.id] },
      })
    ).json();
    const radar = (
      await call("POST", "/radar/import", {
        items: [
          {
            title: "参考A",
            likes: 31,
            ctr: 1.5,
            metrics: [
              { time: 0, retention: 100 },
              { time: 3, retention: 72 },
            ],
          },
          { title: "参考B" },
        ],
      })
    ).json();
    expect(radar.total).toBe(2);
    await call("POST", `/radar/${radar.items[0].id}/favorite`, {
      favorite: true,
    });
    await fixture.app.close();
    fixture = await createApp({ dataDir: directory, serveStatic: false });
    expect(
      (await call("GET", `/assets?projectId=${project.id}`)).json().items[0].id,
    ).toBe(asset.id);
    expect((await call("GET", "/drafts")).json().items[0].id).toBe(draft.id);
    const result = (await call("GET", "/radar?favorite=1&search=参考A")).json();
    expect(result.total).toBe(1);
    expect(result.items[0].metrics[1].retention).toBe(72);
    await call("PATCH", `/projects/${project.id}`, { archived: true });
    expect((await call("GET", "/projects")).json().total).toBe(0);
    expect((await call("GET", "/projects?archived=1")).json().total).toBe(1);
  });

  it("不配置AI时拒绝提交；保存配置只表示未验证，密钥不会出现在API和数据库明文中", async () => {
    const input = {
      toolId: "agent-chat",
      input: { text: "test" },
      idempotencyKey: uid(),
    };
    expect((await call("POST", "/jobs", input)).statusCode).toBe(503);
    const key = `fixture-secret-${uid()}`;
    const provider = (
      await call("POST", "/providers", {
        name: "测试契约",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "fixture-model",
        capabilities: ["chat"],
        apiKey: key,
      })
    ).json();
    expect(provider.status).toBe("configured_unverified");
    expect(JSON.stringify(provider)).not.toContain(key);
    const created = await call("POST", "/jobs", input);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.body).not.toContain(key);
    expect(
      String(
        fixture.store.get(
          "SELECT secret FROM providers WHERE id=?",
          provider.id,
        )?.secret,
      ),
    ).not.toContain(key);
    expect(
      String(
        fixture.store.get(
          "SELECT provider_snapshot FROM jobs WHERE id=?",
          created.json().items[0].id,
        )?.provider_snapshot,
      ),
    ).not.toContain(key);
    expect((await call("GET", "/providers")).body).not.toContain(key);
    expect(
      (
        await call("POST", "/providers", {
          id: provider.id,
          name: "新的地址",
          kind: "openai",
          baseUrl: "https://other.example.test/v1",
          model: "fixture-model",
          capabilities: ["chat"],
        })
      ).statusCode,
    ).toBe(400);
  });
  it("创建任务时按选中服务商隔离音色角色目录，不把A的ID传给B", async () => {
    const register = async (suffix: string) =>
      (
        await call("POST", "/providers", {
          name: `角色目录 ${suffix}`,
          kind: "heygen",
          baseUrl: "https://api.heygen.com",
          model: "avatar_iv",
          capabilities: ["avatar.text"],
          apiKey: "synthetic-fixture-key",
          voices: [{ id: `voice-${suffix}`, name: suffix }],
          avatars: [{ id: `look-${suffix}`, name: suffix }],
        })
      ).json();
    const a = await register("a"),
      b = await register("b");
    for (const input of [
      { text: "hi", voice: "voice-a", avatar: "look-b" },
      { text: "hi", voice: "voice-b", avatar: "look-a" },
    ]) {
      const denied = await call("POST", "/jobs", {
        toolId: "text-avatar",
        providerId: b.id,
        input,
        idempotencyKey: uid(),
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json().error.code).toBe("PROVIDER_SELECTION_MISMATCH");
    }
    expect((await call("GET", "/jobs")).json().total).toBe(0);
    for (const [config, suffix] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      const valid = await call("POST", "/jobs", {
        toolId: "text-avatar",
        providerId: config.id,
        input: {
          text: "hi",
          voice: `voice-${suffix}`,
          avatar: `look-${suffix}`,
        },
        idempotencyKey: uid(),
      });
      expect(valid.statusCode, valid.body).toBe(200);
    }
    expect((await call("GET", "/jobs")).json().total).toBe(2);
  });

  it("修改本地密码需要旧密码，并撤销其他会话", async () => {
    const previousCookie = cookie;
    expect(
      (
        await call("POST", "/me/password", {
          currentPassword: "wrong",
          newPassword: "Synthetic-new-password",
        })
      ).statusCode,
    ).toBe(401);
    const changed = await call("POST", "/me/password", {
      currentPassword: "Synthetic-test-password-42",
      newPassword: "Synthetic-new-password",
    });
    expect(changed.statusCode).toBe(200);
    expect(
      (await call("GET", "/projects", undefined, previousCookie)).statusCode,
    ).toBe(401);
    cookie = changed.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect((await call("GET", "/projects")).statusCode).toBe(200);
    expect(
      (
        await call(
          "POST",
          "/auth/login",
          { email: "qa@example.test", password: "Synthetic-new-password" },
          "",
        )
      ).statusCode,
    ).toBe(200);
  });

  it("多个真实进程不会重复领取同一任务，续租后也不被旧快照错误回收", async () => {
    const asset = await imageAsset();
    for (let i = 0; i < 4; i++)
      await call("POST", "/jobs", {
        toolId: "slideshow",
        input: { sourceIds: [asset.id] },
        idempotencyKey: uid(),
      });
    const script =
      "import {Store} from './src/server/db.ts';import {claimJob} from './src/server/worker.ts';const s=new Store(process.argv[1]);const ids=[];for(let i=0;i<4;i++){const j=claimJob(s);if(j)ids.push(j.id);}s.close();console.log(JSON.stringify(ids));";
    const children = await Promise.all(
      [0, 1].map(() =>
        promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script, directory],
          { cwd: resolve("."), timeout: 15000 },
        ),
      ),
    );
    const ids = children.flatMap(
      (child) => JSON.parse(child.stdout) as string[],
    );
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    fixture.store.run(
      "UPDATE jobs SET lease_until=? WHERE id=?",
      "2000-01-01T00:00:00.000Z",
      ids[0],
    );
    const original = fixture.store.all.bind(fixture.store);
    vi.spyOn(fixture.store, "all").mockImplementation((sql, ...values) => {
      const rows = original(sql, ...values);
      if (sql.includes("status='running' AND lease_until"))
        fixture.store.run(
          "UPDATE jobs SET lease_until=? WHERE id=?",
          new Date(Date.now() + 45000).toISOString(),
          ids[0],
        );
      return rows;
    });
    recoverJobs(fixture.store);
    expect(
      fixture.store.get("SELECT status FROM jobs WHERE id=?", ids[0])?.status,
    ).toBe("running");
  });

  it("排队取消和worker领取竞争不会丢请求；迟到的远端取消不污染已完成任务", async () => {
    const asset = await imageAsset();
    const created = (
      await call("POST", "/jobs", {
        toolId: "slideshow",
        input: { sourceIds: [asset.id] },
        idempotencyKey: uid(),
      })
    ).json().items[0];
    const original = fixture.store.run.bind(fixture.store);
    let injected = false;
    const race = vi
      .spyOn(fixture.store, "run")
      .mockImplementation((sql, ...values) => {
        if (
          !injected &&
          sql.includes("status='cancelled',cancel_requested=1,updated_at")
        ) {
          injected = true;
          claimJob(fixture.store);
        }
        return original(sql, ...values);
      });
    const cancelled = await call("POST", `/jobs/${created.id}/cancel`);
    expect(cancelled.json().cancelRequested).toBe(true);
    race.mockRestore();
    expect(
      fixture.store
        .all("SELECT message FROM job_events WHERE job_id=?", created.id)
        .some((r) => r.message === "排队任务已取消"),
    ).toBe(false);
    await call("POST", "/providers", {
      name: "取消契约",
      kind: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "fixture-model",
      capabilities: ["video.task"],
      apiKey: "synthetic-fixture-key",
    });
    const remote = (
      await call("POST", "/jobs", {
        toolId: "text-video",
        input: { prompt: "test" },
        idempotencyKey: uid(),
      })
    ).json().items[0];
    fixture.store.run(
      "UPDATE jobs SET status='running',remote_task_id='remote-fixture' WHERE id=?",
      remote.id,
    );
    vi.spyOn(providers, "cancelProvider").mockImplementation(async () => {
      fixture.store.run(
        "UPDATE jobs SET status='succeeded' WHERE id=?",
        remote.id,
      );
      return { supported: true, cancelled: false, message: "fixture accepted" };
    });
    const late = await call("POST", `/jobs/${remote.id}/cancel`);
    expect(late.json().status).toBe("succeeded");
    expect(late.json().cancelRequested).toBe(false);
  });

  it("重复提交只创建一份任务，参数冲突拒绝；排队取消与手动恢复保持记录", async () => {
    const asset = await imageAsset();
    const idempotencyKey = uid();
    const body = {
      toolId: "slideshow",
      input: { sourceIds: [asset.id], duration: 3 },
      idempotencyKey,
    };
    const first = (await call("POST", "/jobs", body)).json();
    const duplicate = (await call("POST", "/jobs", body)).json();
    expect(duplicate.batchId).toBe(first.batchId);
    expect(duplicate.items[0].id).toBe(first.items[0].id);
    expect(
      (
        await call("POST", "/jobs", {
          ...body,
          input: { ...body.input, duration: 5 },
        })
      ).statusCode,
    ).toBe(409);
    const id = first.items[0].id;
    expect((await call("POST", `/jobs/${id}/cancel`)).json().status).toBe(
      "cancelled",
    );
    expect((await call("POST", `/jobs/${id}/retry`)).json().status).toBe(
      "queued",
    );
    expect(
      (
        await call("POST", "/jobs", {
          ...body,
          idempotencyKey: uid(),
          input: { ...body.input, unexpected: true },
        })
      ).statusCode,
    ).toBe(400);
    expect((await call("GET", `/jobs/${id}`)).json().events.length).toBe(3);
  });

  it("过期租约恢复本地任务；外部提交结果不明必须人工核对，不能自动重发", async () => {
    const asset = await imageAsset();
    await call("POST", "/jobs", {
      toolId: "slideshow",
      input: { sourceIds: [asset.id] },
      idempotencyKey: uid(),
    });
    const local = claimJob(fixture.store)!;
    expect(claimJob(fixture.store)).toBeUndefined();
    fixture.store.run(
      "UPDATE jobs SET lease_until=? WHERE id=?",
      "2000-01-01T00:00:00.000Z",
      local.id,
    );
    recoverJobs(fixture.store);
    expect(
      fixture.store.get("SELECT status FROM jobs WHERE id=?", local.id)?.status,
    ).toBe("queued");
    await call("POST", `/jobs/${local.id}/cancel`);
    await call("POST", "/providers", {
      name: "测试契约",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "fixture-model",
      capabilities: ["chat"],
      apiKey: "synthetic-fixture-key",
    });
    const job = (
      await call("POST", "/jobs", {
        toolId: "agent-chat",
        input: { text: "test" },
        idempotencyKey: uid(),
      })
    ).json().items[0];
    claimJob(fixture.store);
    fixture.store.run(
      "UPDATE jobs SET submission_started=1,lease_until=? WHERE id=?",
      "2000-01-01T00:00:00.000Z",
      job.id,
    );
    recoverJobs(fixture.store);
    expect((await call("GET", `/jobs/${job.id}`)).json().status).toBe(
      "needs_review",
    );
    expect((await call("POST", `/jobs/${job.id}/retry`)).statusCode).toBe(409);
  });

  it("完成上传→项目→真实成片→两条混剪→ZIP导出→技术拆解与版本恢复", async () => {
    const asset = await imageAsset();
    const project = (
      await call("POST", "/projects", { name: "端到端验收" })
    ).json();
    const response = await call("POST", "/jobs", {
      toolId: "slideshow",
      projectId: project.id,
      input: { sourceIds: [asset.id], duration: 3, resolution: "480p" },
      idempotencyKey: uid(),
    });
    expect(response.statusCode, response.body).toBe(200);
    await processOne(fixture.store);
    const completed = (
      await call("GET", `/jobs/${response.json().items[0].id}`)
    ).json() as Job;
    expect(completed.status, JSON.stringify(completed)).toBe("succeeded");
    expect(completed.outputs).toHaveLength(1);
    expect(
      (await call("GET", `/assets?projectId=${project.id}`)).json().total,
    ).toBe(1);
    const video = (
      await call("GET", completed.outputs[0].url.replace("/api", ""))
    ).rawPayload;
    const clips: Asset[] = [];
    for (let i = 0; i < 6; i++) {
      const uploaded = await upload(video, `clip-${i}.mp4`);
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      clips.push(uploaded.json().items[0]);
    }
    for (const input of [
      { sourceIds: clips.map((c) => c.id), count: 0 },
      { sourceIds: clips.map((c) => c.id), count: 101 },
      { sourceIds: clips.slice(0, 5).map((c) => c.id), count: 1 },
      { sourceIds: Array.from({ length: 101 }, () => uid()), count: 1 },
    ]) {
      const rejected = await call("POST", "/jobs", {
        toolId: "remix",
        input: { ...input, subtitles: false },
        idempotencyKey: uid(),
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
    }
    const batch = (
      await call("POST", "/jobs", {
        toolId: "remix",
        input: {
          sourceIds: clips.map((c) => c.id),
          productName: "实际测试",
          description: "本地剪辑",
          sellingPoints: "真实媒体输出",
          resolution: "480p",
          duration: "15",
          count: 2,
          subtitles: false,
        },
        idempotencyKey: uid(),
      })
    ).json();
    expect(batch.items).toHaveLength(2);
    for (const queued of batch.items) {
      await processOne(fixture.store);
      const job = (await call("GET", `/jobs/${queued.id}`)).json() as Job;
      expect(job.status, JSON.stringify(job)).toBe("succeeded");
      const row = fixture.store.get(
        "SELECT storage_key FROM assets WHERE id=?",
        job.outputs[0].id,
      )!;
      const probe = await probeMedia(
        fixture.store.storage.path(String(row.storage_key)),
      );
      expect(probe.duration).toBeGreaterThan(14.8);
      expect(probe.height).toBeGreaterThan(probe.width!);
      const archive = await call("GET", `/jobs/${job.id}/download`);
      expect(archive.statusCode).toBe(200);
      expect(archive.rawPayload.subarray(0, 2).toString()).toBe("PK");
    }
    const summary = (await call("GET", `/batches/${batch.batchId}`)).json();
    expect(summary.total).toBe(2);
    expect(summary.counts.succeeded).toBe(2);
    expect(summary.outputCount).toBe(2);
    const batchZip = await call("GET", `/batches/${batch.batchId}/download`);
    expect(batchZip.statusCode).toBe(200);
    expect(batchZip.rawPayload.includes(Buffer.from("batch-status.json"))).toBe(
      true,
    );
    const analysis = (
      await call("POST", "/analyses", {
        assetId: clips[0].id,
        mode: "technical",
      })
    ).json();
    await processOne(fixture.store);
    const view = (await call("GET", `/analyses/${analysis.id}`)).json();
    expect(view.versions[0].jobs[0].status).toBe("succeeded");
    expect(
      (await call("POST", `/analyses/${analysis.id}/retry`, {})).statusCode,
    ).toBe(200);
    expect(
      (await call("GET", `/analyses/${analysis.id}`)).json().versions,
    ).toHaveLength(2);
    expect((await readFile(join(directory, "master.key"))).length).toBe(32);
  }, 120000);
});

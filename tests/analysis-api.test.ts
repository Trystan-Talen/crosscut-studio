import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { now, uid, passwordHash } from "../src/server/core.js";
import type { JobStatus } from "../src/shared/types.js";
let fixture: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let cookie: string;
let owner: string;
beforeEach(async () => {
  await mkdir(resolve("data/test-runs"), { recursive: true });
  directory = await mkdtemp(resolve("data/test-runs/analysis-list-"));
  fixture = await createApp({ dataDir: directory, serveStatic: false });
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: {
      email: "history@example.test",
      name: "历史验收",
      password: "Synthetic-analysis-history-42",
    },
  });
  cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  owner = response.json().user.id;
});
afterEach(async () => {
  await fixture.app.close();
  await rm(directory, { recursive: true, force: true });
});
async function list(query = "") {
  return fixture.app.inject({
    url: `/api/analyses${query}`,
    headers: { cookie },
  });
}
function seed(
  name: string,
  statuses: JobStatus[],
  source: string,
  created: string,
  user = owner,
) {
  const id = uid(),
    asset = uid(),
    version = uid(),
    batch = uid();
  fixture.store.run(
    "INSERT INTO assets(id,owner_id,name,kind,mime,size,duration,width,height,storage_key,source,sha256,created_at) VALUES(?,?,?,'video','video/mp4',1,15,480,854,?,?,'synthetic',?)",
    asset,
    user,
    name,
    `${asset}.mp4`,
    source,
    created,
  );
  fixture.store.run(
    "INSERT INTO analyses VALUES(?,?,?,?)",
    id,
    user,
    asset,
    created,
  );
  fixture.store.run(
    "INSERT INTO analysis_versions VALUES(?,?,1,'',?)",
    version,
    id,
    created,
  );
  fixture.store.run(
    "INSERT INTO batches VALUES(?,?,?,?,?)",
    batch,
    user,
    uid(),
    uid(),
    created,
  );
  statuses.forEach((status, i) => {
    const job = uid(),
      section =
        statuses.length === 1
          ? "technical"
          : ["timeline", "mechanism", "prompt"][i];
    fixture.store.run(
      "INSERT INTO jobs(id,batch_id,owner_id,tool_id,title,input,status,created_at,updated_at) VALUES(?,?,?,?,?,'{}',?,?,?)",
      job,
      batch,
      user,
      section === "technical" ? "scene-detect" : `analysis-${section}`,
      name,
      status,
      created,
      created,
    );
    fixture.store.run(
      "INSERT INTO analysis_jobs VALUES(?,?,?)",
      version,
      section,
      job,
    );
  });
  return id;
}
describe("拆解摘要检索与权限", () => {
  it("聚合最新版本真实状态，分页返回摘要而非完整产物，隔离其他用户", async () => {
    const a = seed(
      "精华广告",
      ["succeeded", "failed", "succeeded"],
      "generated",
      "2026-10-14T07:00:00.000Z",
    );
    seed("原创镜头", ["succeeded"], "demo", "2026-10-13T07:00:00.000Z");
    const stranger = uid();
    fixture.store.run(
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
      stranger,
      "other-history@example.test",
      "隔离账号",
      passwordHash("Synthetic-other-history-42"),
      now(),
    );
    seed(
      "别人精华广告",
      ["succeeded"],
      "upload",
      "2026-10-15T07:00:00.000Z",
      stranger,
    );
    const response = await list("?limit=1");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().total).toBe(2);
    expect(response.json().items[0]).toMatchObject({
      id: a,
      assetName: "精华广告",
      status: "partial",
      completed: 2,
      taskCount: 3,
      mode: "semantic",
      version: 1,
    });
    expect(response.json().items[0]).not.toHaveProperty("versions");
    expect((await list("?limit=1&offset=1")).json().items[0].assetName).toBe(
      "原创镜头",
    );
    expect((await list("?order=oldest")).json().items[0].assetName).toBe(
      "原创镜头",
    );
    // A newer version must control the summary, rather than old partial results.
    const v2 = uid();
    fixture.store.run(
      "INSERT INTO analysis_versions VALUES(?,?,2,'',?)",
      v2,
      a,
      now(),
    );
    const completed = fixture.store.get(
      "SELECT j.id FROM jobs j JOIN analysis_jobs aj ON aj.job_id=j.id JOIN analysis_versions v ON v.id=aj.version_id WHERE v.analysis_id=? AND j.status='succeeded' LIMIT 1",
      a,
    )!;
    fixture.store.run(
      "INSERT INTO analysis_jobs VALUES(?,'timeline',?)",
      v2,
      completed.id,
    );
    expect((await list(`?search=${a}`)).json().items[0]).toMatchObject({
      version: 2,
      status: "succeeded",
      taskCount: 1,
    });
  });
  it("组合搜索、来源、方式、状态和本地日期对应UTC范围；非法查询拒绝", async () => {
    seed(
      "精华广告",
      ["succeeded", "failed", "succeeded"],
      "generated",
      "2026-10-14T07:00:00.000Z",
    );
    seed("镜头", ["queued"], "upload", "2026-10-14T06:59:59.000Z");
    const query = new URLSearchParams({
      search: "精华",
      source: "generated",
      mode: "semantic",
      status: "partial",
      from: "2026-10-14T00:00:00-07:00",
      before: "2026-10-15T00:00:00-07:00",
    });
    expect((await list(`?${query}`)).json().total).toBe(1);
    expect((await list("?status=running")).json().total).toBe(0);
    expect(
      (await list("?from=2026-10-15T00:00:00Z&before=2026-10-14T00:00:00Z"))
        .statusCode,
    ).toBe(400);
    expect((await list("?from=invalid")).statusCode).toBe(400);
    expect((await list("?limit=101")).statusCode).toBe(400);
    expect((await list("?status=unknown")).statusCode).toBe(400);
  });
});

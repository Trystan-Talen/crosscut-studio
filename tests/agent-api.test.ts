import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { hash, now, passwordHash, uid } from "../src/server/core.js";
import * as core from "../src/server/core.js";
import { processOne } from "../src/server/worker.js";
import * as providers from "../src/server/providers.js";
import type { Conversation, Job } from "../src/shared/types.js";

const exec = promisify(execFile);
let fixture: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let mediaDir: string;
let videoBytes: Buffer;
let cookie: string;
async function api(
  method: "GET" | "POST" | "PATCH",
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
async function config(kind: "openai" | "ark", capabilities: string[]) {
  return (
    await api("POST", "/providers", {
      kind,
      name: "Agent API fixture",
      baseUrl: "https://fixture.example.test",
      model:
        kind === "ark" ? "doubao-seedance-2-0-260128" : "fixture-chat-model",
      capabilities,
      apiKey: "synthetic-fixture-key",
    })
  ).json().id as string;
}
async function conversation(): Promise<string> {
  return (await api("POST", "/conversations", {})).json().id;
}
async function detail(id: string): Promise<Conversation> {
  return (await api("GET", `/conversations/${id}`)).json();
}
const creation = (providerId: string, key = uid()) => ({
  toolId: "video-studio",
  providerId,
  idempotencyKey: key,
  input: {
    mode: "text",
    prompt: "A cup on a table",
    count: 2,
    duration: 5,
    ratio: "9:16",
  },
});
beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "crosscut-agent-media-"));
  const path = join(mediaDir, "actual.mp4");
  await exec("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=teal:s=64x64:d=0.3:r=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    path,
  ]);
  videoBytes = await readFile(path);
});
afterAll(async () => {
  await rm(mediaDir, { recursive: true, force: true });
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "crosscut-agent-api-"));
  fixture = await createApp({ dataDir: directory, serveStatic: false });
  const setup = await api(
    "POST",
    "/auth/setup",
    {
      email: "agent@example.test",
      name: "Agent QA",
      password: "Synthetic-test-password-42",
    },
    "",
  );
  cookie = setup.cookies
    .map((value) => `${value.name}=${value.value}`)
    .join("; ");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.app.close();
  await rm(directory, { recursive: true, force: true });
});

describe("Agent API and durable conversation results", () => {
  it("replays a chat submission without another user message and rejects changed input for the same key", async () => {
    const providerId = await config("openai", ["chat"]),
      id = await conversation(),
      key = uid();
    const body = {
      content: "Write a concrete opening",
      providerId,
      idempotencyKey: key,
    };
    const first = await api("POST", `/conversations/${id}/messages`, body);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await api("POST", `/conversations/${id}/messages`, body);
    expect(replay.json().id).toBe(first.json().id);
    const changed = await api("POST", `/conversations/${id}/messages`, {
      ...body,
      content: "Different creative",
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const busy = await api("POST", `/conversations/${id}/messages`, {
      ...body,
      idempotencyKey: uid(),
    });
    expect(busy.json().error.code).toBe("CONVERSATION_BUSY");
    const pending = await detail(id);
    expect(pending.messages).toHaveLength(1);
    expect(pending.jobs).toHaveLength(1);
    vi.spyOn(providers, "runProvider").mockResolvedValue({
      artifacts: [],
      result: { text: "Start with the cup beside the laptop." },
    });
    await processOne(fixture.store);
    const finished = await detail(id);
    expect(finished.messages?.at(-1)).toMatchObject({
      role: "assistant",
      jobId: first.json().id,
      content: "Start with the cup beside the laptop.",
    });
    expect(
      (await api("POST", `/conversations/${id}/messages`, body)).json().id,
    ).toBe(first.json().id);
    expect((await detail(id)).messages).toHaveLength(2);
  });
  it("namespaces the same submission key per conversation and per chat/creation operation", async () => {
    const chatId = await config("openai", ["chat"]),
      videoId = await config("ark", ["video.task"]);
    const a = await conversation(),
      b = await conversation(),
      key = uid();
    const chat = { content: "Draft", providerId: chatId, idempotencyKey: key };
    const first = await api("POST", `/conversations/${a}/messages`, chat);
    const second = await api("POST", `/conversations/${b}/messages`, chat);
    expect(second.json().id).not.toBe(first.json().id);
    const media = await api(
      "POST",
      `/conversations/${a}/creations`,
      creation(videoId, key),
    );
    expect(media.statusCode, media.body).toBe(200);
    expect(media.json().items).toHaveLength(2);
    expect((await detail(a)).jobs).toHaveLength(3);
    expect((await detail(b)).jobs).toHaveLength(1);
    const c = await conversation();
    await api("POST", `/conversations/${c}/creations`, creation(videoId, key));
    expect(
      (await api("POST", `/conversations/${c}/messages`, chat)).statusCode,
    ).toBe(200);
  });
  it("rejects other owners, deleted conversations, missing providers and unsupported tools without new jobs", async () => {
    const id = await conversation();
    const user = uid(),
      token = uid();
    fixture.store.run(
      "INSERT INTO users VALUES(?,?,?,?,?,?)",
      user,
      "other@example.test",
      "Other",
      passwordHash("Synthetic-pass-42"),
      "{}",
      now(),
    );
    fixture.store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      user,
      "2099-01-01T00:00:00Z",
    );
    const other = `crosscut_session=${token}`;
    const payload = {
      toolId: "video-studio",
      input: { prompt: "cup" },
      idempotencyKey: uid(),
    };
    expect(
      (await api("GET", `/conversations/${id}`, undefined, other)).statusCode,
    ).toBe(404);
    expect(
      (
        await api(
          "POST",
          `/conversations/${id}/messages`,
          { content: "foreign" },
          other,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await api("POST", `/conversations/${id}/creations`, payload, other))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api("POST", `/conversations/${id}/messages`, {
          content: "missing provider",
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (await api("POST", `/conversations/${id}/creations`, payload)).statusCode,
    ).toBe(503);
    expect(
      (
        await api("POST", `/conversations/${id}/creations`, {
          ...payload,
          toolId: "agent-chat",
        })
      ).statusCode,
    ).toBe(400);
    await api("PATCH", `/conversations/${id}`, { deleted: true });
    expect(
      (
        await api("POST", `/conversations/${id}/messages`, {
          content: "deleted",
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (await api("POST", `/conversations/${id}/creations`, payload)).statusCode,
    ).toBe(410);
    expect(fixture.store.get("SELECT count(*) n FROM jobs")?.n).toBe(0);
    expect((await detail(id)).messages).toEqual([]);
  });
  it("links both media children to real playable files and replays creation without duplicate messages", async () => {
    const providerId = await config("ark", ["video.task"]),
      id = await conversation(),
      body = creation(providerId);
    const originalUid = uid,
      batchId = uid();
    vi.spyOn(core, "uid")
      .mockImplementation(originalUid)
      .mockReturnValueOnce(batchId)
      .mockReturnValueOnce("ffffffff-ffff-4fff-8fff-ffffffffffff")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000000");
    const response = await api("POST", `/conversations/${id}/creations`, body);
    expect(response.statusCode, response.body).toBe(200);
    const jobs = response.json().items as Job[];
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.id)).toEqual([
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(jobs.every((job) => job.input.conversationId === id)).toBe(true);
    const remote = vi
      .spyOn(providers, "runProvider")
      .mockImplementation(async (ctx) => {
        const path = join(ctx.outputDir, "real-output.mp4");
        await writeFile(path, videoBytes);
        return {
          artifacts: [
            { path, name: "真实验收.mp4", kind: "video", mime: "video/mp4" },
          ],
        };
      });
    await processOne(fixture.store);
    await processOne(fixture.store);
    expect(await processOne(fixture.store)).toBe(false);
    const completed = await detail(id);
    expect(completed.jobs?.map((job) => job.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(
      completed.messages
        ?.filter((m) => m.role === "assistant")
        .map((m) => m.jobId)
        .sort(),
    ).toEqual(jobs.map((j) => j.id).sort());
    for (const job of completed.jobs ?? []) {
      expect(job.outputs).toHaveLength(1);
      expect(job.outputs[0].kind).toBe("video");
      expect(job.outputs[0].duration).toBeGreaterThan(0);
      const file = await api("GET", `/assets/${job.outputs[0].id}/file`);
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload).toEqual(videoBytes);
    }
    const replay = (
      await api("POST", `/conversations/${id}/creations`, body)
    ).json();
    expect(replay.batchId).toBe(response.json().batchId);
    expect(replay.items.map((job: Job) => job.id)).toEqual(
      jobs.map((job) => job.id),
    );
    expect((await detail(id)).messages).toHaveLength(3);
    const changed = await api("POST", `/conversations/${id}/creations`, {
      ...body,
      input: { ...body.input, prompt: "Different paid request" },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await detail(id)).messages).toHaveLength(3);
    expect(remote).toHaveBeenCalledTimes(2);
  });
  it("rolls back a creation batch when inserting its conversation message fails", async () => {
    const providerId = await config("ark", ["video.task"]),
      id = await conversation();
    const original = fixture.store.run.bind(fixture.store);
    vi.spyOn(fixture.store, "run").mockImplementation((sql, ...values) => {
      if (sql.startsWith("INSERT INTO messages"))
        throw new Error("Synthetic conversation insert failure");
      return original(sql, ...values);
    });
    expect(
      (
        await api(
          "POST",
          `/conversations/${id}/creations`,
          creation(providerId),
        )
      ).statusCode,
    ).toBe(500);
    expect(fixture.store.get("SELECT count(*) n FROM jobs")?.n).toBe(0);
    expect(fixture.store.get("SELECT count(*) n FROM batches")?.n).toBe(0);
    expect((await detail(id)).messages).toEqual([]);
  });
  it("rolls back output associations and messages together when worker conversation commit fails", async () => {
    const providerId = await config("ark", ["video.task"]),
      id = await conversation();
    const response = await api("POST", `/conversations/${id}/creations`, {
      ...creation(providerId),
      input: { prompt: "cup", count: 1 },
    });
    const job = response.json().items[0];
    vi.spyOn(providers, "runProvider").mockImplementation(async (ctx) => {
      const path = join(ctx.outputDir, "real.mp4");
      await writeFile(path, videoBytes);
      return {
        artifacts: [
          { path, name: "real.mp4", kind: "video", mime: "video/mp4" },
        ],
      };
    });
    const original = fixture.store.run.bind(fixture.store);
    vi.spyOn(fixture.store, "run").mockImplementation((sql, ...values) => {
      if (sql.includes("INSERT INTO messages") && sql.includes("'assistant'"))
        throw new Error("Synthetic assistant commit failure");
      return original(sql, ...values);
    });
    await processOne(fixture.store);
    const current = (await api("GET", `/jobs/${job.id}`)).json();
    expect(current.status).toBe("needs_review");
    expect(current.outputs).toEqual([]);
    expect((await detail(id)).messages).toHaveLength(1);
    expect(fixture.store.get("SELECT count(*) n FROM usage_events")?.n).toBe(0);
    expect(await readdir(fixture.store.storage.media)).toEqual([]);
  });
  it.each(["messages", "creations"] as const)(
    "rechecks conversation deletion under the %s write transaction",
    async (operation) => {
      const providerId = await config(
        operation === "messages" ? "openai" : "ark",
        [operation === "messages" ? "chat" : "video.task"],
      );
      const id = await conversation();
      const original = fixture.store.db.transaction.bind(fixture.store.db);
      let injected = false;
      vi.spyOn(fixture.store.db, "transaction").mockImplementation((fn) => {
        if (!injected) {
          injected = true;
          fixture.store.run(
            "UPDATE conversations SET deleted_at=? WHERE id=?",
            now(),
            id,
          );
        }
        return original(fn);
      });
      const payload =
        operation === "messages"
          ? {
              providerId,
              content: "after concurrent deletion",
              idempotencyKey: uid(),
            }
          : creation(providerId);
      const response = await api(
        "POST",
        `/conversations/${id}/${operation}`,
        payload,
      );
      expect(injected).toBe(true);
      expect(response.statusCode).toBe(410);
      expect(fixture.store.get("SELECT count(*) n FROM jobs")?.n).toBe(0);
    },
  );
  it.each(["title", "deleted"] as const)(
    "does not overwrite another field when patching %s concurrently",
    async (field) => {
      const id = await conversation();
      const original = fixture.store.run.bind(fixture.store);
      let injected = false;
      vi.spyOn(fixture.store, "run").mockImplementation((sql, ...values) => {
        if (!injected && sql.startsWith("UPDATE conversations SET title=")) {
          injected = true;
          if (field === "title")
            original(
              "UPDATE conversations SET deleted_at=? WHERE id=?",
              now(),
              id,
            );
          else
            original(
              "UPDATE conversations SET title=? WHERE id=?",
              "Concurrent renamed title",
              id,
            );
        }
        return original(sql, ...values);
      });
      const response = await api(
        "PATCH",
        `/conversations/${id}`,
        field === "title"
          ? { title: "Requested new title" }
          : { deleted: true },
      );
      expect(response.statusCode).toBe(200);
      expect(injected).toBe(true);
      const saved = fixture.store.get(
        "SELECT title,deleted_at FROM conversations WHERE id=?",
        id,
      )!;
      expect(saved.deleted_at).toBeTruthy();
      expect(saved.title).toBe(
        field === "title" ? "Requested new title" : "Concurrent renamed title",
      );
    },
  );
});

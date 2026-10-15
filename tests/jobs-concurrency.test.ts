import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/server/db.js";
import { now, uid } from "../src/server/core.js";

const exec = promisify(execFile);
let directory: string;
let store: Store;
let owner: string;
let providerId: string;
let childPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "crosscut-job-race-"));
  store = new Store(directory);
  owner = uid();
  providerId = uid();
  store.run(
    "INSERT INTO users VALUES(?,?,?,?,?,?)",
    owner,
    "race@example.test",
    "Concurrency fixture",
    "unused",
    "{}",
    now(),
  );
  store.run(
    "INSERT INTO providers(id,owner_id,name,kind,config,secret,updated_at) VALUES(?,?,?,?,?,?,?)",
    providerId,
    owner,
    "Offline concurrency fixture",
    "openai",
    JSON.stringify({
      baseUrl: "https://fixture.example.test",
      model: "fixture-chat",
      models: {},
      capabilities: ["chat"],
      voices: [],
      avatars: [],
    }),
    store.storage.encrypt("synthetic-fixture-key"),
    now(),
  );
  childPath = join(directory, "submit.mjs");
  await writeFile(
    childPath,
    `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [directory, name, mode, root, owner, payload] = process.argv.slice(2);
const { Store } = await import(pathToFileURL(join(root,"src/server/db.ts")));
const { createJobs } = await import(pathToFileURL(join(root,"src/server/jobs.ts")));
const store = new Store(directory);
const other = name === "a" ? "b" : "a";
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (file, ms) => { const until = Date.now()+ms; while(!existsSync(file) && Date.now()<until) Atomics.wait(pause,0,0,10); };
// Both databases finish migration before either request starts.
writeFileSync(join(directory,name+".ready"),"");
waitFor(join(directory,other+".ready"),5000);
const original = store.get.bind(store);
let synchronized = false;
store.get = (sql,...values) => {
  const result = original(sql,...values);
  const boundary = mode === "key"
    ? sql.startsWith("SELECT * FROM batches WHERE owner_id=") && !result
    : sql.startsWith("SELECT count(*) n FROM jobs WHERE owner_id=") && result?.n === 199;
  if(boundary && !synchronized) {
    synchronized = true;
    writeFileSync(join(directory,name+".read"),"");
    // Without a transaction both old reads reach this barrier. With IMMEDIATE,
    // the second process waits for the first commit and then sees current state.
    waitFor(join(directory,other+".read"),500);
  }
  return result;
};
try { const result=createJobs(store,owner,JSON.parse(payload)); console.log(JSON.stringify({id:result.items[0].id,batchId:result.batchId})); }
catch(error) { console.log(JSON.stringify({errorCode:error.code,message:error.message})); }
finally { store.close(); }
`,
  );
});
afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});
async function concurrently(mode: "key" | "queue", keys: string[]) {
  return Promise.all(
    keys.map(async (key, index) => {
      const payload = {
        toolId: "agent-chat",
        providerId,
        input: { text: "Concurrent fixture" },
        idempotencyKey: key,
      };
      const result = await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          childPath,
          directory,
          index ? "b" : "a",
          mode,
          resolve("."),
          owner,
          JSON.stringify(payload),
        ],
        { cwd: resolve("."), timeout: 10000 },
      );
      return JSON.parse(result.stdout.trim()) as {
        id?: string;
        batchId?: string;
        errorCode?: string;
        message?: string;
      };
    }),
  );
}
describe("SQLite job submission across API processes", () => {
  it("returns one durable job for concurrent identical idempotency keys", async () => {
    const key = uid();
    const results = await concurrently("key", [key, key]);
    expect(
      results.every((result) => !result.errorCode),
      JSON.stringify(results),
    ).toBe(true);
    expect(results[0].id).toBeTruthy();
    expect(results[0].id).toBe(results[1].id);
    expect(store.get("SELECT count(*) n FROM jobs")?.n).toBe(1);
    expect(store.get("SELECT count(*) n FROM batches")?.n).toBe(1);
  }, 15000);
  it("keeps the 200-job queue limit when two processes submit at 199", async () => {
    const batch = uid(),
      date = now();
    store.db
      .transaction(() => {
        store.run(
          "INSERT INTO batches VALUES(?,?,?,?,?)",
          batch,
          owner,
          uid(),
          "seed-fixture",
          date,
        );
        for (let i = 0; i < 199; i++)
          store.run(
            "INSERT INTO jobs(id,batch_id,owner_id,tool_id,title,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)",
            uid(),
            batch,
            owner,
            "agent-chat",
            "Existing fixture",
            "{}",
            date,
            date,
          );
      })
      .immediate();
    const results = await concurrently("queue", [uid(), uid()]);
    expect(results.filter((result) => result.id)).toHaveLength(1);
    expect(results.find((result) => result.errorCode)?.errorCode).toBe(
      "QUEUE_LIMIT",
    );
    expect(
      store.get("SELECT count(*) n FROM jobs WHERE status='queued'")?.n,
    ).toBe(200);
  }, 15000);
});

import "./runtime-env.js";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type Row } from "./db.js";
import { uid, now, parseJson } from "./core.js";
import { event, recoverJobs, decodeProvider } from "./jobs.js";
import { saveAsset, executionAsset } from "./assets.js";
import { providerSecret } from "./models.js";
import { requiredCapability } from "../shared/catalog.js";
import { runMediaTask } from "./media.js";
import { runProvider } from "./providers.js";
import type { Asset, ExecutionContext, ToolInput } from "../shared/types.js";
const activeControllers = new Set<AbortController>();
let shuttingDown = false;
export function claimJob(store: Store): Row | undefined {
  return store.db
    .transaction(() => {
      const row = store.get(
        "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
      );
      if (!row) return;
      const lease = uid();
      store.run(
        "UPDATE jobs SET status='running',lease_token=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE id=? AND status='queued'",
        lease,
        new Date(Date.now() + 45000).toISOString(),
        now(),
        row.id,
      );
      return store.get("SELECT * FROM jobs WHERE id=?", row.id);
    })
    .immediate();
}
export async function processOne(store: Store): Promise<boolean> {
  recoverJobs(store);
  const row = claimJob(store);
  if (!row) return false;
  const id = String(row.id),
    lease = String(row.lease_token);
  const dir = join(store.storage.temp, id + "-" + lease);
  await mkdir(dir, { recursive: true });
  const controller = new AbortController();
  activeControllers.add(controller);
  let provider: ExecutionContext["provider"];
  let outputs: Asset[] = [];
  let committed = false;
  let providerCompleted = false;
  const isCurrent = () =>
    store.get(
      "SELECT * FROM jobs WHERE id=? AND lease_token=? AND status='running'",
      id,
      lease,
    );
  const heartbeat = setInterval(() => {
    try {
      const current = isCurrent();
      if (!current) {
        controller.abort();
        return;
      }
      store.run(
        "UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=?",
        new Date(Date.now() + 45000).toISOString(),
        id,
        lease,
      );
      if (current.cancel_requested && !provider) controller.abort();
    } catch {
      controller.abort();
    }
  }, 1000);
  heartbeat.unref();
  const input = parseJson<ToolInput>(row.input, {});
  try {
    provider = decodeProvider(store, row);
    const assets = store
      .all(
        "SELECT a.* FROM assets a JOIN job_assets ja ON ja.asset_id=a.id WHERE ja.job_id=? AND ja.role='input'",
        id,
      )
      .map((a) => executionAsset(store, a));
    const ctx: ExecutionContext = {
      jobId: id,
      toolId: String(row.tool_id),
      input,
      assets,
      outputDir: dir,
      signal: controller.signal,
      provider,
      remoteTaskId: row.remote_task_id ? String(row.remote_task_id) : undefined,
      isCancellationRequested: () => !!isCurrent()?.cancel_requested,
      onProgress: (progress, message) => {
        if (!isCurrent()) return;
        store.run(
          "UPDATE jobs SET progress=?,updated_at=? WHERE id=? AND lease_token=?",
          Math.max(0, Math.min(99, progress)),
          now(),
          id,
          lease,
        );
        if (message) event(store, id, message);
      },
      onRemoteTask: (remoteId, metadata) => {
        if (!isCurrent()) throw new Error("任务租约失效");
        store.run(
          "UPDATE jobs SET remote_task_id=?,remote_metadata=?,updated_at=? WHERE id=? AND lease_token=?",
          remoteId,
          JSON.stringify(metadata ?? {}),
          now(),
          id,
          lease,
        );
        event(store, id, "服务商流程检查点已保存");
      },
    };
    if (row.cancel_requested && !row.remote_task_id)
      throw Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
    event(
      store,
      id,
      provider ? "正在连接已配置的服务商" : "正在执行本地媒体处理",
    );
    if (provider && !row.remote_task_id) {
      const started = store.run(
        "UPDATE jobs SET submission_started=1 WHERE id=? AND lease_token=? AND status='running' AND cancel_requested=0",
        id,
        lease,
      );
      if (!started.changes) {
        if (isCurrent()?.cancel_requested)
          throw Object.assign(new Error("任务在外部提交前已取消"), {
            code: "CANCELLED",
          });
        throw new Error("任务租约失效");
      }
    }
    const result = provider ? await runProvider(ctx) : await runMediaTask(ctx);
    providerCompleted = !!provider;
    if (!isCurrent()) throw new Error("任务租约失效");
    if (
      controller.signal.aborted ||
      (!provider && isCurrent()?.cancel_requested)
    )
      throw Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
    if (!result.artifacts.length && result.result === undefined)
      throw new Error("任务没有返回可验证的产物");
    for (const artifact of result.artifacts) {
      if (!isCurrent() || controller.signal.aborted)
        throw Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
      outputs.push(
        await saveAsset(store, String(row.owner_id), artifact.path, {
          name: artifact.name,
          source: "generated",
          metadata: { ...artifact.metadata, jobId: id, toolId: row.tool_id },
          allowDocument: true,
          signal: controller.signal,
        }),
      );
    }
    store.db
      .transaction(() => {
        const current = isCurrent();
        if (!current) throw new Error("任务租约失效");
        if (!provider && current.cancel_requested)
          throw Object.assign(new Error("任务已取消"), { code: "CANCELLED" });
        for (const a of outputs) {
          store.run("INSERT INTO job_assets VALUES(?,?,'output')", id, a.id);
          if (row.project_id)
            store.run(
              "INSERT OR IGNORE INTO project_assets VALUES(?,?)",
              row.project_id,
              a.id,
            );
        }
        store.run(
          "UPDATE jobs SET status='succeeded',progress=100,result=?,lease_token=NULL,lease_until=NULL,error=NULL,error_code=NULL,updated_at=? WHERE id=? AND lease_token=?",
          JSON.stringify(result.result ?? null),
          now(),
          id,
          lease,
        );
        if (provider) {
          store.run(
            "INSERT INTO usage_events VALUES(?,?,?,?,?,?)",
            uid(),
            row.owner_id,
            id,
            provider.name,
            JSON.stringify(result.usage ?? { completed: true }),
            now(),
          );
          const currentProvider = store.get(
            "SELECT * FROM providers WHERE id=? AND owner_id=?",
            provider.id,
            row.owner_id,
          );
          if (
            currentProvider &&
            JSON.stringify(providerSecret(store, currentProvider)) ===
              JSON.stringify(provider)
          ) {
            const config = parseJson<Record<string, unknown>>(
              currentProvider.config,
              {},
            );
            const verified = Array.isArray(config.verifiedCapabilities)
              ? (config.verifiedCapabilities as string[])
              : [];
            store.run(
              "UPDATE providers SET verified=1,config=? WHERE id=? AND owner_id=?",
              JSON.stringify({
                ...config,
                verifiedCapabilities: [
                  ...new Set([
                    ...verified,
                    requiredCapability(String(row.tool_id), input),
                  ]),
                ],
              }),
              provider.id,
              row.owner_id,
            );
          }
        }
        if (input.conversationId) {
          const content =
            String(row.tool_id) !== "agent-chat"
              ? `创作任务“${String(row.title)}”已完成，${outputs.length}份真实产物已保存。可打开关联任务预览或下载。`
              : typeof result.result === "object" &&
                  result.result &&
                  "text" in result.result
                ? String(result.result.text)
                : JSON.stringify(result.result ?? "");
          store.run(
            "INSERT INTO messages VALUES(?,?,'assistant',?,?,?)",
            uid(),
            input.conversationId,
            content,
            id,
            now(),
          );
          store.run(
            "UPDATE conversations SET updated_at=? WHERE id=?",
            now(),
            input.conversationId,
          );
        }
        if (
          String(row.tool_id) === "analysis-prompt" &&
          result.result &&
          typeof result.result === "object" &&
          "prompt" in result.result
        )
          store.run(
            "UPDATE analysis_versions SET prompt=? WHERE id IN(SELECT version_id FROM analysis_jobs WHERE job_id=?) AND prompt=?",
            String(result.result.prompt),
            id,
            String(input.analysisPromptBaseline ?? ""),
          );
        event(store, id, "任务完成，产物已验证并保存");
      })
      .immediate();
    committed = true;
  } catch (error) {
    const e = error as Error & { code?: string };
    const current = isCurrent();
    if (current) {
      const resultCommitFailed = !!(
        providerCompleted && !current.remote_task_id
      );
      const cancelled = !!(
        !resultCommitFailed &&
        !shuttingDown &&
        ((!provider &&
          (controller.signal.aborted || current.cancel_requested)) ||
          e.code === "CANCELLED" ||
          e.code === "REMOTE_CANCELLED")
      );
      const review =
        resultCommitFailed ||
        e.code === "RESULT_PROCESSING_FAILED" ||
        e.code === "SUBMISSION_UNKNOWN" ||
        e.code === "submission_unknown" ||
        !!(
          shuttingDown &&
          provider &&
          current.submission_started &&
          !current.remote_task_id
        );
      const pending =
        !review && !cancelled && (shuttingDown || e.code === "REMOTE_PENDING");
      const code = cancelled
        ? "CANCELLED"
        : review
          ? resultCommitFailed
            ? "RESULT_COMMIT_FAILED"
            : e.code === "RESULT_PROCESSING_FAILED"
              ? e.code
              : "SUBMISSION_UNKNOWN"
          : (e.code ?? "PROCESSING_FAILED");
      let message = cancelled
        ? "任务已取消"
        : pending
          ? "任务已保存，等待恢复处理"
          : review
            ? resultCommitFailed
              ? "服务商已返回结果，但本地保存未完成；请核对产物和服务商记录，避免重复计费"
              : e.code === "RESULT_PROCESSING_FAILED"
                ? "服务商已返回成功响应，但产物下载、校验或本地处理未完成；请先核对服务商记录，避免重复计费"
                : "外部提交结果不明，请先核对服务商记录，避免重复计费"
            : String(e.message || "处理失败");
      if (provider?.apiKey)
        message = message.split(provider.apiKey).join("[已隐藏]");
      message = message
        .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
        .replace(/data:[^\s]+/g, "[媒体数据]");
      const updated = store.run(
        "UPDATE jobs SET status=?,error_code=?,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?",
        cancelled
          ? "cancelled"
          : review
            ? "needs_review"
            : pending
              ? "queued"
              : "failed",
        pending ? null : code,
        pending ? null : message.slice(0, 1200),
        now(),
        id,
        lease,
      );
      if (updated.changes) event(store, id, message);
    }
  } finally {
    clearInterval(heartbeat);
    activeControllers.delete(controller);
    if (!committed) {
      for (const output of outputs) {
        const saved = store.get(
          "SELECT storage_key,thumbnail_key FROM assets WHERE id=?",
          output.id,
        );
        store.run(
          "DELETE FROM assets WHERE id=? AND NOT EXISTS(SELECT 1 FROM job_assets WHERE asset_id=?)",
          output.id,
          output.id,
        );
        if (
          saved &&
          !store.get("SELECT id FROM assets WHERE id=?", output.id)
        ) {
          for (const key of [saved.storage_key, saved.thumbnail_key])
            if (key)
              await rm(store.storage.path(String(key)), { force: true }).catch(
                () => {},
              );
        }
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}
export async function workerMain() {
  const store = new Store(resolve(process.env.CROSSCUT_DATA_DIR ?? "data"));
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      shuttingDown = true;
      for (const c of activeControllers) c.abort();
    });
  const heartbeat = setInterval(
    () =>
      store.run(
        "INSERT INTO runtime(key,value,updated_at) VALUES('worker',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        String(process.pid),
        now(),
      ),
    5000,
  );
  heartbeat.unref();
  while (!shuttingDown) {
    try {
      const worked = await processOne(store);
      if (!worked) await new Promise((r) => setTimeout(r, 750));
    } catch (e) {
      console.error("Worker error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  clearInterval(heartbeat);
  store.close();
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  workerMain().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });

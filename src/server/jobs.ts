import { z, ZodError } from "zod";
import {
  TOOLS,
  findTool,
  validateInput,
  requiredCapability,
  selectedAssetIds,
} from "../shared/catalog.js";
import type { ToolInput, ProviderConfig, Job } from "../shared/types.js";
import { Store, type Row } from "./db.js";
import { AppError, hash, now, uid, parseJson } from "./core.js";
import { owned, jobView, providerSecret, providerView } from "./models.js";
import { ProviderError, validateProviderSelections } from "./providers.js";
import {
  ProviderLimitError,
  validateProviderLimits,
} from "../shared/provider-limits.js";
const requestSchema = z
  .object({
    toolId: z.string().max(100),
    title: z.string().max(250).optional(),
    projectId: z.string().uuid().nullable().optional(),
    input: z.unknown(),
    providerId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();
export function capabilityProvider(
  store: Store,
  userId: string,
  capability: string,
  providerId?: string,
): Row | null {
  if (capability === "local") return null;
  const list = providerId
    ? [owned(store, "providers", providerId, userId)]
    : store.all(
        "SELECT * FROM providers WHERE owner_id=? AND disabled_at IS NULL ORDER BY updated_at DESC",
        userId,
      );
  const match = list.find(
    (r) =>
      !r.disabled_at &&
      r.secret &&
      providerView(r).capabilities.includes(capability),
  );
  if (!match)
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      `尚未配置 ${capability} 服务，请先在设置中添加支持该能力的服务商。`,
      { capability },
    );
  return match;
}
function canonical(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(x) ?? "null";
}
export function createJobs(
  store: Store,
  userId: string,
  raw: unknown,
  internal: ToolInput = {},
): { items: Job[]; batchId: string } {
  return store.db
    .transaction(() => createJobsInTransaction(store, userId, raw, internal))
    .immediate();
}
function createJobsInTransaction(
  store: Store,
  userId: string,
  raw: unknown,
  internal: ToolInput,
): { items: Job[]; batchId: string } {
  const body = requestSchema.parse(raw);
  let tool;
  let input: ToolInput;
  try {
    tool = findTool(body.toolId);
    const requestInput =
      body.toolId === "replication" &&
      body.input &&
      typeof body.input === "object" &&
      !Array.isArray(body.input) &&
      "durationMode" in body.input &&
      body.input.durationMode === "follow"
        ? { ...body.input, duration: undefined }
        : body.input;
    input = validateInput(body.toolId, requestInput);
  } catch (e) {
    if (e instanceof ZodError) throw e;
    throw new AppError(400, "INVALID_INPUT", (e as Error).message);
  }
  const requestHash = hash(canonical(body));
  const previous = store.get(
    "SELECT * FROM batches WHERE owner_id=? AND idempotency_key=?",
    userId,
    body.idempotencyKey,
  );
  if (previous) {
    if (previous.request_hash !== requestHash)
      throw new AppError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "该提交标识已用于不同的输入",
      );
    return {
      items: store
        .all("SELECT * FROM jobs WHERE batch_id=? ORDER BY rowid", previous.id)
        .map((r) => jobView(store, r)),
      batchId: String(previous.id),
    };
  }
  if (body.projectId) {
    const project = owned(store, "projects", body.projectId, userId);
    if (project.archived_at)
      throw new AppError(400, "PROJECT_ARCHIVED", "请先恢复已归档项目");
  }
  const ids = selectedAssetIds(input);
  if (
    ids.reduce(
      (sum, id) => sum + Number(owned(store, "assets", id, userId).size),
      0,
    ) >
    1024 ** 3
  )
    throw new AppError(400, "BATCH_SIZE", "单次任务素材合计不能超过1GB");
  for (const f of tool.fields.filter((f) => f.type === "assets")) {
    const chosen = (input[f.key] ?? []) as string[];
    for (const id of chosen) {
      const a = owned(store, "assets", id, userId);
      if (a.deleted_at)
        throw new AppError(400, "ASSET_DELETED", "请先恢复回收站中的素材");
      if (!f.accepts?.includes(a.kind as never))
        throw new AppError(400, "ASSET_KIND", `${f.label}不支持此文件类型`);
      if (f.maxBytes && Number(a.size) > f.maxBytes)
        throw new AppError(400, "FILE_SIZE", `${f.label}文件超出体积限制`);
      if (f.maxDuration && Number(a.duration) > f.maxDuration)
        throw new AppError(400, "DURATION_LIMIT", `${f.label}时长超出限制`);
    }
  }
  if (body.toolId === "replication" && input.durationMode === "follow") {
    const sourceId = (input.sourceIds as string[] | undefined)?.[0];
    const source = sourceId
      ? owned(store, "assets", sourceId, userId)
      : undefined;
    const duration = Number(source?.duration);
    if (
      !source ||
      source.kind !== "video" ||
      !Number.isFinite(duration) ||
      duration < 4 ||
      duration > 60
    )
      throw new AppError(
        400,
        "REFERENCE_DURATION_UNSUPPORTED",
        "跟随参考时长需要已探测到 4–60 秒时长的视频；请选择此范围内的素材或改为自定义时长。",
      );
    input.duration = duration;
  }
  const capability = requiredCapability(tool.id, input);
  const provider = capabilityProvider(
    store,
    userId,
    capability,
    body.providerId,
  );
  const config = provider ? providerSecret(store, provider) : null;
  if (config) {
    try {
      validateProviderSelections(config, capability, input);
      validateProviderLimits(
        config,
        body.toolId,
        input,
        ids.map((id) => {
          const a = owned(store, "assets", id, userId);
          return {
            kind: a.kind as "image" | "audio" | "video",
            width: a.width === null ? null : Number(a.width),
            height: a.height === null ? null : Number(a.height),
            duration: a.duration === null ? null : Number(a.duration),
            size: Number(a.size),
          };
        }),
      );
    } catch (error) {
      if (error instanceof ProviderError || error instanceof ProviderLimitError)
        throw new AppError(400, error.code, error.message);
      throw error;
    }
  }
  const snapshot = config
    ? store.storage.encrypt(JSON.stringify(config))
    : null;
  const quantity = Number(input.count ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
    throw new AppError(400, "COUNT_LIMIT", "生成数量必须是1–100的整数");
  const active = Number(
    store.get(
      "SELECT count(*) n FROM jobs WHERE owner_id=? AND status IN ('queued','running')",
      userId,
    )?.n ?? 0,
  );
  if (active + quantity > 200)
    throw new AppError(
      429,
      "QUEUE_LIMIT",
      "待处理任务最多200个，请等待现有任务完成",
    );
  const batchId = uid();
  const created = now();
  store.db.transaction(() => {
    store.run(
      "INSERT INTO batches VALUES(?,?,?,?,?)",
      batchId,
      userId,
      body.idempotencyKey,
      requestHash,
      created,
    );
    for (let i = 0; i < quantity; i++) {
      const id = uid();
      const jobInput = {
        ...input,
        ...internal,
        ...(input.count !== undefined ? { count: 1 } : {}),
        variant: i,
      };
      store.run(
        "INSERT INTO jobs(id,batch_id,owner_id,project_id,tool_id,title,input,provider_snapshot,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        id,
        batchId,
        userId,
        body.projectId ?? null,
        tool.id,
        (body.title || tool.title) +
          (quantity > 1 ? ` · ${i + 1}/${quantity}` : ""),
        JSON.stringify(jobInput),
        snapshot,
        "queued",
        created,
        created,
      );
      for (const assetId of ids)
        store.run("INSERT INTO job_assets VALUES(?,?,'input')", id, assetId);
      event(store, id, "任务已保存，等待处理");
    }
  })();
  return {
    items: store
      .all("SELECT * FROM jobs WHERE batch_id=? ORDER BY rowid", batchId)
      .map((r) => jobView(store, r)),
    batchId,
  };
}
export function event(store: Store, id: string, message: string) {
  store.run(
    "INSERT INTO job_events(job_id,message,created_at) VALUES(?,?,?)",
    id,
    message.slice(0, 1200),
    now(),
  );
}
export function decodeProvider(
  store: Store,
  row: Row,
): ProviderConfig | undefined {
  return row.provider_snapshot
    ? parseJson<ProviderConfig>(
        store.storage.decrypt(String(row.provider_snapshot)),
        {} as ProviderConfig,
      )
    : undefined;
}
export function toolsForUser(store: Store, userId: string) {
  const providers = store
    .all(
      "SELECT * FROM providers WHERE owner_id=? AND disabled_at IS NULL",
      userId,
    )
    .map(providerView);
  return TOOLS.map((t) => ({
    ...t,
    availability:
      t.capability === "local"
        ? "local"
        : providers.some(
              (p) => p.configured && p.capabilities.includes(t.capability),
            )
          ? "configured"
          : "not_configured",
    providerIds: providers
      .filter((p) => p.configured && p.capabilities.includes(t.capability))
      .map((p) => p.id),
  }));
}
export function recoverJobs(store: Store) {
  const cutoff = now();
  const expired = store.all(
    "SELECT * FROM jobs WHERE status='running' AND lease_until < ?",
    cutoff,
  );
  for (const job of expired) {
    const review = !!(
      job.provider_snapshot &&
      job.submission_started &&
      !job.remote_task_id
    );
    const status = review
      ? "needs_review"
      : job.cancel_requested && !job.remote_task_id
        ? "cancelled"
        : "queued";
    const message = review
      ? "外部提交结果不明，已停止自动重试"
      : status === "cancelled"
        ? "取消已确认"
        : "处理进程中断，任务已恢复排队";
    const updated = store.run(
      "UPDATE jobs SET status=?,error_code=?,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_until < ?",
      status,
      review ? "SUBMISSION_UNKNOWN" : null,
      review
        ? "进程中断时外部提交结果不明。请核对服务商记录，避免重复计费。"
        : null,
      now(),
      job.id,
      job.lease_token,
      cutoff,
    );
    if (updated.changes) event(store, String(job.id), message);
  }
}

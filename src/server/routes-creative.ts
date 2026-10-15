import type { FastifyInstance } from "fastify";
import { z } from "zod";
import archiver from "archiver";
import { Store, type Row } from "./db.js";
import { AppError, now, uid, parseJson } from "./core.js";
import { owned, jobView, conversationView, assetView } from "./models.js";
import {
  createJobs,
  event,
  decodeProvider,
  capabilityProvider,
} from "./jobs.js";
import { userId, routeId } from "./app.js";
import { cancelProvider } from "./providers.js";
import type { ToolInput, Job } from "../shared/types.js";

export function registerCreativeRoutes(app: FastifyInstance, store: Store) {
  app.post("/api/jobs", async (req) =>
    createJobs(store, userId(req), req.body),
  );
  app.get("/api/jobs", async (req) => {
    const q = req.query as Record<string, string>;
    const values: unknown[] = [userId(req)];
    let where = "owner_id=?";
    for (const [key, column] of [
      ["status", "status"],
      ["toolId", "tool_id"],
      ["projectId", "project_id"],
    ])
      if (q[key]) {
        where += ` AND ${column}=?`;
        values.push(q[key]);
      }
    if (q.search) {
      where += " AND (title LIKE ? OR id LIKE ?)";
      values.push(`%${q.search}%`, `%${q.search}%`);
    }
    const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(q.limit ?? 50),
      offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(q.offset ?? 0);
    const total = Number(
      store.get(`SELECT count(*) n FROM jobs WHERE ${where}`, ...values)?.n,
    );
    const items = store
      .all(
        `SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,
        ...values,
        limit,
        offset,
      )
      .map((r) => jobView(store, r));
    return { items, total };
  });
  app.get("/api/jobs/:id", async (req) =>
    jobView(store, owned(store, "jobs", routeId(req), userId(req)), true),
  );
  async function cancelJob(id: string, owner: string) {
    let r = owned(store, "jobs", id, owner);
    if (
      ["succeeded", "failed", "cancelled", "needs_review"].includes(
        String(r.status),
      )
    )
      throw new AppError(409, "JOB_TERMINAL", "该任务已结束，无法取消");
    if (r.status === "queued" && !r.remote_task_id) {
      const changed = store.run(
        "UPDATE jobs SET status='cancelled',cancel_requested=1,updated_at=? WHERE id=? AND status='queued' AND remote_task_id IS NULL",
        now(),
        id,
      );
      if (changed.changes) {
        event(store, id, "排队任务已取消");
        return jobView(store, owned(store, "jobs", id, owner), true);
      }
      r = owned(store, "jobs", id, owner);
    }
    const provider = decodeProvider(store, r);
    if (provider && r.remote_task_id) {
      const result = await cancelProvider(
        provider,
        String(r.remote_task_id),
        String(r.tool_id),
      );
      if (!result.supported)
        throw new AppError(409, "REMOTE_CANCEL_UNSUPPORTED", result.message);
      if (result.cancelled) {
        const changed = store.run(
          "UPDATE jobs SET status='cancelled',cancel_requested=1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN('queued','running')",
          now(),
          id,
        );
        if (changed.changes) event(store, id, "服务商已确认取消");
      } else {
        const changed = store.run(
          "UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=? AND status IN('queued','running')",
          now(),
          id,
        );
        if (changed.changes) event(store, id, "取消请求已发出，等待服务商确认");
      }
    } else if (provider && r.submission_started)
      throw new AppError(
        409,
        "SUBMISSION_IN_PROGRESS",
        "正在提交到服务商，暂时无法确认取消，请等待任务编号返回",
      );
    else {
      const changed = store.run(
        `UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=? AND status IN('queued','running')${provider ? " AND submission_started=0 AND remote_task_id IS NULL" : ""}`,
        now(),
        id,
      );
      if (changed.changes) event(store, id, "正在停止处理");
      else if (provider) {
        const current = owned(store, "jobs", id, owner);
        if (
          ["queued", "running"].includes(String(current.status)) &&
          (current.submission_started || current.remote_task_id)
        )
          throw new AppError(
            409,
            "SUBMISSION_IN_PROGRESS",
            "服务商已开始提交，请等待任务状态更新后再取消",
          );
      }
    }
    return jobView(store, owned(store, "jobs", id, owner), true);
  }
  function retryJob(id: string, owner: string) {
    return store.db
      .transaction(() => {
        const r = owned(store, "jobs", id, owner);
        if (
          r.status === "needs_review" ||
          String(r.error_code).toUpperCase() === "SUBMISSION_UNKNOWN"
        )
          throw new AppError(
            409,
            "REVIEW_REQUIRED",
            ["RESULT_COMMIT_FAILED", "RESULT_PROCESSING_FAILED"].includes(
              String(r.error_code),
            )
              ? "服务商已返回成功响应，但产物处理或保存未完成，请先核对产物和服务商记录，不能重复生成。"
              : "上次外部提交结果不明，不能自动重发。请先核对服务商记录。",
          );
        if (!["failed", "cancelled"].includes(String(r.status)))
          throw new AppError(
            409,
            "RETRY_NOT_ALLOWED",
            "只能重试失败或已取消的任务",
          );
        if (
          r.remote_task_id &&
          (r.status === "cancelled" ||
            ["REMOTE_FAILED", "REMOTE_EXPIRED"].includes(String(r.error_code)))
        )
          throw new AppError(
            409,
            "REMOTE_CANCELLED",
            "远端任务已结束，请从原参数新建创作；这会发起新的服务商任务",
          );
        const active = Number(
          store.get(
            "SELECT count(*) n FROM jobs WHERE owner_id=? AND status IN ('queued','running')",
            owner,
          )?.n ?? 0,
        );
        if (active >= 200)
          throw new AppError(
            429,
            "QUEUE_LIMIT",
            "待处理任务最多200个，请等待现有任务完成",
          );
        store.run(
          "UPDATE jobs SET status='queued',progress=0,error=NULL,error_code=NULL,cancel_requested=0,submission_started=CASE WHEN remote_task_id IS NULL THEN 0 ELSE submission_started END,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          now(),
          id,
        );
        event(
          store,
          id,
          r.remote_task_id ? "恢复已有服务商任务，避免再次生成" : "已重新排队",
        );
        return jobView(store, owned(store, "jobs", id, owner), true);
      })
      .immediate();
  }
  app.post("/api/jobs/:id/cancel", async (req) =>
    cancelJob(routeId(req), userId(req)),
  );
  app.post("/api/jobs/:id/retry", async (req) =>
    retryJob(routeId(req), userId(req)),
  );
  for (const action of ["cancel", "retry"] as const)
    app.post(`/api/batches/:id/${action}`, async (req) => {
      const id = routeId(req),
        owner = userId(req);
      if (
        !store.get(
          "SELECT id FROM batches WHERE id=? AND owner_id=?",
          id,
          owner,
        )
      )
        throw new AppError(404, "NOT_FOUND", "批次不存在或无权访问");
      const rows = store.all(
        action === "cancel"
          ? "SELECT id FROM jobs WHERE batch_id=? AND status IN ('queued','running') ORDER BY rowid"
          : "SELECT id FROM jobs WHERE batch_id=? AND status='failed' ORDER BY rowid",
        id,
      );
      const items: Job[] = [],
        errors: { id: string; message: string }[] = [];
      for (const row of rows) {
        try {
          items.push(
            action === "cancel"
              ? await cancelJob(String(row.id), owner)
              : retryJob(String(row.id), owner),
          );
        } catch (error) {
          errors.push({
            id: String(row.id),
            message: (error as Error).message,
          });
        }
      }
      return { items, errors };
    });
  app.get("/api/jobs/:id/download", async (req, reply) => {
    const row = owned(store, "jobs", routeId(req), userId(req));
    const assets = store.all(
      "SELECT a.* FROM assets a JOIN job_assets j ON j.asset_id=a.id WHERE j.job_id=? AND j.role='output'",
      row.id,
    );
    if (!assets.length)
      throw new AppError(404, "NO_OUTPUT", "任务没有可下载产物");
    const archive = archiver("zip", { zlib: { level: 1 } });
    reply
      .type("application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="crosscut-${row.id}.zip"`,
      );
    for (let i = 0; i < assets.length; i++)
      archive.file(store.storage.path(String(assets[i].storage_key)), {
        name: `${String(i + 1).padStart(2, "0")}-${String(assets[i].name).replace(/[\\/\x00-\x1f]/g, "_")}`,
      });
    archive.on("error", (err) => archive.destroy(err));
    void archive.finalize();
    return reply.send(archive);
  });
  app.get("/api/batches/:id", async (req) => {
    const id = routeId(req);
    if (
      !store.get(
        "SELECT id FROM batches WHERE id=? AND owner_id=?",
        id,
        userId(req),
      )
    )
      throw new AppError(404, "NOT_FOUND", "批次不存在或无权访问");
    const counts = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      needs_review: 0,
    };
    for (const row of store.all(
      "SELECT status,count(*) n FROM jobs WHERE batch_id=? GROUP BY status",
      id,
    ))
      counts[row.status as keyof typeof counts] = Number(row.n);
    const outputCount = Number(
      store.get(
        "SELECT count(*) n FROM job_assets ja JOIN jobs j ON j.id=ja.job_id WHERE j.batch_id=? AND ja.role='output' AND j.status='succeeded'",
        id,
      )?.n ?? 0,
    );
    return {
      id,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      counts,
      outputCount,
    };
  });
  app.get("/api/batches/:id/download", async (req, reply) => {
    const id = routeId(req);
    const batch = store.get(
      "SELECT id FROM batches WHERE id=? AND owner_id=?",
      id,
      userId(req),
    );
    if (!batch) throw new AppError(404, "NOT_FOUND", "批次不存在或无权访问");
    const rows = store.all(
      "SELECT a.*,j.id job_id,j.title job_title FROM assets a JOIN job_assets ja ON ja.asset_id=a.id JOIN jobs j ON j.id=ja.job_id WHERE j.batch_id=? AND ja.role='output' AND j.status='succeeded' ORDER BY j.rowid,a.created_at",
      id,
    );
    if (!rows.length)
      throw new AppError(404, "NO_OUTPUT", "批次尚没有可下载的成功产物");
    const archive = archiver("zip", { zlib: { level: 1 } });
    reply
      .type("application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="crosscut-batch-${id}.zip"`,
      );
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      archive.file(store.storage.path(String(row.storage_key)), {
        name: `${String(i + 1).padStart(3, "0")}-${row.job_id}/${String(row.name).replace(/[\\/\x00-\x1f]/g, "_")}`,
      });
    }
    const status = store.all(
      "SELECT id,title,status,error FROM jobs WHERE batch_id=? ORDER BY rowid",
      id,
    );
    archive.append(
      JSON.stringify({ batchId: id, exportedAt: now(), jobs: status }, null, 2),
      { name: "batch-status.json" },
    );
    archive.on("error", (err) => archive.destroy(err));
    void archive.finalize();
    return reply.send(archive);
  });
  app.get("/api/conversations", async (req) => {
    const q = req.query as Record<string, string>;
    const items = store
      .all(
        `SELECT * FROM conversations WHERE owner_id=? AND deleted_at IS ${q.trash === "1" ? "NOT " : ""}NULL ORDER BY updated_at DESC`,
        userId(req),
      )
      .map(conversationView);
    return { items, total: items.length };
  });
  app.post("/api/conversations", async (req) => {
    const b = z
      .object({ title: z.string().trim().min(1).max(150).optional() })
      .strict()
      .parse(req.body ?? {});
    const id = uid(),
      date = now();
    store.run(
      "INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)",
      id,
      userId(req),
      b.title ?? "新的创意",
      date,
      date,
    );
    return conversationView(owned(store, "conversations", id, userId(req)));
  });
  app.get("/api/conversations/:id", async (req) => {
    const r = owned(store, "conversations", routeId(req), userId(req));
    return {
      ...conversationView(r),
      messages: store
        .all(
          "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
          r.id,
        )
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          jobId: m.job_id,
        })),
      jobs: store
        .all(
          "SELECT * FROM jobs WHERE owner_id=? AND json_extract(input,'$.conversationId')=? ORDER BY created_at DESC,rowid DESC",
          userId(req),
          r.id,
        )
        .map((j) => jobView(store, j)),
    };
  });
  app.patch("/api/conversations/:id", async (req) => {
    const id = routeId(req);
    owned(store, "conversations", id, userId(req));
    const b = z
      .object({
        title: z.string().trim().min(1).max(150).optional(),
        deleted: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    store.run(
      "UPDATE conversations SET title=CASE WHEN ? THEN ? ELSE title END,deleted_at=CASE WHEN ? THEN ? ELSE deleted_at END,updated_at=? WHERE id=?",
      b.title !== undefined ? 1 : 0,
      b.title ?? null,
      b.deleted !== undefined ? 1 : 0,
      b.deleted ? now() : null,
      now(),
      id,
    );
    return conversationView(owned(store, "conversations", id, userId(req)));
  });
  app.post("/api/conversations/:id/messages", async (req) => {
    const id = routeId(req);
    const b = z
      .object({
        content: z.string().trim().min(1).max(10000),
        providerId: z.string().uuid().optional(),
        idempotencyKey: z.string().min(8).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    return store.db
      .transaction(() => {
        const r = owned(store, "conversations", id, userId(req));
        if (r.deleted_at)
          throw new AppError(410, "CONVERSATION_DELETED", "请先恢复此对话");
        const key = `conversation:${id}:chat:${b.idempotencyKey ?? uid()}`;
        const previous = store.get(
          "SELECT id FROM batches WHERE owner_id=? AND idempotency_key=?",
          userId(req),
          key,
        );
        if (
          !previous &&
          store.get(
            "SELECT j.id FROM jobs j JOIN messages m ON m.job_id=j.id WHERE m.conversation_id=? AND j.tool_id='agent-chat' AND j.status IN('queued','running')",
            id,
          )
        )
          throw new AppError(
            409,
            "CONVERSATION_BUSY",
            "请等待当前创意回复完成",
          );
        const history = store
          .all(
            "SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 16",
            id,
          )
          .reverse();
        const result = createJobs(
          store,
          userId(req),
          {
            toolId: "agent-chat",
            title: b.content.slice(0, 80),
            input: { text: b.content },
            providerId: b.providerId,
            idempotencyKey: key,
          },
          { conversationId: id, history: JSON.stringify(history) },
        );
        const job = result.items[0];
        if (job.input.conversationId !== id)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "该提交标识不属于当前对话",
          );
        if (previous) return job;
        store.run(
          "INSERT INTO messages VALUES(?,?,'user',?,?,?)",
          uid(),
          id,
          b.content,
          job.id,
          now(),
        );
        store.run(
          "UPDATE conversations SET title=?,updated_at=? WHERE id=?",
          r.title === "新的创意" ? b.content.slice(0, 40) : r.title,
          now(),
          id,
        );
        return job;
      })
      .immediate();
  });
  app.post("/api/conversations/:id/creations", async (req) => {
    const id = routeId(req);
    const b = z
      .object({
        toolId: z.enum(["video-studio", "replication"]),
        title: z.string().trim().min(1).max(250).optional(),
        input: z.unknown(),
        providerId: z.string().uuid().optional(),
        projectId: z.string().uuid().nullable().optional(),
        idempotencyKey: z.string().min(8).max(100),
      })
      .strict()
      .parse(req.body);
    return store.db
      .transaction(() => {
        const r = owned(store, "conversations", id, userId(req));
        if (r.deleted_at)
          throw new AppError(410, "CONVERSATION_DELETED", "请先恢复此对话");
        const result = createJobs(
          store,
          userId(req),
          {
            ...b,
            idempotencyKey: `conversation:${id}:creation:${b.idempotencyKey}`,
          },
          { conversationId: id },
        );
        if (result.items.some((job) => job.input.conversationId !== id))
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "该提交标识不属于当前对话",
          );
        const first = result.items[0];
        if (
          !store.get(
            "SELECT m.id FROM messages m JOIN jobs j ON j.id=m.job_id WHERE m.conversation_id=? AND j.batch_id=? AND m.role='user'",
            id,
            result.batchId,
          )
        ) {
          const mode = b.toolId === "video-studio" ? "视频生成" : "产品复刻";
          const prompt = String(first.input.prompt ?? first.input.text ?? "");
          const content = `已提交${mode}任务：${b.title || mode}（${result.items.length}项）。${prompt ? `\n创作要求：${prompt}` : ""}\n素材和参数已保存在关联任务中。`;
          store.run(
            "INSERT INTO messages VALUES(?,?,'user',?,?,?)",
            uid(),
            id,
            content,
            first.id,
            now(),
          );
          store.run(
            "UPDATE conversations SET title=?,updated_at=? WHERE id=?",
            r.title === "新的创意" ? (b.title || mode).slice(0, 40) : r.title,
            now(),
            id,
          );
        }
        return result;
      })
      .immediate();
  });
  function analysisView(r: Row) {
    const versions = store
      .all(
        "SELECT * FROM analysis_versions WHERE analysis_id=? ORDER BY version DESC",
        r.id,
      )
      .map((v) => ({
        version: Number(v.version),
        prompt: String(v.prompt),
        createdAt: String(v.created_at),
        jobs: store
          .all(
            "SELECT j.* FROM jobs j JOIN analysis_jobs aj ON aj.job_id=j.id WHERE aj.version_id=? ORDER BY aj.section",
            v.id,
          )
          .map((j) => jobView(store, j)),
      }));
    return {
      id: String(r.id),
      assetId: String(r.asset_id),
      asset: assetView(
        owned(store, "assets", String(r.asset_id), String(r.owner_id)),
      ),
      versions,
      createdAt: String(r.created_at),
    };
  }
  function newVersion(
    owner: string,
    analysisId: string,
    assetId: string,
    mode: string,
    providerId?: string,
    section?: string,
  ) {
    const previous = store.get(
      "SELECT * FROM analysis_versions WHERE analysis_id=? ORDER BY version DESC LIMIT 1",
      analysisId,
    );
    const version = Number(previous?.version ?? 0) + 1,
      versionId = uid();
    store.run(
      "INSERT INTO analysis_versions VALUES(?,?,?,?,?)",
      versionId,
      analysisId,
      version,
      previous?.prompt ?? "",
      now(),
    );
    const jobs: Job[] = [];
    for (const part of mode === "technical"
      ? ["technical"]
      : ["timeline", "mechanism", "prompt"]) {
      if (section && part !== section && previous) {
        const old = store.get(
          "SELECT * FROM analysis_jobs WHERE version_id=? AND section=?",
          previous.id,
          part,
        );
        if (old) {
          store.run(
            "INSERT INTO analysis_jobs VALUES(?,?,?)",
            versionId,
            part,
            old.job_id,
          );
          jobs.push(
            jobView(
              store,
              store.get("SELECT * FROM jobs WHERE id=?", old.job_id)!,
            ),
          );
          continue;
        }
      }
      const result = createJobs(
        store,
        owner,
        {
          toolId: part === "technical" ? "scene-detect" : `analysis-${part}`,
          input: { sourceIds: [assetId] },
          providerId,
          idempotencyKey: uid(),
        },
        part === "prompt"
          ? { analysisPromptBaseline: String(previous?.prompt ?? "") }
          : {},
      );
      store.run(
        "INSERT INTO analysis_jobs VALUES(?,?,?)",
        versionId,
        part,
        result.items[0].id,
      );
      jobs.push(result.items[0]);
    }
    return { id: analysisId, version, jobs };
  }
  app.post("/api/analyses", async (req) => {
    const b = z
      .object({
        assetId: z.string().uuid(),
        providerId: z.string().uuid().optional(),
        mode: z.enum(["semantic", "technical"]).default("semantic"),
      })
      .strict()
      .parse(req.body);
    const a = owned(store, "assets", b.assetId, userId(req));
    if (a.kind !== "video")
      throw new AppError(400, "VIDEO_REQUIRED", "拆解需要视频素材");
    if (b.mode === "semantic")
      capabilityProvider(store, userId(req), "video.analysis", b.providerId);
    return store.db.transaction(() => {
      const id = uid();
      store.run(
        "INSERT INTO analyses VALUES(?,?,?,?)",
        id,
        userId(req),
        b.assetId,
        now(),
      );
      return newVersion(userId(req), id, b.assetId, b.mode, b.providerId);
    })();
  });
  app.get("/api/analyses", async (req) => {
    const q = z
      .object({
        search: z.string().max(250).optional(),
        source: z.enum(["upload", "generated", "demo"]).optional(),
        mode: z.enum(["technical", "semantic"]).optional(),
        status: z
          .enum([
            "queued",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "needs_review",
            "partial",
          ])
          .optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        before: z.iso.datetime({ offset: true }).optional(),
        order: z.enum(["newest", "oldest"]).default("newest"),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    if (q.from && q.before && Date.parse(q.from) >= Date.parse(q.before))
      throw new AppError(400, "INVALID_DATE_RANGE", "开始日期必须早于结束日期");
    const values: unknown[] = [userId(req)];
    const filters: string[] = [];
    if (q.search) {
      filters.push("(asset_name LIKE ? OR id LIKE ?)");
      values.push(`%${q.search}%`, `%${q.search}%`);
    }
    for (const key of ["source", "mode", "status"] as const)
      if (q[key]) {
        filters.push(`${key}=?`);
        values.push(q[key]);
      }
    if (q.from) {
      filters.push("created_at>=?");
      values.push(new Date(q.from).toISOString());
    }
    if (q.before) {
      filters.push("created_at<?");
      values.push(new Date(q.before).toISOString());
    }
    const cte = `WITH summary AS (
      SELECT a.id,a.asset_id,a.created_at,s.name asset_name,s.source,v.version,
        CASE WHEN sum(CASE WHEN aj.section='technical' THEN 1 ELSE 0 END)>0 THEN 'technical' ELSE 'semantic' END mode,
        count(j.id) task_count,
        sum(CASE WHEN j.status='succeeded' THEN 1 ELSE 0 END) completed,
        CASE
          WHEN sum(CASE WHEN j.status='needs_review' THEN 1 ELSE 0 END)>0 THEN 'needs_review'
          WHEN sum(CASE WHEN j.status='running' THEN 1 ELSE 0 END)>0 THEN 'running'
          WHEN sum(CASE WHEN j.status='queued' THEN 1 ELSE 0 END)>0 THEN 'queued'
          WHEN count(j.id)>0 AND sum(CASE WHEN j.status='succeeded' THEN 1 ELSE 0 END)=count(j.id) THEN 'succeeded'
          WHEN sum(CASE WHEN j.status='succeeded' THEN 1 ELSE 0 END)>0 THEN 'partial'
          WHEN sum(CASE WHEN j.status='failed' THEN 1 ELSE 0 END)>0 THEN 'failed'
          ELSE 'cancelled' END status
      FROM analyses a JOIN assets s ON s.id=a.asset_id
      JOIN analysis_versions v ON v.analysis_id=a.id AND v.version=(SELECT max(version) FROM analysis_versions WHERE analysis_id=a.id)
      LEFT JOIN analysis_jobs aj ON aj.version_id=v.id LEFT JOIN jobs j ON j.id=aj.job_id
      WHERE a.owner_id=? GROUP BY a.id,v.id
    )`;
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const total = Number(
      store.get(`${cte} SELECT count(*) n FROM summary ${where}`, ...values)
        ?.n ?? 0,
    );
    const direction = q.order === "oldest" ? "ASC" : "DESC";
    const items = store
      .all(
        `${cte} SELECT * FROM summary ${where} ORDER BY created_at ${direction},id ${direction} LIMIT ? OFFSET ?`,
        ...values,
        q.limit,
        q.offset,
      )
      .map((r) => ({
        id: String(r.id),
        assetId: String(r.asset_id),
        assetName: String(r.asset_name),
        source: String(r.source),
        mode: String(r.mode),
        status: String(r.status),
        version: Number(r.version),
        taskCount: Number(r.task_count),
        completed: Number(r.completed),
        createdAt: String(r.created_at),
      }));
    return { items, total };
  });
  app.get("/api/analyses/:id", async (req) =>
    analysisView(owned(store, "analyses", routeId(req), userId(req))),
  );
  app.post("/api/analyses/:id/retry", async (req) => {
    const r = owned(store, "analyses", routeId(req), userId(req));
    const b = z
      .object({
        section: z.enum(["timeline", "mechanism", "prompt"]).optional(),
        providerId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const previous = store.get(
      "SELECT id FROM analysis_versions WHERE analysis_id=? ORDER BY version DESC LIMIT 1",
      r.id,
    );
    const technical =
      previous &&
      !!store.get(
        "SELECT job_id FROM analysis_jobs WHERE version_id=? AND section='technical'",
        previous.id,
      );
    if (!technical)
      capabilityProvider(store, userId(req), "video.analysis", b.providerId);
    return store.db.transaction(() =>
      newVersion(
        userId(req),
        String(r.id),
        String(r.asset_id),
        technical ? "technical" : "semantic",
        b.providerId,
        technical ? undefined : b.section,
      ),
    )();
  });
  app.patch("/api/analyses/:id/prompt", async (req) => {
    const id = routeId(req);
    owned(store, "analyses", id, userId(req));
    const b = z
      .object({
        version: z.number().int().min(1),
        prompt: z.string().max(30000),
      })
      .strict()
      .parse(req.body);
    const result = store.run(
      "UPDATE analysis_versions SET prompt=? WHERE analysis_id=? AND version=?",
      b.prompt,
      id,
      b.version,
    );
    if (!result.changes)
      throw new AppError(404, "VERSION_NOT_FOUND", "分析版本不存在");
    return { ok: true };
  });
}

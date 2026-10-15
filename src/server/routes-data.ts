import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rm, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { load } from "cheerio";
import { Store } from "./db.js";
import { AppError, now, uid, parseJson } from "./core.js";
import {
  owned,
  assetView,
  projectView,
  providerView,
  jobView,
  radarView,
} from "./models.js";
import { saveAsset } from "./assets.js";
import { toolsForUser } from "./jobs.js";
import { userId, routeId, workerStatus } from "./app.js";
import { safeFetch } from "./safe-http.js";
import { runMediaTask } from "./media.js";
import type { ExecutionContext } from "../shared/types.js";
const exec = promisify(execFile);
const literalLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
const dateFilterFields = {
  from: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
};
function validateDateFilter(value: { from?: string; before?: string }) {
  if (
    value.from &&
    value.before &&
    Date.parse(value.from) >= Date.parse(value.before)
  )
    throw new AppError(400, "INVALID_DATE_RANGE", "开始日期必须早于结束日期");
}
function filterChoices(raw: string | undefined, legacy = "", maxLength = 100) {
  let values: unknown;
  try {
    values =
      raw === undefined
        ? legacy
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : JSON.parse(raw);
  } catch {
    throw new AppError(400, "INVALID_FILTER", "多选筛选必须是有效的 JSON 数组");
  }
  return [
    ...new Set(
      z.array(z.string().trim().min(1).max(maxLength)).max(50).parse(values),
    ),
  ];
}
const industryPathSchema = z
  .string()
  .trim()
  .max(300)
  .refine((value) => {
    if (!value) return true;
    const parts = value.split("/").map((part) => part.trim());
    return (
      parts.length <= 5 &&
      parts.every((part) => part.length > 0 && part.length <= 100)
    );
  }, "行业最多5级，每级1–100字符，用 / 分隔。")
  .transform((value) =>
    value
      ? value
          .split("/")
          .map((part) => part.trim())
          .join(" / ")
      : "",
  );
const providerCaps: Record<string, string[]> = {
  openai: [
    "chat",
    "image.generate",
    "image.edit",
    "speech",
    "transcription",
    "video.analysis",
  ],
  ark: ["video.task"],
  elevenlabs: ["voice.clone", "speech"],
  heygen: ["avatar.text", "avatar.audio", "avatar.photo", "video.translate"],
  workflow: [
    "workflow:product-avatar",
    "workflow:replication",
    "workflow:link-video",
    "workflow:subtitle-remove",
    "video.task",
    "avatar.text",
    "avatar.audio",
    "avatar.photo",
    "voice.clone",
    "video.translate",
  ],
};
export function registerDataRoutes(app: FastifyInstance, store: Store) {
  app.get("/api/tools", async (req) => {
    const items = toolsForUser(store, userId(req));
    return { items, total: items.length };
  });
  app.get("/api/overview", async (req) => {
    const owner = userId(req);
    const count = (table: string, where = "") =>
      Number(
        store.get(
          `SELECT count(*) n FROM ${table} WHERE owner_id=? ${where}`,
          owner,
        )?.n ?? 0,
      );
    const tools = toolsForUser(store, owner);
    return {
      projects: count("projects", "AND archived_at IS NULL"),
      assets: count("assets", "AND deleted_at IS NULL"),
      jobs: count("jobs"),
      completed: count("jobs", "AND status='succeeded'"),
      recentJobs: store
        .all(
          "SELECT * FROM jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 6",
          owner,
        )
        .map((r) => jobView(store, r)),
      recentProjects: store
        .all(
          "SELECT * FROM projects WHERE owner_id=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 6",
          owner,
        )
        .map(projectView),
      capabilities: {
        local: tools.filter((t) => t.availability === "local").length,
        configured: tools.filter((t) => t.availability === "configured").length,
        total: tools.length,
      },
      storageBytes: Number(
        store.get(
          "SELECT coalesce(sum(size),0) n FROM assets WHERE owner_id=?",
          owner,
        )?.n,
      ),
    };
  });
  const projectSchema = z
    .object({
      name: z.string().trim().min(1).max(150),
      description: z.string().max(3000).default(""),
      market: z.string().max(100).default(""),
      brand: z.string().max(150).default(""),
    })
    .strict();
  app.get("/api/projects", async (req) => {
    const q = req.query as Record<string, string>;
    const items = store
      .all(
        `SELECT * FROM projects WHERE owner_id=? AND archived_at IS ${q.archived === "1" ? "NOT " : ""}NULL AND name LIKE ? ORDER BY updated_at DESC`,
        userId(req),
        `%${q.search ?? ""}%`,
      )
      .map(projectView);
    return { items, total: items.length };
  });
  app.post("/api/projects", async (req) => {
    const b = projectSchema.parse(req.body),
      id = uid(),
      date = now();
    store.run(
      "INSERT INTO projects(id,owner_id,name,description,market,brand,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      userId(req),
      b.name,
      b.description,
      b.market,
      b.brand,
      date,
      date,
    );
    return projectView(owned(store, "projects", id, userId(req)));
  });
  app.patch("/api/projects/:id", async (req) => {
    const id = routeId(req),
      r = owned(store, "projects", id, userId(req));
    const b = projectSchema
      .partial()
      .extend({ archived: z.boolean().optional() })
      .strict()
      .parse(req.body);
    store.run(
      "UPDATE projects SET name=?,description=?,market=?,brand=?,archived_at=?,updated_at=? WHERE id=?",
      b.name ?? r.name,
      b.description ?? r.description,
      b.market ?? r.market,
      b.brand ?? r.brand,
      b.archived === undefined ? r.archived_at : b.archived ? now() : null,
      now(),
      id,
    );
    return projectView(owned(store, "projects", id, userId(req)));
  });
  app.patch("/api/projects/:id/assets", async (req) => {
    const id = routeId(req);
    owned(store, "projects", id, userId(req));
    const { assetIds } = z
      .object({ assetIds: z.array(z.string().uuid()).max(1000) })
      .strict()
      .parse(req.body);
    for (const a of assetIds) owned(store, "assets", a, userId(req));
    store.db.transaction(() => {
      store.run("DELETE FROM project_assets WHERE project_id=?", id);
      for (const a of new Set(assetIds))
        store.run("INSERT INTO project_assets VALUES(?,?)", id, a);
    })();
    return { ok: true };
  });
  app.get("/api/assets", async (req) => {
    const q = z
      .object({
        search: z.string().trim().max(250).default(""),
        kind: z
          .enum(["video", "image", "audio", "subtitle", "document"])
          .optional(),
        trash: z.enum(["0", "1"]).default("0"),
        projectId: z.string().uuid().optional(),
        tags: z.string().max(5000).optional(),
        sort: z.enum(["newest", "oldest", "name", "size"]).default("newest"),
        ...dateFilterFields,
      })
      .parse(req.query);
    validateDateFilter(q);
    const values: unknown[] = [userId(req)];
    let filter = `owner_id=? AND deleted_at IS ${q.trash === "1" ? "NOT " : ""}NULL`;
    if (q.search) {
      filter +=
        " AND (name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(assets.tags) t WHERE t.value LIKE ? ESCAPE '\\'))";
      const search = `%${literalLike(q.search)}%`;
      values.push(search, search, search);
    }
    if (q.kind) {
      filter += " AND kind=?";
      values.push(q.kind);
    }
    if (q.projectId) {
      owned(store, "projects", q.projectId, userId(req));
      filter +=
        " AND id IN(SELECT asset_id FROM project_assets WHERE project_id=?)";
      values.push(q.projectId);
    }
    const tags = filterChoices(q.tags, "", 40);
    if (tags.length) {
      filter += ` AND EXISTS(SELECT 1 FROM json_each(assets.tags) t WHERE t.value IN (${tags.map(() => "?").join(",")}))`;
      values.push(...tags);
    }
    if (q.from) {
      filter += " AND created_at>=?";
      values.push(new Date(q.from).toISOString());
    }
    if (q.before) {
      filter += " AND created_at<?";
      values.push(new Date(q.before).toISOString());
    }
    const sorting = {
      newest: "created_at DESC",
      oldest: "created_at ASC",
      name: "name COLLATE NOCASE ASC",
      size: "size DESC",
    }[q.sort];
    const items = store
      .all(
        `SELECT * FROM assets WHERE ${filter} ORDER BY ${sorting},id`,
        ...values,
      )
      .map(assetView);
    const availableTags = store
      .all(
        `SELECT DISTINCT t.value tag FROM assets a,json_each(a.tags) t WHERE a.owner_id=? AND a.deleted_at IS ${q.trash === "1" ? "NOT " : ""}NULL ORDER BY t.value`,
        userId(req),
      )
      .map((row) => String(row.tag));
    return { items, total: items.length, tags: availableTags };
  });
  app.post("/api/assets", async (req) => {
    if (!req.isMultipart())
      throw new AppError(400, "MULTIPART_REQUIRED", "请使用文件上传表单");
    const dir = join(store.storage.temp, uid());
    await mkdir(dir, { recursive: true });
    const items = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== "file") continue;
        const suffix = extname(part.filename)
          .slice(0, 10)
          .replace(/[^.a-zA-Z0-9]/g, "");
        const path = join(dir, uid() + suffix);
        await pipeline(
          part.file,
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
        );
        if (part.file.truncated)
          throw new AppError(413, "FILE_TOO_LARGE", "单个文件最大250MB");
        items.push(
          await saveAsset(store, userId(req), path, { name: part.filename }),
        );
      }
      if (!items.length)
        throw new AppError(400, "EMPTY_UPLOAD", "请选择至少一个文件");
      return { items, total: items.length };
    } catch (error) {
      if (items.length) {
        const e = error as Error;
        throw new AppError(
          error instanceof AppError ? error.status : 400,
          "PARTIAL_UPLOAD",
          `已保存 ${items.length} 个文件；后续上传未完成：${e.message}`,
          { items },
        );
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  app.patch("/api/assets/:id", async (req) => {
    const id = routeId(req),
      a = owned(store, "assets", id, userId(req));
    const b = z
      .object({
        name: z.string().trim().min(1).max(255).optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
        deleted: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    store.run(
      "UPDATE assets SET name=?,tags=?,deleted_at=? WHERE id=?",
      b.name ?? a.name,
      b.tags ? JSON.stringify([...new Set(b.tags)]) : a.tags,
      b.deleted === undefined ? a.deleted_at : b.deleted ? now() : null,
      id,
    );
    return assetView(owned(store, "assets", id, userId(req)));
  });
  for (const thumbnail of [false, true])
    app.get(
      `/api/assets/:id/${thumbnail ? "thumbnail" : "file"}`,
      async (req, reply) => {
        const a = owned(store, "assets", routeId(req), userId(req));
        if (a.deleted_at)
          throw new AppError(410, "ASSET_DELETED", "素材在回收站中，请先恢复");
        const key = thumbnail ? a.thumbnail_key : a.storage_key;
        if (!key) throw new AppError(404, "NO_PREVIEW", "暂无缩略图");
        const path = store.storage.path(String(key));
        const info = await stat(path);
        const mime = thumbnail ? "image/jpeg" : String(a.mime);
        reply.type(mime).header("Accept-Ranges", "bytes");
        const q = req.query as Record<string, string>;
        reply.header(
          "Content-Disposition",
          `${q.download === "1" ? "attachment" : "inline"}; filename="asset.${String(key).split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(String(a.name)).replace(/'/g, "%27")}`,
        );
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match)
            return reply
              .status(416)
              .header("Content-Range", `bytes */${info.size}`)
              .send();
          let start = match[1]
            ? Number(match[1])
            : Math.max(0, info.size - Number(match[2]));
          let end = match[1]
            ? match[2]
              ? Number(match[2])
              : info.size - 1
            : info.size - 1;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= info.size
          )
            return reply
              .status(416)
              .header("Content-Range", `bytes */${info.size}`)
              .send();
          end = Math.min(end, info.size - 1);
          reply
            .status(206)
            .header("Content-Range", `bytes ${start}-${end}/${info.size}`)
            .header("Content-Length", end - start + 1);
          return reply.send(createReadStream(path, { start, end }));
        }
        reply.header("Content-Length", info.size);
        return reply.send(createReadStream(path));
      },
    );
  app.get("/api/drafts", async (req) => {
    const q = req.query as Record<string, string>;
    const items = store
      .all(
        `SELECT * FROM drafts WHERE owner_id=? AND deleted_at IS ${q.trash === "1" ? "NOT " : ""}NULL ORDER BY updated_at DESC`,
        userId(req),
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        toolId: r.tool_id,
        projectId: r.project_id,
        input: parseJson(r.input, {}),
        updatedAt: r.updated_at,
      }));
    return { items, total: items.length };
  });
  app.post("/api/drafts", async (req) => {
    const b = z
      .object({
        id: z.string().uuid().optional(),
        title: z.string().max(250),
        toolId: z.string().max(100),
        projectId: z.string().uuid().nullable().optional(),
        input: z.record(
          z.string().max(100),
          z.union([
            z.string().max(30000),
            z.number().finite(),
            z.boolean(),
            z.array(z.string().max(300)).max(100),
          ]),
        ),
      })
      .strict()
      .parse(req.body);
    if (b.projectId) owned(store, "projects", b.projectId, userId(req));
    if (b.id) owned(store, "drafts", b.id, userId(req));
    const id = b.id ?? uid();
    store.run(
      "INSERT INTO drafts(id,owner_id,project_id,title,tool_id,input,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,tool_id=excluded.tool_id,input=excluded.input,updated_at=excluded.updated_at,deleted_at=NULL",
      id,
      userId(req),
      b.projectId ?? null,
      b.title,
      b.toolId,
      JSON.stringify(b.input),
      now(),
    );
    const r = owned(store, "drafts", id, userId(req));
    return {
      id: r.id,
      title: r.title,
      toolId: r.tool_id,
      projectId: r.project_id,
      input: parseJson(r.input, {}),
      updatedAt: r.updated_at,
    };
  });
  app.patch("/api/drafts/:id", async (req) => {
    const id = routeId(req);
    owned(store, "drafts", id, userId(req));
    const b = z.object({ deleted: z.boolean() }).strict().parse(req.body);
    store.run(
      "UPDATE drafts SET deleted_at=?,updated_at=? WHERE id=?",
      b.deleted ? now() : null,
      now(),
      id,
    );
    return { ok: true };
  });
  app.delete("/api/drafts/:id", async (req) => {
    const r = owned(store, "drafts", routeId(req), userId(req));
    store.run("UPDATE drafts SET deleted_at=? WHERE id=?", now(), r.id);
    return { ok: true };
  });
  const providerSchema = z
    .object({
      id: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(100),
      kind: z.enum(["openai", "ark", "elevenlabs", "heygen", "workflow"]),
      baseUrl: z.url().max(2000),
      model: z.string().max(300),
      models: z.record(z.string().max(100), z.string().max(300)).default({}),
      capabilities: z.array(z.string().max(100)).min(1).max(40),
      apiKey: z.string().max(20000).optional(),
      voices: z
        .array(
          z
            .object({
              id: z.string().max(300),
              name: z.string().max(200),
              language: z.string().max(80).optional(),
              gender: z.string().max(80).optional(),
            })
            .strict(),
        )
        .max(500)
        .default([]),
      avatars: z
        .array(
          z
            .object({
              id: z.string().max(300),
              name: z.string().max(200),
              gender: z.string().max(80).optional(),
              scene: z.string().max(100).optional(),
              imageUrl: z.url().optional(),
            })
            .strict(),
        )
        .max(500)
        .default([]),
    })
    .strict();
  app.get("/api/providers", async (req) => {
    const items = store
      .all(
        "SELECT * FROM providers WHERE owner_id=? AND disabled_at IS NULL ORDER BY updated_at DESC",
        userId(req),
      )
      .map(providerView);
    return { items, total: items.length };
  });
  app.post("/api/providers", async (req) => {
    const b = providerSchema.parse(req.body);
    const url = new URL(b.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          process.env.CROSSCUT_ALLOW_LOCAL_PROVIDERS === "1" &&
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname)
        ))
    )
      throw new AppError(
        400,
        "INVALID_PROVIDER_URL",
        "服务地址必须是无鉴权参数的HTTPS地址",
      );
    if (b.capabilities.some((c) => !providerCaps[b.kind].includes(c)))
      throw new AppError(
        400,
        "UNSUPPORTED_CAPABILITY",
        "该适配器不支持所选能力",
      );
    const previous = b.id
      ? owned(store, "providers", b.id, userId(req))
      : undefined;
    const id = b.id ?? uid();
    if (previous?.secret && !b.apiKey) {
      const old = providerView(previous);
      if (old.kind !== b.kind || new URL(old.baseUrl).origin !== url.origin)
        throw new AppError(
          400,
          "REENTER_API_KEY",
          "服务商类型或地址已改变，请重新输入该服务的密钥",
        );
    }
    const secret = b.apiKey
      ? store.storage.encrypt(b.apiKey)
      : (previous?.secret ?? "");
    const { apiKey: _, id: __, ...config } = b;
    store.run(
      "INSERT INTO providers(id,owner_id,name,kind,config,secret,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,config=excluded.config,secret=excluded.secret,verified=0,updated_at=excluded.updated_at,disabled_at=NULL",
      id,
      userId(req),
      b.name,
      b.kind,
      JSON.stringify({ ...config, baseUrl: b.baseUrl.replace(/\/+$/, "") }),
      secret,
      now(),
    );
    return providerView(owned(store, "providers", id, userId(req)));
  });
  app.delete("/api/providers/:id", async (req) => {
    const r = owned(store, "providers", routeId(req), userId(req));
    store.run("UPDATE providers SET disabled_at=? WHERE id=?", now(), r.id);
    return { ok: true };
  });
  app.get("/api/settings/runtime", async (req) => {
    async function version(command: string) {
      try {
        return (
          await exec(command, ["-version"], { timeout: 5000 })
        ).stdout.split("\n")[0];
      } catch {
        return "未检测到";
      }
    }
    const [ffmpeg, ffprobe] = await Promise.all([
      version(process.env.FFMPEG_PATH ?? "ffmpeg"),
      version(process.env.FFPROBE_PATH ?? "ffprobe"),
    ]);
    return {
      node: process.version,
      ffmpeg,
      ffprobe,
      sqliteVersion: store.get("SELECT sqlite_version() v")?.v,
      dataDir: store.storage.root,
      worker: workerStatus(store),
      storageBytes: Number(
        store.get(
          "SELECT coalesce(sum(size),0) n FROM assets WHERE owner_id=?",
          userId(req),
        )?.n,
      ),
    };
  });
  app.get("/api/usage", async (req) => {
    const items = store
      .all(
        "SELECT * FROM usage_events WHERE owner_id=? ORDER BY created_at DESC LIMIT 500",
        userId(req),
      )
      .map((r) => ({
        id: r.id,
        jobId: r.job_id,
        provider: r.provider_name,
        details: parseJson(r.details, {}),
        createdAt: r.created_at,
      }));
    return { items, total: items.length };
  });
  app.post("/api/product/inspect", async (req) => {
    const { url } = z
      .object({ url: z.url().max(1000) })
      .strict()
      .parse(req.body);
    const response = await safeFetch(url, {
      maxBytes: 3 * 1024 * 1024,
      timeoutMs: 15000,
      headers: { "User-Agent": "Crosscut-Product-Inspector/0.1" },
    });
    if (!response.ok)
      throw new AppError(
        422,
        "PRODUCT_FETCH_FAILED",
        `产品页面返回HTTP ${response.status}，可以手动填写产品信息`,
      );
    if (!response.headers.get("content-type")?.includes("text/html"))
      throw new AppError(400, "NOT_HTML", "链接必须指向商品网页");
    const $ = load(response.body.toString("utf8"));
    const meta = (p: string) =>
      $(`meta[property="${p}"],meta[name="${p}"]`).first().attr("content") ??
      "";
    const images = [
      meta("og:image"),
      ...$("img")
        .map((_, e) => $(e).attr("src"))
        .get()
        .slice(0, 10),
    ]
      .filter(Boolean)
      .map((s) => {
        try {
          return new URL(s, response.url).href;
        } catch {
          return "";
        }
      })
      .filter((s) => /^https?:\/\//.test(s));
    return {
      title: meta("og:title") || $("title").text().trim().slice(0, 300),
      description: (meta("og:description") || meta("description")).slice(
        0,
        2000,
      ),
      price: meta("product:price:amount"),
      imageUrls: [...new Set(images)].slice(0, 10),
      sourceUrl: response.url,
    };
  });
  const radarSchema = z
    .object({
      title: z.string().trim().min(1).max(500),
      brand: z.string().max(200).default(""),
      country: z.string().max(100).default(""),
      industry: industryPathSchema.default(""),
      objective: z.string().max(100).default(""),
      format: z.string().max(30).default(""),
      sourceUrl: z
        .union([
          z.literal(""),
          z
            .url()
            .refine(
              (value) => ["http:", "https:"].includes(new URL(value).protocol),
              "来源链接必须使用HTTP或HTTPS",
            ),
        ])
        .default(""),
      assetId: z.string().uuid().nullable().default(null),
      likes: z.number().nonnegative().nullable().default(null),
      shares: z.number().nonnegative().nullable().default(null),
      comments: z.number().nonnegative().nullable().default(null),
      ctr: z.number().min(0).max(100).nullable().default(null),
      budget: z.number().nonnegative().nullable().default(null),
      metrics: z
        .array(
          z
            .object({
              time: z.number().nonnegative(),
              retention: z.number().min(0).max(100).optional(),
              clicks: z.number().nonnegative().optional(),
              ctr: z.number().min(0).max(100).optional(),
              conversions: z.number().nonnegative().optional(),
              cvr: z.number().min(0).max(100).optional(),
            })
            .strict(),
        )
        .max(3600)
        .default([]),
    })
    .strict();
  const insertRadar = (owner: string, b: z.infer<typeof radarSchema>) => {
    if (b.assetId) owned(store, "assets", b.assetId, owner);
    const id = uid();
    store.run(
      "INSERT INTO radar_assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      owner,
      b.title,
      b.brand,
      b.country,
      b.industry,
      b.objective,
      b.format,
      b.sourceUrl,
      b.assetId,
      b.likes,
      b.shares,
      b.comments,
      b.ctr,
      b.budget,
      JSON.stringify(b.metrics),
      now(),
    );
    return id;
  };
  app.get("/api/radar", async (req) => {
    const q = z
      .object({
        search: z.string().trim().max(250).default(""),
        country: z.string().max(6000).optional(),
        industry: z.string().max(16000).optional(),
        industryPaths: z.string().max(20000).optional(),
        objective: z.string().max(6000).optional(),
        format: z.string().max(100).optional(),
        tags: z.string().max(5000).optional(),
        favorite: z.enum(["0", "1"]).default("0"),
        sort: z
          .enum([
            "likes",
            "shares",
            "comments",
            "ctr",
            "budget",
            "created_at",
            "favorite_at",
          ])
          .default("created_at"),
        order: z.enum(["asc", "desc"]).default("desc"),
        ...dateFilterFields,
      })
      .parse(req.query);
    validateDateFilter(q);
    const values: unknown[] = [userId(req), userId(req)];
    let where = "r.owner_id=?";
    if (q.search) {
      where +=
        " AND (r.title LIKE ? ESCAPE '\\' OR r.brand LIKE ? ESCAPE '\\' OR r.source_url LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\')";
      const search = `%${literalLike(q.search)}%`;
      values.push(search, search, search, search);
    }
    for (const key of ["country", "objective", "format"] as const)
      if (q[key]) {
        const choices = filterChoices(undefined, q[key]);
        if (choices.length) {
          where += ` AND r.${key} IN (${choices.map(() => "?").join(",")})`;
          values.push(...choices);
        }
      }
    const industries = filterChoices(q.industryPaths, q.industry, 300).map(
      (value) => industryPathSchema.parse(value),
    );
    if (industries.length) {
      where += ` AND (${industries.map(() => "(r.industry=? OR instr(r.industry,?)=1)").join(" OR ")})`;
      for (const industry of industries)
        values.push(industry, `${industry} / `);
    }
    const tags = filterChoices(q.tags, "", 40);
    if (tags.length) {
      where += ` AND EXISTS(SELECT 1 FROM assets a,json_each(a.tags) t WHERE a.id=r.asset_id AND a.owner_id=r.owner_id AND t.value IN (${tags.map(() => "?").join(",")}))`;
      values.push(...tags);
    }
    if (q.favorite === "1") {
      where += " AND f.radar_id IS NOT NULL";
    }
    if (q.from) {
      where += " AND r.created_at>=?";
      values.push(new Date(q.from).toISOString());
    }
    if (q.before) {
      where += " AND r.created_at<?";
      values.push(new Date(q.before).toISOString());
    }
    const sort = q.sort === "favorite_at" ? "f.created_at" : `r.${q.sort}`;
    const items = store
      .all(
        `SELECT r.* FROM radar_assets r LEFT JOIN favorites f ON f.radar_id=r.id AND f.user_id=? WHERE ${where} ORDER BY ${sort} IS NULL ASC,${sort} ${q.order === "asc" ? "ASC" : "DESC"},r.id`,
        ...values,
      )
      .map((r) => radarView(store, r, userId(req)));
    return { items, total: items.length };
  });
  app.post("/api/radar", async (req) => {
    const b = radarSchema.parse(req.body),
      id = insertRadar(userId(req), b);
    return radarView(
      store,
      owned(store, "radar_assets", id, userId(req)),
      userId(req),
    );
  });
  app.post("/api/radar/import", async (req) => {
    const b = z
      .object({ items: z.array(radarSchema).min(1).max(1000) })
      .strict()
      .parse(req.body);
    const items = store.db.transaction(() =>
      b.items.map((item) => {
        const id = insertRadar(userId(req), item);
        return radarView(
          store,
          owned(store, "radar_assets", id, userId(req)),
          userId(req),
        );
      }),
    )();
    return { items, total: items.length };
  });
  app.post("/api/radar/:id/favorite", async (req) => {
    const id = routeId(req),
      r = owned(store, "radar_assets", id, userId(req));
    const b = z.object({ favorite: z.boolean() }).strict().parse(req.body);
    if (b.favorite)
      store.run(
        "INSERT OR IGNORE INTO favorites VALUES(?,?,?)",
        userId(req),
        id,
        now(),
      );
    else
      store.run(
        "DELETE FROM favorites WHERE user_id=? AND radar_id=?",
        userId(req),
        id,
      );
    return radarView(store, r, userId(req));
  });
  app.post("/api/assets/demo", async (req) => {
    const owner = userId(req);
    const existing = store.all(
      "SELECT * FROM assets WHERE owner_id=? AND source='demo' AND deleted_at IS NULL",
      owner,
    );
    if (existing.length >= 12)
      return { items: existing.map(assetView), total: existing.length };
    const dir = join(store.storage.temp, uid());
    await mkdir(dir, { recursive: true });
    const items = [];
    try {
      for (let i = 0; i < 6; i++) {
        const colors = [
          "#c8d4ae",
          "#d8c3a5",
          "#b1c9c7",
          "#ddc8bc",
          "#bcc7dc",
          "#d0d39f",
        ];
        const path = join(dir, `demo-${i}.png`);
        await sharp(
          Buffer.from(
            `<svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="1280" fill="${colors[i]}"/><circle cx="360" cy="600" r="230" fill="#ffffff" opacity=".3"/><rect x="245" y="360" width="230" height="420" rx="60" fill="#f5f2e7"/><rect x="300" y="290" width="120" height="85" rx="16" fill="#1c3a30"/><rect x="274" y="490" width="172" height="145" rx="4" fill="#1c3a30"/><text x="360" y="550" text-anchor="middle" font-family="sans-serif" font-size="25" fill="#e7edda">CROSSCUT</text><text x="360" y="590" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#e7edda">STUDIO SAMPLE</text><text x="60" y="100" font-family="sans-serif" font-size="20" fill="#17392c">DEMO / SHOT 0${i + 1}</text><text x="60" y="1110" font-family="sans-serif" font-size="52" fill="#17392c">EVERYDAY.</text><text x="60" y="1160" font-family="sans-serif" font-size="20" fill="#17392c">A fictional product. Original sample asset.</text></svg>`,
          ),
        )
          .png()
          .toFile(path);
        const image = await saveAsset(store, owner, path, {
          name: `示例 · 产品画面 ${i + 1}.png`,
          source: "demo",
          metadata: { demo: true },
        });
        items.push(image);
        const sub = join(dir, String(i));
        await mkdir(sub);
        const ctx: ExecutionContext = {
          jobId: uid(),
          toolId: "slideshow",
          input: {
            duration: 3,
            ratio: "9:16",
            resolution: "480p",
            sourceIds: [image.id],
          },
          assets: [
            {
              id: image.id,
              name: image.name,
              path,
              kind: "image",
              mime: "image/png",
              size: image.size,
              duration: null,
              width: 720,
              height: 1280,
            },
          ],
          outputDir: sub,
          signal: new AbortController().signal,
          onProgress: () => {},
          onRemoteTask: () => {},
          isCancellationRequested: () => false,
        };
        const result = await runMediaTask(ctx);
        for (const a of result.artifacts)
          items.push(
            await saveAsset(store, owner, a.path, {
              name: `示例 · 产品镜头 ${i + 1}.mp4`,
              source: "demo",
              metadata: { demo: true },
            }),
          );
      }
      return { items, total: items.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

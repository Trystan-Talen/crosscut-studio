import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { Store, type Row } from "./db.js";
import {
  AppError,
  now,
  uid,
  hash,
  token,
  passwordHash,
  passwordMatches,
} from "./core.js";
import { userView } from "./models.js";
import { registerDataRoutes } from "./routes-data.js";
import { SafeHttpError } from "./safe-http.js";
import { registerCreativeRoutes } from "./routes-creative.js";
declare module "fastify" {
  interface FastifyRequest {
    currentUser: Row | null;
  }
}
export const userId = (request: FastifyRequest) =>
  String(request.currentUser!.id);
export const routeId = (request: FastifyRequest) =>
  z.object({ id: z.string().uuid() }).parse(request.params).id;
export function workerStatus(store: Store) {
  const r = store.get("SELECT * FROM runtime WHERE key='worker'");
  return {
    online: !!r && Date.now() - Date.parse(String(r.updated_at)) < 60000,
    lastSeen: r?.updated_at ?? null,
  };
}
export async function createApp(
  options: { dataDir?: string; serveStatic?: boolean } = {},
) {
  const store = new Store(
    options.dataDir ?? resolve(process.env.CROSSCUT_DATA_DIR ?? "data"),
  );
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 60000,
  });
  app.decorateRequest("currentUser", null);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { fileSize: 250 * 1024 * 1024, files: 100, fields: 10, parts: 110 },
  });
  app.addHook("onRequest", async (req, reply) => {
    let host = "";
    try {
      host = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
    } catch {}
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
      throw new AppError(403, "INVALID_HOST", "本地服务不接受此主机名");
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        throw new AppError(403, "INVALID_ORIGIN", "请求来源无效");
      }
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
        !["4318", "5173", String(process.env.CROSSCUT_PORT ?? 4318)].includes(
          origin.port,
        )
      )
        throw new AppError(403, "INVALID_ORIGIN", "只允许从本地应用提交请求");
    }
    if (
      !req.url.startsWith("/api/") ||
      [
        "/api/health",
        "/api/auth/status",
        "/api/auth/setup",
        "/api/auth/login",
      ].includes(req.url.split("?")[0])
    )
      return;
    const raw = req.cookies.crosscut_session;
    if (raw) {
      const session = store.get(
        "SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
        hash(raw),
        now(),
      );
      if (session) req.currentUser = session;
    }
    if (!req.currentUser)
      throw new AppError(401, "UNAUTHENTICATED", "请先登录创作空间");
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError)
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    if (error instanceof SafeHttpError)
      return reply
        .status(error.code === "UNSAFE_URL" ? 400 : 502)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError)
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join("；"),
          details: error.issues.map((e) => ({
            path: e.path,
            message: e.message,
          })),
        },
      });
    const e = error as Error & { statusCode?: number; code?: string };
    if (e.code === "FST_REQ_FILE_TOO_LARGE")
      return reply.status(413).send({
        error: { code: "FILE_TOO_LARGE", message: "单个文件最大250MB" },
      });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)
      return reply
        .status(e.statusCode)
        .send({ error: { code: e.code ?? "BAD_REQUEST", message: e.message } });
    console.error("[API]", e.name, e.message.slice(0, 300));
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "操作未完成，请查看本地日志后重试",
      },
    });
  });
  const status = () => ({
    app: "crosscut",
    ok: true,
    version: "0.1.0",
    worker: workerStatus(store),
    sqliteVersion: store.get("SELECT sqlite_version() v")?.v,
  });
  app.get("/api/health", status);
  app.get("/api/auth/status", async (req) => {
    const raw = req.cookies.crosscut_session;
    const user = raw
      ? store.get(
          "SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
          hash(raw),
          now(),
        )
      : undefined;
    return {
      initialized: !!store.get("SELECT id FROM users LIMIT 1"),
      user: user ? userView(user) : null,
    };
  });
  const issueSession = (reply: FastifyReply, id: string) => {
    const raw = token();
    store.run("DELETE FROM sessions WHERE expires_at<?", now());
    store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(raw),
      id,
      new Date(Date.now() + 7 * 86400000).toISOString(),
    );
    reply.setCookie("crosscut_session", raw, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 86400,
      secure: false,
    });
  };
  app.post(
    "/api/auth/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = z
        .object({
          email: z.email().max(254),
          name: z.string().trim().min(1).max(80),
          password: z.string().min(10).max(200),
        })
        .strict()
        .parse(req.body);
      const id = uid();
      store.db.transaction(() => {
        if (store.get("SELECT id FROM users LIMIT 1"))
          throw new AppError(
            409,
            "ALREADY_INITIALIZED",
            "空间已初始化，请使用现有账号登录",
          );
        store.run(
          "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
          id,
          b.email.toLowerCase(),
          b.name,
          passwordHash(b.password),
          now(),
        );
      })();
      issueSession(reply, id);
      return {
        user: userView(store.get("SELECT * FROM users WHERE id=?", id)!),
      };
    },
  );
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(200),
        })
        .strict()
        .parse(req.body);
      const user = store.get(
        "SELECT * FROM users WHERE email=?",
        b.email.toLowerCase(),
      );
      if (!user || !passwordMatches(b.password, String(user.password_hash)))
        throw new AppError(401, "INVALID_CREDENTIALS", "邮箱或密码不正确");
      issueSession(reply, String(user.id));
      return { user: userView(user) };
    },
  );
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.cookies.crosscut_session)
      store.run(
        "DELETE FROM sessions WHERE token_hash=?",
        hash(req.cookies.crosscut_session),
      );
    reply.clearCookie("crosscut_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (req) => userView(req.currentUser!));
  app.post(
    "/api/me/password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = z
        .object({
          currentPassword: z.string().min(1).max(200),
          newPassword: z.string().min(10).max(200),
        })
        .strict()
        .parse(req.body);
      if (
        !passwordMatches(
          b.currentPassword,
          String(req.currentUser!.password_hash),
        )
      )
        throw new AppError(401, "INVALID_CREDENTIALS", "当前密码不正确");
      store.db.transaction(() => {
        store.run(
          "UPDATE users SET password_hash=? WHERE id=?",
          passwordHash(b.newPassword),
          userId(req),
        );
        store.run("DELETE FROM sessions WHERE user_id=?", userId(req));
      })();
      issueSession(reply, userId(req));
      return { ok: true };
    },
  );
  app.patch("/api/me", async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        profile: z.record(z.string().max(100), z.string().max(500)).optional(),
      })
      .strict()
      .parse(req.body);
    store.run(
      "UPDATE users SET name=?,profile=? WHERE id=?",
      b.name,
      JSON.stringify(b.profile ?? {}),
      userId(req),
    );
    return userView(store.get("SELECT * FROM users WHERE id=?", userId(req))!);
  });
  registerDataRoutes(app, store);
  registerCreativeRoutes(app, store);
  const dist = resolve("dist/web");
  if (options.serveStatic !== false && existsSync(dist)) {
    await app.register(staticFiles, {
      root: dist,
      prefix: "/",
      index: "index.html",
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "接口不存在" } })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => store.close());
  return { app, store };
}

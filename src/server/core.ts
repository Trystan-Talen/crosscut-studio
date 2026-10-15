import {
  createHash,
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { resolve, join, relative, sep } from "node:path";
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password: string, value: string): boolean {
  const [salt, digest] = value.split(":");
  if (!salt || !digest) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function token() {
  return randomBytes(32).toString("base64url");
}
export class Storage {
  readonly root: string;
  readonly media: string;
  readonly temp: string;
  readonly logs: string;
  readonly key: Buffer;
  constructor(directory: string) {
    this.root = resolve(directory);
    this.media = join(this.root, "media");
    this.temp = join(this.root, "tmp");
    this.logs = join(this.root, "logs");
    for (const p of [this.root, this.media, this.temp, this.logs])
      mkdirSync(p, { recursive: true, mode: 0o700 });
    const keyPath = join(this.root, "master.key");
    if (!existsSync(keyPath)) {
      try {
        writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
      } catch (e) {
        if (!existsSync(keyPath)) throw e;
      }
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("本地主密钥损坏，请从备份恢复");
    chmodSync(keyPath, 0o600);
  }
  path(key: string) {
    if (!/^[a-f0-9-]+\.[a-z0-9]+$/.test(key))
      throw new AppError(400, "INVALID_STORAGE_KEY", "无效的文件存储键");
    const p = resolve(this.media, key);
    if (!p.startsWith(this.media + sep))
      throw new AppError(400, "INVALID_PATH", "无效文件路径");
    if (
      existsSync(p) &&
      !realpathSync(p).startsWith(realpathSync(this.media) + sep)
    )
      throw new AppError(400, "INVALID_PATH", "不允许符号链接文件");
    return p;
  }
  encrypt(text: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return [
      iv.toString("base64"),
      c.getAuthTag().toString("base64"),
      body.toString("base64"),
    ].join(".");
  }
  decrypt(text: string) {
    const [iv, tag, body] = text.split(".");
    try {
      const c = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(iv, "base64"),
      );
      c.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        c.update(Buffer.from(body, "base64")),
        c.final(),
      ]).toString("utf8");
    } catch {
      throw new AppError(
        503,
        "SECRET_UNREADABLE",
        "服务商密钥不可读取，请重新配置",
      );
    }
  }
  assertTemporary(path: string) {
    const rel = relative(realpathSync(this.temp), realpathSync(path));
    if (rel.startsWith("..") || rel.startsWith(sep))
      throw new AppError(400, "INVALID_OUTPUT_PATH", "产物不在受控临时目录");
  }
}

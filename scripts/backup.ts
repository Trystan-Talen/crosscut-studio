import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
interface BackupFile {
  relative: string;
  size: number;
  sha256: string;
}
interface Manifest {
  format: "crosscut-backup-v1";
  createdAt: string;
  appVersion: string;
  sqliteVersion: string;
  secrets: "omitted" | "password-encrypted";
  files: BackupFile[];
}
interface EncryptedKey {
  format: "crosscut-key-v1";
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function safeRelative(relative: string): boolean {
  return (
    relative === "app.sqlite" ||
    relative === "secrets.enc.json" ||
    /^media\/[a-f0-9-]+\.[a-z0-9]+$/.test(relative)
  );
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function checkedFile(root: string, relative: string): Promise<string> {
  if (!safeRelative(relative))
    throw new Error(`备份文件路径不合法：${relative}`);
  const file = path.join(root, relative);
  const entry = await lstat(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    !inside(await realpath(root), await realpath(file))
  )
    throw new Error(`备份中不允许目录或符号链接文件：${relative}`);
  return file;
}
async function fileRecord(root: string, relative: string): Promise<BackupFile> {
  const file = await checkedFile(root, relative);
  return {
    relative,
    size: (await stat(file)).size,
    sha256: await sha256(file),
  };
}
function integrity(db: Database.Database): void {
  const rows = db.pragma("integrity_check") as { integrity_check: string }[];
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
    throw new Error("SQLite 完整性检查失败。");
  if ((db.pragma("foreign_key_check") as unknown[]).length)
    throw new Error("SQLite 外键检查失败。");
}
function encryptKey(key: Buffer, password: string): EncryptedKey {
  if (password.length < 12) throw new Error("备份密钥口令至少12个字符。");
  const salt = randomBytes(16),
    iv = randomBytes(12),
    derived = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    format: "crosscut-key-v1",
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
function decryptKey(encrypted: EncryptedKey, password: string): Buffer {
  if (
    encrypted.format !== "crosscut-key-v1" ||
    encrypted.algorithm !== "aes-256-gcm" ||
    encrypted.kdf !== "scrypt"
  )
    throw new Error("不支持的密钥备份格式。");
  try {
    const salt = Buffer.from(encrypted.salt, "base64"),
      iv = Buffer.from(encrypted.iv, "base64"),
      tag = Buffer.from(encrypted.tag, "base64"),
      body = Buffer.from(encrypted.ciphertext, "base64");
    if (
      salt.length !== 16 ||
      iv.length !== 12 ||
      tag.length !== 16 ||
      body.length !== 32
    )
      throw new Error("Invalid key envelope");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      scryptSync(password, salt, 32),
      iv,
    );
    decipher.setAuthTag(tag);
    const key = Buffer.concat([decipher.update(body), decipher.final()]);
    if (key.length !== 32) throw new Error("Invalid master key");
    return key;
  } catch {
    throw new Error("密钥备份口令错误或加密文件损坏；未执行恢复。");
  }
}

export async function createBackup(options: {
  dataDir: string;
  destination: string;
  password?: string;
}): Promise<Manifest> {
  const dataDir = await realpath(options.dataDir),
    destination = path.resolve(options.destination);
  if (inside(dataDir, destination))
    throw new Error("备份目标不能放在运行数据目录内部。");
  if (await exists(destination)) throw new Error("备份目标已存在，拒绝覆盖。");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const staging = path.join(
    path.dirname(destination),
    `.backup-${randomUUID()}`,
  );
  await mkdir(staging, { mode: 0o700 });
  let snapshot: Database.Database | undefined;
  try {
    const source = new Database(path.join(dataDir, "app.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await source.backup(path.join(staging, "app.sqlite"));
    } finally {
      source.close();
    }
    snapshot = new Database(path.join(staging, "app.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    integrity(snapshot);
    const assets = snapshot
      .prepare("SELECT storage_key,thumbnail_key,sha256 FROM assets")
      .all() as {
      storage_key: string;
      thumbnail_key: string | null;
      sha256: string;
    }[];
    const version = String(
      (snapshot.prepare("SELECT sqlite_version() v").get() as { v: string }).v,
    );
    const expected = new Map<string, string | undefined>();
    for (const asset of assets) {
      expected.set(`media/${asset.storage_key}`, asset.sha256);
      if (asset.thumbnail_key)
        expected.set(`media/${asset.thumbnail_key}`, undefined);
    }
    snapshot.close();
    snapshot = undefined;
    await mkdir(path.join(staging, "media"), { mode: 0o700 });
    const files: BackupFile[] = [await fileRecord(staging, "app.sqlite")];
    for (const [relative, hash] of expected) {
      const sourceFile = await checkedFile(dataDir, relative);
      await copyFile(sourceFile, path.join(staging, relative));
      const entry = await fileRecord(staging, relative);
      if (hash && entry.sha256 !== hash)
        throw new Error(`源素材校验失败：${relative}`);
      files.push(entry);
    }
    if (options.password !== undefined) {
      const keyPath = path.join(dataDir, "master.key");
      const info = await lstat(keyPath);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("主密钥不是普通文件。");
      const key = await readFile(keyPath);
      if (key.length !== 32) throw new Error("主密钥长度无效。");
      await writeFile(
        path.join(staging, "secrets.enc.json"),
        JSON.stringify(encryptKey(key, options.password)),
        { mode: 0o600 },
      );
      files.push(await fileRecord(staging, "secrets.enc.json"));
    }
    const pkg = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as { version: string };
    const manifest: Manifest = {
      format: "crosscut-backup-v1",
      createdAt: new Date().toISOString(),
      appVersion: pkg.version,
      sqliteVersion: version,
      secrets:
        options.password !== undefined ? "password-encrypted" : "omitted",
      files,
    };
    await writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(staging, "恢复说明.txt"),
      "请使用本项目 scripts/backup.ts restore 恢复到全新目录。不要直接覆盖运行中的数据。\n数据库与媒体已校验，默认不含主密钥；没有主密钥时需重新配置服务商。\n备份含账户和素材，应按个人数据保管。\n",
      { mode: 0o600 },
    );
    await verifyBackup(staging);
    await rename(staging, destination);
    return manifest;
  } catch (error) {
    snapshot?.close();
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(directory: string): Promise<Manifest> {
  const root = await realpath(directory),
    manifestPath = path.join(root, "manifest.json");
  const entry = await lstat(manifestPath);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > 10 * 1024 * 1024
  )
    throw new Error("备份清单不可读取或过大。");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (
    manifest.format !== "crosscut-backup-v1" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 100_000 ||
    !["omitted", "password-encrypted"].includes(manifest.secrets)
  )
    throw new Error("不支持或无效的备份清单。");
  const seen = new Set<string>();
  for (const expected of manifest.files) {
    if (
      !safeRelative(expected.relative) ||
      seen.has(expected.relative) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0 ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw new Error("备份清单含无效或重复文件。");
    seen.add(expected.relative);
    const actual = await fileRecord(root, expected.relative);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error(`备份文件校验失败：${expected.relative}`);
  }
  if (
    !seen.has("app.sqlite") ||
    (manifest.secrets === "password-encrypted") !== seen.has("secrets.enc.json")
  )
    throw new Error("备份数据库或密钥清单不完整。");
  const db = new Database(path.join(root, "app.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    integrity(db);
    const assets = db
      .prepare("SELECT storage_key,thumbnail_key FROM assets")
      .all() as { storage_key: string; thumbnail_key: string | null }[];
    for (const asset of assets)
      if (
        !seen.has(`media/${asset.storage_key}`) ||
        (asset.thumbnail_key && !seen.has(`media/${asset.thumbnail_key}`))
      )
        throw new Error("备份缺少数据库引用的素材。");
  } finally {
    db.close();
  }
  return manifest;
}

export async function restoreBackup(options: {
  backupDir: string;
  destination: string;
  password?: string;
}): Promise<{ files: number; secretsRestored: boolean }> {
  const backupDir = await realpath(options.backupDir),
    destination = path.resolve(options.destination),
    manifest = await verifyBackup(backupDir);
  if (inside(backupDir, destination) || inside(destination, backupDir))
    throw new Error("恢复目录不能包含备份，也不能位于备份内部。");
  if (await exists(destination)) {
    if (
      !(await lstat(destination)).isDirectory() ||
      (await readdir(destination)).length
    )
      throw new Error("恢复目标必须是全新或空目录，拒绝覆盖已有数据。");
  }
  let master: Buffer | undefined;
  if (manifest.secrets === "password-encrypted") {
    if (!options.password)
      throw new Error("该备份包含加密主密钥，恢复需要原备份口令。");
    master = decryptKey(
      JSON.parse(
        await readFile(path.join(backupDir, "secrets.enc.json"), "utf8"),
      ) as EncryptedKey,
      options.password,
    );
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const staging = path.join(
    path.dirname(destination),
    `.restore-${randomUUID()}`,
  );
  await mkdir(staging, { mode: 0o700 });
  let db: Database.Database | undefined;
  try {
    await mkdir(path.join(staging, "media"), { mode: 0o700 });
    for (const entry of manifest.files) {
      if (entry.relative === "secrets.enc.json") continue;
      await copyFile(
        await checkedFile(backupDir, entry.relative),
        path.join(staging, entry.relative),
      );
    }
    await writeFile(
      path.join(staging, "master.key"),
      master || randomBytes(32),
      { mode: 0o600 },
    );
    await chmod(path.join(staging, "master.key"), 0o600);
    db = new Database(path.join(staging, "app.sqlite"));
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      db!.prepare("DELETE FROM sessions").run();
      db!.prepare("DELETE FROM runtime").run();
      if (!master)
        db!.prepare("UPDATE providers SET secret='',verified=0").run();
      const date = new Date().toISOString();
      db!
        .prepare(
          "UPDATE jobs SET status='needs_review',error_code='RESTORED_REVIEW_REQUIRED',error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE status IN ('queued','running')",
        )
        .run(
          "已从备份恢复，执行暂停。请核对已有产物和服务商记录后手动重新创建任务，避免重复费用。",
          date,
        );
    })();
    integrity(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = undefined;
    await writeFile(
      path.join(staging, "restore-info.json"),
      JSON.stringify(
        {
          restoredAt: new Date().toISOString(),
          backupCreatedAt: manifest.createdAt,
          secretsRestored: !!master,
          sessionsInvalidated: true,
          pendingJobs: "needs_review",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (await exists(destination)) await rmdir(destination);
    await rename(staging, destination);
    return { files: manifest.files.length, secretsRestored: !!master };
  } catch (error) {
    db?.close();
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function passwordPrompt(label: string): Promise<string> {
  const fromEnv = process.env.CROSSCUT_BACKUP_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error(
      "备份口令需要交互终端；自动化可用CROSSCUT_BACKUP_PASSWORD环境变量，勿把口令放入命令参数。",
    );
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("已取消"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}
async function cli() {
  process.umask(0o077);
  const args = process.argv.slice(2),
    action = args[0] || "create";
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const dataDir = path.resolve(
    projectRoot,
    option("--data") || process.env.CROSSCUT_DATA_DIR || "data",
  );
  if (action === "create") {
    let password: string | undefined;
    if (args.includes("--with-secrets")) {
      password = await passwordPrompt(
        "输入备份密钥口令（至少12字符，不回显）：",
      );
      if (
        !process.env.CROSSCUT_BACKUP_PASSWORD &&
        password !== (await passwordPrompt("再次输入口令："))
      )
        throw new Error("两次口令不一致。");
    }
    const destination = path.resolve(
      option("--out") ||
        path.join(
          projectRoot,
          "backups",
          new Date().toISOString().replace(/[:.]/g, "-"),
        ),
    );
    const manifest = await createBackup({ dataDir, destination, password });
    console.log(
      `备份成功：${destination}\n已校验 ${manifest.files.length} 个文件。${manifest.secrets === "omitted" ? "未导出主密钥；恢复后需重新配置服务商。" : "主密钥已用独立口令加密，请另行保管口令。"}`,
    );
  } else if (action === "verify") {
    const directory = args[1];
    if (!directory) throw new Error("用法：backup.ts verify <备份目录>");
    const manifest = await verifyBackup(directory);
    console.log(
      `校验通过：${manifest.files.length} 个文件，SQLite及素材引用完整。`,
    );
  } else if (action === "restore") {
    const backupDir = args[1],
      destination = option("--to");
    if (!backupDir || !destination)
      throw new Error("用法：backup.ts restore <备份目录> --to <全新目录>");
    const manifest = await verifyBackup(backupDir);
    const password =
      manifest.secrets === "password-encrypted"
        ? await passwordPrompt("输入该备份的密钥口令（不回显）：")
        : undefined;
    const result = await restoreBackup({ backupDir, destination, password });
    console.log(
      `恢复成功：${path.resolve(destination)}\n服务尚未启动。会话已失效；未完成任务已暂停待核对。${result.secretsRestored ? "原服务商主密钥已恢复。" : "请重新配置服务商密钥；历史外部任务请复用参数新建，不直接重试旧加密快照。"}`,
    );
  } else throw new Error("操作必须为 create / verify / restore。");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch((error) => {
    console.error(`备份/恢复未完成：${(error as Error).message}`);
    process.exitCode = 1;
  });

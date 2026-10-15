import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/server/db.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";

let root: string, store: Store, owner: string, assetKey: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "crosscut 备份 ' "));
  store = new Store(path.join(root, "数据"));
  owner = randomUUID();
  const now = new Date().toISOString();
  store.run(
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
    owner,
    "backup-test@example.test",
    "恢复测试",
    "test-only-hash",
    now,
  );
  store.run(
    "INSERT INTO sessions VALUES(?,?,?)",
    "fixture-session",
    owner,
    "2099-01-01",
  );
  store.run(
    "INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
    randomUUID(),
    owner,
    "中文项目",
    now,
    now,
  );
  assetKey = randomUUID() + ".png";
  const bytes = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "orange" },
  })
    .png()
    .toBuffer();
  await writeFile(store.storage.path(assetKey), bytes);
  store.run(
    "INSERT INTO assets(id,owner_id,name,kind,mime,size,storage_key,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    randomUUID(),
    owner,
    "图像.png",
    "image",
    "image/png",
    bytes.length,
    assetKey,
    createHash("sha256").update(bytes).digest("hex"),
    now,
  );
  store.run(
    "INSERT INTO providers(id,owner_id,name,kind,config,secret,updated_at) VALUES(?,?,?,?,?,?,?)",
    randomUUID(),
    owner,
    "离线测试",
    "openai",
    "{}",
    store.storage.encrypt("fixture-secret-only"),
    now,
  );
  const batch = randomUUID();
  store.run(
    "INSERT INTO batches VALUES(?,?,?,?,?)",
    batch,
    owner,
    randomUUID(),
    "fixture",
    now,
  );
  store.run(
    "INSERT INTO jobs(id,batch_id,owner_id,tool_id,title,input,provider_snapshot,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    randomUUID(),
    batch,
    owner,
    "tts",
    "待核对外部任务",
    "{}",
    store.storage.encrypt("{}"),
    "queued",
    now,
    now,
  );
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("consistent backup and conservative restoration", () => {
  it("backs up a live WAL database and restores verified media without secrets or automatic jobs", async () => {
    const backup = path.join(root, "备份"),
      destination = path.join(root, "恢复");
    const manifest = await createBackup({
      dataDir: store.storage.root,
      destination: backup,
    });
    expect(manifest.secrets).toBe("omitted");
    expect(manifest.files).toHaveLength(2);
    await verifyBackup(backup);
    await mkdir(destination);
    expect(
      await restoreBackup({ backupDir: backup, destination }),
    ).toMatchObject({ secretsRestored: false });
    const restored = new Store(destination);
    try {
      expect(restored.get("SELECT name FROM projects")?.name).toBe("中文项目");
      expect(restored.get("SELECT secret FROM providers")?.secret).toBe("");
      expect(restored.get("SELECT status FROM jobs")?.status).toBe(
        "needs_review",
      );
      expect(restored.get("SELECT count(*) n FROM sessions")?.n).toBe(0);
      expect(await readFile(restored.storage.path(assetKey))).toEqual(
        await readFile(store.storage.path(assetKey)),
      );
      expect(restored.storage.key.equals(store.storage.key)).toBe(false);
    } finally {
      restored.close();
    }
  });
  it("encrypts the master key and proves decryption after recovery; incorrect passwords write nothing", async () => {
    const backup = path.join(root, "密钥备份");
    await createBackup({
      dataDir: store.storage.root,
      destination: backup,
      password: "test-backup-password-2026",
    });
    expect(
      (await readFile(path.join(backup, "secrets.enc.json"), "utf8")).includes(
        store.storage.key.toString("hex"),
      ),
    ).toBe(false);
    await expect(
      restoreBackup({
        backupDir: backup,
        destination: path.join(root, "错误口令"),
        password: "wrong-password",
      }),
    ).rejects.toThrow("口令错误");
    await restoreBackup({
      backupDir: backup,
      destination: path.join(root, "完整恢复"),
      password: "test-backup-password-2026",
    });
    const restored = new Store(path.join(root, "完整恢复"));
    try {
      expect(
        restored.storage.decrypt(
          String(restored.get("SELECT secret FROM providers")?.secret),
        ),
      ).toBe("fixture-secret-only");
    } finally {
      restored.close();
    }
  });
  it("refuses tampered files and never overwrites existing user data", async () => {
    const backup = path.join(root, "校验备份");
    await createBackup({ dataDir: store.storage.root, destination: backup });
    const destination = path.join(root, "现有数据");
    await mkdir(destination);
    await writeFile(path.join(destination, "keep.txt"), "preserved");
    await expect(
      restoreBackup({ backupDir: backup, destination }),
    ).rejects.toThrow("拒绝覆盖");
    expect(await readFile(path.join(destination, "keep.txt"), "utf8")).toBe(
      "preserved",
    );
    await writeFile(path.join(backup, "media", assetKey), "tampered");
    await expect(verifyBackup(backup)).rejects.toThrow("校验失败");
  });
  it("rejects paths outside the backup rather than trusting a manifest", async () => {
    const backup = path.join(root, "路径备份");
    await createBackup({ dataDir: store.storage.root, destination: backup });
    const file = path.join(backup, "manifest.json"),
      manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.files.push({
      relative: "../outside",
      size: 1,
      sha256: "0".repeat(64),
    });
    await writeFile(file, JSON.stringify(manifest));
    await expect(verifyBackup(backup)).rejects.toThrow("无效");
  });
});

import { createReadStream } from "node:fs";
import {
  stat,
  copyFile,
  rename,
  unlink,
  readFile,
  mkdir,
  rm,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Store } from "./db.js";
import { AppError, now, uid } from "./core.js";
import { assetView } from "./models.js";
import { probeMedia, extractFrames } from "./media.js";
import type { Asset, ExecutionAsset, MediaKind } from "../shared/types.js";
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/ogg": "ogv",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/x-matroska": "mka",
  "text/plain": "txt",
  "application/json": "json",
  "application/x-subrip": "srt",
};
async function fileHash(path: string) {
  const h = createHash("sha256");
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest("hex");
}
export async function saveAsset(
  store: Store,
  userId: string,
  path: string,
  options: {
    name: string;
    source?: string;
    metadata?: Record<string, unknown>;
    allowDocument?: boolean;
    signal?: AbortSignal;
  },
): Promise<Asset> {
  store.storage.assertTemporary(path);
  const info = await stat(path);
  if (!info.isFile() || !info.size || info.size > 250 * 1024 * 1024)
    throw new AppError(400, "FILE_SIZE", "文件为空或超过250MB限制");
  let kind: MediaKind,
    mime: string,
    duration: number | null = null,
    width: number | null = null,
    height: number | null = null;
  const extension = extname(options.name).toLowerCase();
  if (extension === ".srt") {
    if (info.size > 2 * 1024 * 1024)
      throw new AppError(400, "FILE_SIZE", "字幕文件最大2MB");
    const s = await readFile(path, "utf8");
    if (
      !/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(s)
    )
      throw new AppError(400, "INVALID_SUBTITLE", "字幕文件没有有效的时间码");
    kind = "subtitle";
    mime = "application/x-subrip";
  } else if (
    options.allowDocument &&
    [".json", ".txt", ".md"].includes(extension)
  ) {
    if (info.size > 10 * 1024 * 1024)
      throw new AppError(400, "FILE_SIZE", "文档产物过大");
    if (extension === ".json") JSON.parse(await readFile(path, "utf8"));
    kind = "document";
    mime = extension === ".json" ? "application/json" : "text/plain";
  } else {
    let probe;
    try {
      probe = await probeMedia(path, options.signal);
    } catch {
      throw new AppError(
        400,
        "INVALID_MEDIA",
        "无法解析文件，请上传真实且未损坏的图片、视频或音频",
      );
    }
    kind = probe.kind;
    mime = probe.mime;
    duration = probe.duration ?? null;
    width = probe.width ?? null;
    height = probe.height ?? null;
    if (!["image", "video", "audio"].includes(kind) || !extensions[mime])
      throw new AppError(
        400,
        "UNSUPPORTED_MEDIA",
        `暂不支持此媒体格式：${mime}`,
      );
    if (
      width &&
      height &&
      (width > 8192 || height > 8192 || width * height > 36e6)
    )
      throw new AppError(
        400,
        "PIXEL_LIMIT",
        "图片或视频尺寸超过安全上限8192边长/3600万像素",
      );
    if (duration && duration > 36000)
      throw new AppError(400, "DURATION_LIMIT", "单个媒体最长10小时");
  }
  const id = uid();
  const key = `${id}.${extensions[mime] ?? "bin"}`;
  const destination = store.storage.path(key);
  const staged = destination + ".partial";
  let thumbnail: string | null = null;
  try {
    await copyFile(path, staged);
    await rename(staged, destination);
    if (kind === "image") {
      thumbnail = `${uid()}.jpg`;
      await sharp(path, { limitInputPixels: 36e6 })
        .rotate()
        .resize(640, 480, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toFile(store.storage.path(thumbnail));
    } else if (kind === "video") {
      const thumbDir = join(store.storage.temp, uid());
      try {
        await mkdir(thumbDir, { recursive: true });
        const frames = await extractFrames(
          {
            id,
            name: options.name,
            path,
            kind,
            mime,
            size: info.size,
            duration,
            width,
            height,
          },
          thumbDir,
          1,
          options.signal,
        );
        if (frames[0]) {
          thumbnail = `${uid()}.jpg`;
          await sharp(frames[0].path)
            .resize(640, 480, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 78 })
            .toFile(store.storage.path(thumbnail));
        }
      } catch {
        if (thumbnail)
          await unlink(store.storage.path(thumbnail)).catch(() => {});
        thumbnail =
          null; /* Preview is optional; the validated source remains usable. */
      } finally {
        await rm(thumbDir, { recursive: true, force: true });
      }
    }
    if (options.signal?.aborted)
      throw new AppError(400, "CANCELLED", "媒体处理已取消");
    store.run(
      "INSERT INTO assets(id,owner_id,name,kind,mime,size,duration,width,height,storage_key,thumbnail_key,tags,source,sha256,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      userId,
      options.name.slice(0, 255),
      kind,
      mime,
      info.size,
      duration,
      width,
      height,
      key,
      thumbnail,
      "[]",
      options.source ?? "upload",
      await fileHash(path),
      JSON.stringify(options.metadata ?? {}),
      now(),
    );
    return assetView(store.get("SELECT * FROM assets WHERE id=?", id)!);
  } catch (e) {
    await unlink(destination).catch(() => {});
    await unlink(staged).catch(() => {});
    if (thumbnail) await unlink(store.storage.path(thumbnail)).catch(() => {});
    throw e;
  }
}
export function executionAsset(
  store: Store,
  row: ReturnType<Store["get"]>,
): ExecutionAsset {
  if (!row) throw new AppError(404, "ASSET_NOT_FOUND", "素材不存在");
  return {
    id: String(row.id),
    name: String(row.name),
    path: store.storage.path(String(row.storage_key)),
    kind: row.kind as MediaKind,
    mime: String(row.mime),
    size: Number(row.size),
    duration: row.duration === null ? null : Number(row.duration),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
  };
}

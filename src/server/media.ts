import "./runtime-env.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import {
  getSubtitleStyle,
  type SubtitleRenderStyle,
} from "../shared/subtitle-styles.js";
import type {
  ExecutionAsset,
  ExecutionContext,
  ExecutionResult,
  GeneratedArtifact,
  MediaKind,
  ToolInput,
} from "../shared/types.js";

export interface MediaProbe {
  kind: MediaKind;
  mime: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  format: string;
  frameRate?: number;
}
class MediaError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}
interface ProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  onTime?: (seconds: number) => void;
}
const MAX_FILE = 1024 ** 3;
const MAX_OUTPUT = 250 * 1024 ** 2;
const FPS = 30;
const FF = () => process.env.FFMPEG_PATH || "ffmpeg";
const FP = () => process.env.FFPROBE_PATH || "ffprobe";
const videoEncoding = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-threads",
  "2",
];
const audioEncoding = [
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-ar",
  "48000",
  "-ac",
  "2",
];
const baseArgs = [
  "-hide_banner",
  "-nostdin",
  "-y",
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
];

function cancelled(): MediaError {
  return new MediaError("CANCELLED", "媒体处理已取消");
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}
function number(value: unknown, fallback: number): number {
  if (value === undefined || value === "" || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new MediaError("INVALID_INPUT", "媒体参数必须为有限数字");
  return n;
}
function inRange(n: number, min: number, max: number, label: string): number {
  if (n < min || n > max)
    throw new MediaError("INVALID_INPUT", `${label}必须在 ${min}–${max} 之间`);
  return n;
}

/** No shell, no inherited stdin, bounded output, and process-group termination on cancellation. */
async function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  checkAbort(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      progressBuffer = "",
      failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          signal,
        );
      } catch {
        /* already exited */
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1500);
      killTimer.unref();
    };
    const onAbort = () => stop(cancelled());
    const timeout = setTimeout(
      () => stop(new MediaError("MEDIA_TIMEOUT", "媒体任务超过运行时限")),
      options.timeoutMs ?? 10 * 60_000,
    );
    timeout.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 ** 2)
        stop(new MediaError("MEDIA_OUTPUT_LIMIT", "媒体进程输出超过限制"));
      if (options.onTime) {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() || "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match) options.onTime(Number(match[1]) / 1_000_000);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-512 * 1024);
    });
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(
        new MediaError(
          "MEDIA_DEPENDENCY",
          `无法启动 ${path.basename(executable)}：${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new MediaError(
            "MEDIA_PROCESS_FAILED",
            `媒体处理失败（${code ?? "signal"}）：${stderr.slice(-2500)}`,
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}

async function checkedFile(filePath: string): Promise<string> {
  const resolved = await realpath(filePath);
  const file = await stat(resolved);
  if (!file.isFile() || file.size <= 0 || file.size > MAX_FILE)
    throw new MediaError("INVALID_MEDIA", "素材为空、不是文件或超过 1GB 上限");
  return resolved;
}
function durationOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse the bounded EBML header, not a filename or an unstructured byte search. */
function ebmlDocType(header: Buffer): "matroska" | "webm" {
  const invalid = () =>
    new MediaError("INVALID_MEDIA", "EBML 容器头或 DocType 无效");
  function vint(
    offset: number,
    identifier = false,
  ): { value: number; next: number } {
    const first = header[offset];
    if (!first) throw invalid();
    let length = 1,
      marker = 0x80;
    while (!(first & marker) && length <= 8) {
      marker >>= 1;
      length++;
    }
    if (length > (identifier ? 4 : 8) || offset + length > header.length)
      throw invalid();
    let value = BigInt(identifier ? first : first & (marker - 1));
    for (let index = 1; index < length; index++)
      value = value * 256n + BigInt(header[offset + index]!);
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      (!identifier && value === (1n << BigInt(7 * length)) - 1n)
    )
      throw invalid();
    return { value: Number(value), next: offset + length };
  }
  const id = vint(0, true);
  if (id.value !== 0x1a45dfa3) throw invalid();
  const size = vint(id.next),
    end = size.next + size.value;
  if (end > header.length) throw invalid();
  let cursor = size.next,
    docType: string | undefined;
  while (cursor < end) {
    const element = vint(cursor, true),
      length = vint(element.next),
      next = length.next + length.value;
    if (next > end) throw invalid();
    if (element.value === 0x4282) {
      if (docType !== undefined || length.value < 1 || length.value > 32)
        throw invalid();
      docType = header.toString("utf8", length.next, next).replace(/\0+$/, "");
    }
    cursor = next;
  }
  if (docType !== "matroska" && docType !== "webm") throw invalid();
  return docType;
}

/** Probes content, not extensions; .part downloads are supported. */
export async function probeMedia(
  filePath: string,
  signal?: AbortSignal,
): Promise<MediaProbe> {
  checkAbort(signal);
  const file = await checkedFile(filePath);
  const handle = await open(file, "r");
  const prefix = Buffer.alloc(64 * 1024);
  let header: Buffer;
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    header = prefix.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const likelyImage =
    header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.toString("ascii", 0, 6).startsWith("GIF8") ||
    (header.toString("ascii", 0, 4) === "RIFF" &&
      header.toString("ascii", 8, 12) === "WEBP");
  if (likelyImage) {
    const info = await sharp(file, { limitInputPixels: 60_000_000 }).metadata();
    if (!info.width || !info.height || !info.format)
      throw new MediaError("INVALID_MEDIA", "图片没有有效尺寸");
    await sharp(file, { limitInputPixels: 60_000_000 }).stats();
    checkAbort(signal);
    return {
      kind: "image",
      mime: `image/${info.format}`,
      width: info.width,
      height: info.height,
      duration: null,
      hasAudio: false,
      format: info.format,
    };
  }
  if (
    [".srt", ".vtt"].includes(path.extname(file).toLowerCase()) &&
    (await stat(file)).size <= 2 * 1024 * 1024
  ) {
    const text = await readFile(file, "utf8");
    if (!text.includes("-->"))
      throw new MediaError("INVALID_MEDIA", "字幕文件不包含有效时间码");
    return {
      kind: "subtitle",
      mime:
        path.extname(file).toLowerCase() === ".vtt"
          ? "text/vtt"
          : "application/x-subrip",
      duration: null,
      width: null,
      height: null,
      hasAudio: false,
      format: path.extname(file).slice(1),
    };
  }
  const { stdout } = await runProcess(
    FP(),
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ],
    { signal, timeoutMs: 30_000 },
  );
  const data = JSON.parse(stdout) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      disposition?: { attached_pic?: number };
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
    }[];
    format?: {
      format_name?: string;
      duration?: string;
      tags?: { major_brand?: string };
    };
  };
  const video = data.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const format = data.format?.format_name || "";
  const duration =
    durationOf(data.format?.duration) ??
    durationOf(video?.duration) ??
    durationOf(audio?.duration);
  const containers = format.split(",");
  const ebml =
    containers.includes("matroska") || containers.includes("webm")
      ? ebmlDocType(header)
      : undefined;
  if (
    ebml === "webm" &&
    data.streams?.some(
      (stream) =>
        (stream.codec_type === "video" &&
          !stream.disposition?.attached_pic &&
          !["vp8", "vp9", "av1"].includes(stream.codec_name || "")) ||
        (stream.codec_type === "audio" &&
          !["vorbis", "opus"].includes(stream.codec_name || "")),
    )
  )
    throw new MediaError(
      "INVALID_MEDIA",
      "WebM 容器中的编解码器不符合 WebM 格式；请使用真实 MKV 或转为 MP4",
    );
  if (
    !containers.some((item) =>
      [
        "mov",
        "mp4",
        "m4a",
        "3gp",
        "3g2",
        "mj2",
        "webm",
        "matroska",
        "avi",
        "mp3",
        "wav",
        "flac",
        "ogg",
        "aac",
      ].includes(item),
    ) ||
    (video && (!video.width || !video.height))
  )
    throw new MediaError("INVALID_MEDIA", "媒体容器或画面尺寸无效");
  if (!duration || (!video && !audio))
    throw new MediaError("INVALID_MEDIA", "不是可播放的图像、音频或视频");
  await runProcess(
    FF(),
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      file,
      "-t",
      "0.1",
      "-map",
      video ? "0:v:0" : "0:a:0",
      "-f",
      "null",
      "-",
    ],
    { signal, timeoutMs: 30_000 },
  );
  const mime = ebml
    ? `${video ? "video" : "audio"}/${ebml === "webm" ? "webm" : "x-matroska"}`
    : video
      ? data.format?.tags?.major_brand?.trim() === "qt"
        ? "video/quicktime"
        : containers.includes("ogg")
          ? "video/ogg"
          : containers.includes("avi")
            ? "video/x-msvideo"
            : "video/mp4"
      : format.includes("mp3")
        ? "audio/mpeg"
        : format.includes("wav")
          ? "audio/wav"
          : format.includes("flac")
            ? "audio/flac"
            : format.includes("ogg")
              ? "audio/ogg"
              : format.includes("aac")
                ? "audio/aac"
                : "audio/mp4";
  const rateParts = (
    video?.avg_frame_rate ||
    video?.r_frame_rate ||
    "0/1"
  ).split("/");
  const rate = Number(rateParts[0]) / Number(rateParts[1]);
  const rotation = Number(
      video?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
        video?.tags?.rotate ??
        0,
    ),
    swapped = Math.abs(rotation) % 180 === 90;
  return {
    kind: video ? "video" : "audio",
    mime,
    duration,
    width: (swapped ? video?.height : video?.width) ?? null,
    height: (swapped ? video?.width : video?.height) ?? null,
    hasAudio: !!audio,
    format: ebml || format,
    ...(Number.isFinite(rate) && rate > 0 ? { frameRate: rate } : {}),
  };
}

/** Validate every stream frame before accepting a remotely generated artifact. */
export async function validateMediaFile(
  file: string,
  signal?: AbortSignal,
): Promise<void> {
  const source = await checkedFile(file);
  await runProcess(
    FF(),
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      source,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
}

export async function extractFrames(
  asset: ExecutionAsset,
  dir: string,
  count = 8,
  signal?: AbortSignal,
): Promise<{ path: string; time: number }[]> {
  checkAbort(signal);
  inRange(count, 1, 60, "抽帧数量");
  if (!Number.isInteger(count))
    throw new MediaError("INVALID_INPUT", "抽帧数量必须为整数");
  await mkdir(dir, { recursive: true });
  const source = await checkedFile(asset.path),
    info = await probeMedia(source, signal);
  if (info.kind !== "video" || !info.duration)
    throw new MediaError("INVALID_MEDIA", "关键帧提取需要真实视频");
  const result: { path: string; time: number }[] = [];
  for (let i = 0; i < count; i++) {
    checkAbort(signal);
    const time = Math.max(
      0,
      Math.min(
        info.duration - 1 / (info.frameRate || 4) - 0.002,
        (info.duration * (i + 0.5)) / count,
      ),
    );
    const target = path.join(dir, `frame-${randomUUID()}.jpg`);
    await runProcess(
      FF(),
      [
        ...baseArgs,
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        String(time),
        "-i",
        source,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2,format=yuvj420p",
        "-c:v",
        "mjpeg",
        "-threads",
        "1",
        "-q:v",
        "3",
        "-update",
        "1",
        target,
      ],
      { signal, timeoutMs: 60_000 },
    );
    await probeMedia(target, signal);
    result.push({ path: target, time });
  }
  return result;
}

export async function extractAudio(
  asset: ExecutionAsset,
  dir: string,
  signal?: AbortSignal,
  options: { sampleRate?: 16000 | 44100 | 48000; channels?: 1 | 2 } = {},
): Promise<string> {
  checkAbort(signal);
  await mkdir(dir, { recursive: true });
  const source = await checkedFile(asset.path),
    info = await probeMedia(source, signal);
  if (!info.hasAudio)
    throw new MediaError("NO_AUDIO", "素材没有音轨，无法转写");
  const target = path.join(dir, `audio-${randomUUID()}.wav`);
  await runProcess(
    FF(),
    [
      ...baseArgs,
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      source,
      "-vn",
      "-ac",
      String(options.channels ?? 1),
      "-ar",
      String(options.sampleRate ?? 16000),
      "-c:a",
      "pcm_s16le",
      "-fs",
      String(MAX_OUTPUT),
      target,
    ],
    { signal },
  );
  const output = await probeMedia(target, signal);
  if (
    !output.hasAudio ||
    !output.duration ||
    Math.abs(output.duration - (info.duration ?? 0)) > 0.25
  )
    throw new MediaError("INVALID_OUTPUT", "音轨提取不完整");
  return target;
}

function geometry(
  input: ToolInput,
  info?: MediaProbe,
): { width: number; height: number } {
  const ratio = String(
    input.ratio && input.ratio !== "auto"
      ? input.ratio
      : info?.width && info.height
        ? `${info.width}:${info.height}`
        : "9:16",
  );
  const match = /^(\d{1,5}):(\d{1,5})$/.exec(ratio);
  if (!match || !Number(match[1]) || !Number(match[2]))
    throw new MediaError("INVALID_INPUT", "视频比例必须为有效的宽:高");
  const aspect = inRange(
    Number(match[1]) / Number(match[2]),
    0.25,
    4,
    "视频宽高比",
  );
  const short =
    input.resolution && input.resolution !== "auto"
      ? number(String(input.resolution).replace(/p$/i, ""), 480)
      : Math.min(info?.width || 480, info?.height || 480, 1080);
  inRange(short, 64, 1080, "输出短边像素");
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return aspect >= 1
    ? { width: even(short * aspect), height: even(short) }
    : { width: even(short), height: even(short / aspect) };
}
const fitFilter = (size: { width: number; height: number }) =>
  `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1,fps=${FPS}`;
function selection(
  ctx: ExecutionContext,
  kinds: MediaKind[],
  key = "sourceIds",
): ExecutionAsset[] {
  const ids = ctx.input[key];
  const pool =
    Array.isArray(ids) && ids.length
      ? ids.map((id) => {
          const found = ctx.assets.find((a) => a.id === id);
          if (!found)
            throw new MediaError("ASSET_NOT_FOUND", "任务素材不存在或未授权");
          return found;
        })
      : ctx.assets;
  return pool.filter((a) => kinds.includes(a.kind));
}
async function firstSource(
  ctx: ExecutionContext,
  kinds: MediaKind[],
): Promise<{ asset: ExecutionAsset; info: MediaProbe }> {
  const asset = selection(ctx, kinds)[0];
  if (!asset) throw new MediaError("INVALID_INPUT", "请选择需要处理的素材");
  const info = await probeMedia(asset.path, ctx.signal);
  if (!kinds.includes(info.kind))
    throw new MediaError("INVALID_MEDIA", "实际素材类型与所选工具不匹配");
  return { asset, info };
}
function shuffled<T>(items: T[], seed: string): T[] {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0) || 1;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
async function progress(
  ctx: ExecutionContext,
  n: number,
  message: string,
): Promise<void> {
  checkAbort(ctx.signal);
  await ctx.onProgress(n, message);
}
function inputArgs(file: string): string[] {
  return ["-protocol_whitelist", "file,pipe", "-i", file];
}

interface Cue {
  start: number;
  end: number;
  text: string;
  role?: "title" | "description" | "selling-point";
}
function parseTime(value: string): number {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{3})$/.exec(
    value.trim(),
  );
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59)
    throw new MediaError("INVALID_SUBTITLE", "字幕时间码格式错误");
  return (
    Number(match[1] || 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}
function parseSrt(text: string, duration: number): Cue[] {
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) {
      if (block.trim() === "WEBVTT") continue;
      throw new MediaError("INVALID_SUBTITLE", "每个字幕段必须有时间码");
    }
    const parts = lines[index]!.split("-->");
    const start = parseTime(parts[0]!),
      end = parseTime(parts[1]!.trim().split(/\s+/)[0]!);
    const content = lines
      .slice(index + 1)
      .join("\n")
      .replace(/<\/?(?:b|i|u|font)(?:\s[^>]*)?>/gi, "")
      .trim();
    if (
      !content ||
      content.length > 500 ||
      start < 0 ||
      end <= start ||
      start >= duration ||
      end > duration + 0.1
    )
      throw new MediaError(
        "INVALID_SUBTITLE",
        "字幕内容为空、过长或时间超出视频范围",
      );
    cues.push({ start, end: Math.min(duration, end), text: content });
  }
  cues.sort((a, b) => a.start - b.start);
  if (cues.length === 0 || cues.length > 300)
    throw new MediaError("INVALID_SUBTITLE", "字幕段数量必须为1–300");
  if (cues.some((cue, i) => i > 0 && cue.start < cues[i - 1]!.end - 0.001))
    throw new MediaError("INVALID_SUBTITLE", "字幕时间段重叠，请先调整时间轴");
  return cues;
}
async function cuesFor(
  ctx: ExecutionContext,
  duration: number,
  required: boolean,
): Promise<Cue[]> {
  let text = String(ctx.input.subtitleText || "").trim();
  const subtitle = selection(ctx, ["subtitle"], "subtitleIds")[0];
  if (subtitle) {
    if ((await stat(subtitle.path)).size > 2 * 1024 * 1024)
      throw new MediaError("INVALID_SUBTITLE", "字幕文件超过2MB");
    text = await readFile(await checkedFile(subtitle.path), "utf8");
  }
  if (!text && ctx.toolId === "remix" && ctx.input.subtitles)
    return remixCues(ctx.input, duration);
  if (!text) {
    if (required)
      throw new MediaError("INVALID_SUBTITLE", "请输入字幕原文或上传SRT");
    return [];
  }
  if (!subtitle && text.length > 30_000)
    throw new MediaError("INVALID_SUBTITLE", "字幕原文超过30000字符");
  if (text.includes("-->")) return parseSrt(text, duration);
  const lines = text
    .split(/\n+|(?<=[。！？!?])\s*|,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length > 100 || lines.some((line) => line.length > 500))
    throw new MediaError(
      "INVALID_SUBTITLE",
      "请将字幕分成不超过100个短句，每句最多500字符",
    );
  return lines.map((line, i) => ({
    start: (duration * i) / lines.length,
    end: (duration * (i + 1)) / lines.length,
    text: line,
  }));
}
function captionChunks(text: string): string[] {
  const result: string[] = [];
  for (const sentence of text
    .split(/\n+|(?<=[。！？!?.;；])\s*|[,，]+/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    let current = "",
      width = 0;
    for (const token of sentence.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+\s*|\s+/gu,
    ) ?? []) {
      for (const character of token.length > 36 ? [...token] : [token]) {
        const units = [...character].reduce(
          (sum, c) =>
            sum +
            (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
              c,
            )
              ? 2
              : 1),
          0,
        );
        if (current.trim() && width + units > 36) {
          result.push(current.trim());
          current = "";
          width = 0;
        }
        current += character;
        width += units;
      }
    }
    if (current.trim()) result.push(current.trim());
  }
  return result;
}
function remixCues(input: ToolInput, duration: number): Cue[] {
  const segments: {
    text: string;
    role: NonNullable<Cue["role"]>;
    minimum: number;
  }[] = [];
  for (const [key, role] of [
    ["productName", "title"],
    ["description", "description"],
    ["sellingPoints", "selling-point"],
  ] as const) {
    for (const text of captionChunks(String(input[key] || ""))) {
      const cjk = (
        text.match(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        ) ?? []
      ).length;
      const otherWords = text
        .replace(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
          " ",
        )
        .split(/\s+/)
        .filter((value) => /[\p{L}\p{N}]/u.test(value)).length;
      segments.push({
        text,
        role,
        minimum: Math.max(
          role === "title" ? 1.8 : 1.4,
          cjk / 5 + otherWords / 3,
        ),
      });
    }
  }
  if (!segments.length)
    throw new MediaError("INVALID_SUBTITLE", "请填写产品名称、描述和卖点字幕");
  const minimum = segments.reduce((sum, segment) => sum + segment.minimum, 0);
  if (minimum > duration)
    throw new MediaError(
      "CAPTION_TOO_LONG",
      `产品名称、描述和卖点至少需要约 ${Math.ceil(minimum)} 秒才能读完；当前仅 ${duration} 秒，请缩短文案或增加时长。不会截断或丢弃文案。`,
    );
  let cursor = 0;
  return segments.map((segment, index) => {
    const start = cursor;
    cursor =
      index === segments.length - 1
        ? duration
        : cursor + (segment.minimum / minimum) * duration;
    return { text: segment.text, role: segment.role, start, end: cursor };
  });
}
async function fontFile(): Promise<string | undefined> {
  if (process.env.CROSSCUT_FONT_PATH) {
    try {
      await access(process.env.CROSSCUT_FONT_PATH);
      return process.env.CROSSCUT_FONT_PATH;
    } catch {
      throw new MediaError(
        "FONT_NOT_FOUND",
        "CROSSCUT_FONT_PATH指定的字体不可用",
      );
    }
  }
  const candidates = [
    process.env.CROSSCUT_FONT_PATH,
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  ].filter((f): f is string => !!f);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try platform font */
    }
  }
  return undefined;
}
const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function textEffect(
  image: Buffer,
  color: string,
  padding: number,
  dilation: number,
  blur: number,
): Promise<Buffer> {
  let mask = sharp(image).extractChannel(3).extend({
    top: padding,
    bottom: padding,
    left: padding,
    right: padding,
    background: "#000000",
  });
  if (dilation) mask = mask.dilate(dilation);
  if (blur) mask = mask.blur(blur);
  const alpha = await mask.raw().toBuffer({ resolveWithObject: true });
  return sharp({
    create: {
      width: alpha.info.width,
      height: alpha.info.height,
      channels: 3,
      background: color,
    },
  })
    .joinChannel(alpha.data, {
      raw: { width: alpha.info.width, height: alpha.info.height, channels: 1 },
    })
    .png()
    .toBuffer();
}
function horizontal(
  style: SubtitleRenderStyle,
  frameWidth: number,
  itemWidth: number,
): number {
  if (style.align === "left") return Math.round(frameWidth * 0.06);
  if (style.align === "right") return Math.round(frameWidth * 0.94 - itemWidth);
  return Math.round((frameWidth - itemWidth) / 2);
}

/** PNG subtitle timeline works on FFmpeg builds without libass/drawtext. */
async function captionTrack(
  cues: Cue[],
  size: { width: number; height: number },
  duration: number,
  dir: string,
  signal: AbortSignal,
  style = "bold",
): Promise<string> {
  const preset = getSubtitleStyle(style);
  if (!preset) throw new MediaError("INVALID_INPUT", "不支持的字幕风格");
  const design = preset.render,
    fontfile = await fontFile();
  if (!fontfile && cues.some((c) => /[\u3400-\u9fff]/.test(c.text)))
    throw new MediaError(
      "FONT_NOT_FOUND",
      "中文字幕需要可用中文字体；请配置CROSSCUT_FONT_PATH",
    );
  const blank = path.join(dir, "caption-empty.png");
  await sharp({
    create: {
      width: size.width,
      height: size.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toFile(blank);
  const timeline: string[] = ["ffconcat version 1.0"];
  const append = (name: string, seconds: number) => {
    if (seconds > 0.00001)
      timeline.push(`file '${name}'`, `duration ${seconds.toFixed(6)}`);
  };
  let cursor = 0;
  for (let i = 0; i < cues.length; i++) {
    checkAbort(signal);
    const cue = cues[i]!;
    append("caption-empty.png", cue.start - cursor);
    const fontSize = Math.max(
      18,
      Math.round(
        size.height * design.sizeRatio * (cue.role === "title" ? 1.12 : 1),
      ),
    );
    const textImage = await sharp({
      text: {
        text: `<span foreground="${design.color}" weight="${design.weight}" style="${design.italic ? "italic" : "normal"}">${xml(cue.text)}</span>`,
        font: `${design.fontFamily} ${fontSize}`,
        fontfile,
        width: Math.round(size.width * 0.8),
        align: design.align === "center" ? "centre" : design.align,
        rgba: true,
        wrap: "word-char",
        spacing: Math.max(2, Math.round(fontSize * 0.1)),
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (textImage.info.height > size.height * 0.32)
      throw new MediaError(
        "INVALID_SUBTITLE",
        "字幕超过画面高度的三分之一，请拆成更短的字幕段",
      );
    const pad = Math.max(6, Math.round(fontSize * design.paddingRatio));
    const width = Math.min(
        Math.round(size.width * 0.94),
        textImage.info.width + 2 * pad,
      ),
      height = textImage.info.height + 2 * pad;
    const top = Math.max(
      0,
      Math.round(
        design.position === "top"
          ? size.height * 0.06
          : design.position === "center"
            ? (size.height - height) / 2
            : size.height - height - size.height * 0.06,
      ),
    );
    const border = Math.max(0, Math.round(fontSize * design.borderRatio)),
      radius = Math.round(fontSize * design.radiusRatio),
      inset = border / 2;
    const background = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${inset}" y="${inset}" width="${width - border}" height="${height - border}" rx="${radius}" fill="${design.background}" fill-opacity="${design.backgroundOpacity}" stroke="${design.borderColor}" stroke-width="${border}"/></svg>`,
    );
    const left = horizontal(design, size.width, width),
      textLeft = left + Math.round((width - textImage.info.width) / 2),
      textTop = top + pad;
    const layers: OverlayOptions[] = [{ input: background, left, top }];
    if (design.shadowRatio) {
      const offset = Math.max(1, Math.round(fontSize * design.shadowRatio)),
        padding = offset * 4;
      layers.push({
        input: await textEffect(
          textImage.data,
          design.shadowColor,
          padding,
          0,
          Math.max(0.3, offset * 0.7),
        ),
        left: textLeft - padding + offset,
        top: textTop - padding + offset,
      });
    }
    if (design.outlineRatio) {
      const outline = Math.max(1, Math.round(fontSize * design.outlineRatio)),
        padding = outline + 1;
      layers.push({
        input: await textEffect(
          textImage.data,
          design.outlineColor,
          padding,
          outline,
          0,
        ),
        left: textLeft - padding,
        top: textTop - padding,
      });
    }
    layers.push({ input: textImage.data, left: textLeft, top: textTop });
    const name = `caption-${i}.png`;
    await sharp(blank).composite(layers).png().toFile(path.join(dir, name));
    append(name, cue.end - cue.start);
    cursor = cue.end;
  }
  append("caption-empty.png", duration - cursor);
  timeline.push("file 'caption-empty.png'");
  const manifest = path.join(dir, "captions.ffconcat");
  await writeFile(manifest, timeline.join("\n") + "\n");
  return manifest;
}

async function encodeVideo(
  source: string,
  destination: string,
  size: { width: number; height: number },
  duration: number,
  ctx: ExecutionContext,
  dir: string,
  options: {
    start?: number;
    cues?: Cue[];
    filter?: string;
    audio?: boolean;
  } = {},
): Promise<void> {
  const args = [...baseArgs];
  if (options.start) args.push("-ss", String(options.start));
  args.push(...inputArgs(source));
  const filter = options.filter || fitFilter(size);
  if (options.cues?.length) {
    const track = await captionTrack(
      options.cues,
      size,
      duration,
      dir,
      ctx.signal,
      String(ctx.input.subtitleStyle || "bold"),
    );
    args.push(
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      track,
      "-filter_complex",
      `[0:v]${filter}[base];[1:v]format=rgba[sub];[base][sub]overlay=0:0:eof_action=pass:repeatlast=1[v]`,
      "-map",
      "[v]",
    );
  } else args.push("-vf", filter, "-map", "0:v:0");
  const volume = inRange(number(ctx.input.volume, 100), 0, 200, "音量") / 100;
  args.push(
    "-map",
    "0:a:0?",
    ...videoEncoding,
    ...audioEncoding,
    "-af",
    `volume=${volume},apad`,
    "-t",
    String(duration),
    "-r",
    String(FPS),
    "-movflags",
    "+faststart",
    "-fs",
    String(MAX_OUTPUT),
    "-progress",
    "pipe:1",
    destination,
  );
  await runProcess(FF(), args, {
    signal: ctx.signal,
    onTime: (seconds) => {
      void Promise.resolve(
        ctx.onProgress(
          Math.min(94, 45 + (seconds / duration) * 49),
          "正在编码真实视频",
        ),
      ).catch(() => {});
    },
  });
}

async function finalizeVideo(
  file: string,
  ctx: ExecutionContext,
  name: string,
  expected?: { duration: number; width?: number; height?: number },
  metadata: Record<string, unknown> = {},
): Promise<GeneratedArtifact> {
  const info = await probeMedia(file, ctx.signal);
  checkAbort(ctx.signal);
  if (info.kind !== "video" || !info.duration)
    throw new MediaError("INVALID_OUTPUT", "生成文件不是有效视频");
  if (
    expected &&
    (Math.abs(info.duration - expected.duration) > 0.08 ||
      (expected.width && info.width !== expected.width) ||
      (expected.height && info.height !== expected.height))
  )
    throw new MediaError("INVALID_OUTPUT", "实际视频时长或尺寸不符合提交参数");
  await runProcess(
    FF(),
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      ...inputArgs(file),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "-",
    ],
    { signal: ctx.signal },
  );
  const destination = path.join(ctx.outputDir, name);
  await rename(file, destination);
  return {
    path: destination,
    kind: "video",
    mime: name.endsWith(".mov") ? "video/quicktime" : "video/mp4",
    name,
    metadata: { ...info, ...metadata },
  };
}

async function normalizedClip(
  asset: ExecutionAsset,
  target: string,
  size: { width: number; height: number },
  duration: number,
  signal: AbortSignal,
  image = false,
): Promise<void> {
  const source = await checkedFile(asset.path),
    info = await probeMedia(source, signal);
  if ((image && info.kind !== "image") || (!image && info.kind !== "video"))
    throw new MediaError("INVALID_MEDIA", "混剪素材类型不正确");
  const args = [
    ...baseArgs,
    ...(image ? ["-loop", "1"] : ["-stream_loop", "-1"]),
    ...inputArgs(source),
  ];
  if (!info.hasAudio)
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-map",
    "0:v:0",
    "-map",
    info.hasAudio ? "0:a:0" : "1:a:0",
    "-vf",
    fitFilter(size),
    "-af",
    "aresample=48000,apad",
    ...videoEncoding,
    ...audioEncoding,
    "-t",
    String(duration),
    "-r",
    String(FPS),
    "-fs",
    String(MAX_OUTPUT),
    target,
  );
  await runProcess(FF(), args, { signal });
}

async function montage(
  ctx: ExecutionContext,
  dir: string,
  slideshow: boolean,
): Promise<ExecutionResult> {
  const assets = selection(
    ctx,
    [slideshow ? "image" : "video"],
    slideshow && Array.isArray(ctx.input.imageIds) ? "imageIds" : "sourceIds",
  );
  const min = slideshow ? 1 : 6,
    max = slideshow ? 30 : 100;
  if (assets.length < min || assets.length > max)
    throw new MediaError(
      "INVALID_INPUT",
      `需要 ${min}–${max} 个${slideshow ? "图片" : "视频"}素材`,
    );
  const sizes = await Promise.all(
    assets.map(async (a) => (await stat(await checkedFile(a.path))).size),
  );
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_FILE)
    throw new MediaError(
      "INVALID_INPUT",
      "单次混剪或图片成片素材合计不得超过1GB",
    );
  const duration = number(
    ctx.input.duration === "recommended" ? 30 : ctx.input.duration,
    slideshow ? 15 : 30,
  );
  const durationDetails = slideshow
    ? {}
    : {
        durationSelection: String(ctx.input.duration ?? "recommended"),
        resolvedDuration: duration,
        durationRule:
          (ctx.input.duration ?? "recommended") === "recommended"
            ? "本产品推荐时长固定为30秒，不代表自动判断最佳投放时长。"
            : "使用用户指定的视频时长。",
      };
  if (!slideshow && duration !== 15 && duration !== 30)
    throw new MediaError("INVALID_INPUT", "混剪时长仅支持15或30秒");
  inRange(duration, 1, 120, "视频时长");
  const size = geometry(
      ctx.input,
      ctx.input.ratio === "auto"
        ? await probeMedia(assets[0]!.path, ctx.signal)
        : undefined,
    ),
    ordered = slideshow ? assets : shuffled(assets, ctx.jobId);
  const cues =
    ctx.input.subtitles || (slideshow && ctx.input.subtitleText)
      ? await cuesFor(ctx, duration, true)
      : [];
  const selected = ordered.slice(
    0,
    slideshow ? 30 : Math.max(6, Math.floor(duration / 2)),
  );
  const totalFrames = Math.round(duration * FPS),
    baseFrames = Math.floor(totalFrames / selected.length);
  const files: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    await progress(
      ctx,
      5 + (i / selected.length) * 35,
      `正在标准化素材 ${i + 1}/${selected.length}`,
    );
    const name = `clip-${i}.mp4`;
    const frames = baseFrames + (i < totalFrames % selected.length ? 1 : 0);
    await normalizedClip(
      selected[i]!,
      path.join(dir, name),
      size,
      frames / FPS,
      ctx.signal,
      slideshow,
    );
    files.push(name);
  }
  const list = path.join(dir, "clips.ffconcat");
  await writeFile(
    list,
    ["ffconcat version 1.0", ...files.map((name) => `file '${name}'`)].join(
      "\n",
    ) + "\n",
  );
  const combined = path.join(dir, "combined.mp4");
  await runProcess(
    FF(),
    [
      ...baseArgs,
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      list,
      "-c",
      "copy",
      "-t",
      String(duration),
      combined,
    ],
    { signal: ctx.signal },
  );
  const file = path.join(dir, "result.mp4");
  await encodeVideo(combined, file, size, duration, ctx, dir, { cues });
  const captionInfo = {
    subtitleStyle: cues.length
      ? String(ctx.input.subtitleStyle || "bold")
      : "none",
    subtitleAnimation: "static",
    captionScript: cues,
    productFieldsUsage: slideshow
      ? "not-applicable"
      : cues.length
        ? "captioned"
        : "metadata-only",
    productFieldsExplanation: slideshow
      ? undefined
      : cues.length
        ? "产品名称、描述、卖点已依次进入原文字幕；不自动翻译。"
        : "字幕已关闭，产品名称、描述和卖点仅作项目资料保存，不影响随机选镜。",
    languageAction: "保留输入原文，不自动翻译",
  };
  const artifact = await finalizeVideo(
    file,
    ctx,
    slideshow ? "图片影片.mp4" : "批量混剪.mp4",
    { duration, ...size },
    {
      processing: "local",
      sourceOrder: selected.map((a) => a.id),
      seed: ctx.jobId,
      audioPolicy: "保留片段原音轨，无音轨片段补静音",
      subtitleSource: cues.length ? "用户提供原文" : "none",
      ...durationDetails,
      ...captionInfo,
    },
  );
  return {
    artifacts: [artifact],
    result: {
      mode: "local",
      sourceOrder: selected.map((a) => a.id),
      duration,
      actualDuration: artifact.metadata?.duration ?? duration,
      ...size,
      ...durationDetails,
      ...captionInfo,
    },
  };
}

async function transform(
  ctx: ExecutionContext,
  dir: string,
): Promise<ExecutionResult> {
  const { asset, info } = await firstSource(ctx, ["video", "audio"]);
  const source = await checkedFile(asset.path);
  let duration = info.duration!,
    start = 0;
  if (ctx.toolId === "trim") {
    start = number(ctx.input.start, 0);
    const end = number(ctx.input.end, duration);
    if (start < 0 || end > duration + 0.03 || end <= start)
      throw new MediaError(
        "INVALID_INPUT",
        "裁切范围必须位于素材内，结束时间大于开始时间",
      );
    duration = end - start;
  }
  await progress(ctx, 10, "已验证源文件，开始媒体处理");
  if (info.kind === "audio") {
    const format = String(ctx.input.format || "mp3");
    if (!["mp3", "wav"].includes(format))
      throw new MediaError("INVALID_INPUT", "音频转码支持MP3或WAV");
    const output = path.join(dir, `result.${format}`);
    const volume = inRange(number(ctx.input.volume, 100), 0, 200, "音量") / 100;
    await runProcess(
      FF(),
      [
        ...baseArgs,
        "-ss",
        String(start),
        ...inputArgs(source),
        "-vn",
        "-af",
        `volume=${volume}`,
        "-t",
        String(duration),
        "-c:a",
        format === "mp3" ? "libmp3lame" : "pcm_s16le",
        "-fs",
        String(MAX_OUTPUT),
        output,
      ],
      { signal: ctx.signal },
    );
    const actual = await probeMedia(output, ctx.signal);
    if (actual.kind !== "audio" || Math.abs(actual.duration! - duration) > 0.12)
      throw new MediaError("INVALID_OUTPUT", "音频输出校验失败");
    const destination = path.join(ctx.outputDir, `音频处理.${format}`);
    await rename(output, destination);
    return {
      artifacts: [
        {
          path: destination,
          kind: "audio",
          mime: format === "mp3" ? "audio/mpeg" : "audio/wav",
          name: path.basename(destination),
          metadata: actual as unknown as Record<string, unknown>,
        },
      ],
    };
  }
  const size = geometry(ctx.input, info);
  const format = String(ctx.input.format || "mp4");
  if (!["mp4", "mov"].includes(format))
    throw new MediaError("INVALID_INPUT", "视频输出支持MP4或MOV");
  const cues =
    ctx.toolId === "subtitle-burn" ? await cuesFor(ctx, duration, true) : [];
  let filter: string | undefined;
  if (ctx.toolId === "subtitle-remove") {
    const mode = String(ctx.input.mode || "");
    if (!["cover", "mask", "crop"].includes(mode))
      throw new MediaError(
        "UNSUPPORTED_CAPABILITY",
        "本地仅支持明确区域遮挡或裁切；无痕修复需要专用服务",
      );
    const regionY = inRange(
        number(ctx.input.regionY, 80),
        0,
        95,
        "区域顶部百分比",
      ),
      regionHeight = inRange(
        number(ctx.input.regionHeight, 20),
        1,
        100,
        "区域高度百分比",
      );
    if (regionY + regionHeight > 100)
      throw new MediaError("INVALID_INPUT", "字幕区域超过画面底部");
    const x = 0,
      y = Math.floor((info.height! * regionY) / 100),
      width = info.width!,
      height = Math.ceil((info.height! * regionHeight) / 100);
    if (
      ![x, y, width, height].every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > info.width! ||
      y + height > info.height!
    )
      throw new MediaError("INVALID_INPUT", "字幕区域须为画面内的整数像素矩形");
    if (mode === "crop") {
      const keepAbove = y >= info.height! - (y + height),
        cropY = keepAbove ? 0 : y + height,
        keepHeight = keepAbove ? y : info.height! - (y + height);
      if (keepHeight < 2)
        throw new MediaError(
          "INVALID_INPUT",
          "字幕区域占满画面，无法保留可用画面",
        );
      const cropWidth = Math.floor(width / 2) * 2;
      const cropHeight = Math.floor(keepHeight / 2) * 2;
      Object.assign(
        size,
        geometry(
          { ...ctx.input, ratio: "auto" },
          { ...info, width: cropWidth, height: cropHeight },
        ),
      );
      filter = `crop=${cropWidth}:${cropHeight}:0:${cropY},${fitFilter(size)}`;
    } else
      filter = `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=black:t=fill,${fitFilter(size)}`;
  }
  const file = path.join(dir, `result.${format}`);
  await encodeVideo(source, file, size, duration, ctx, dir, {
    start,
    cues,
    filter,
  });
  const artifact = await finalizeVideo(
    file,
    ctx,
    ctx.toolId === "subtitle-remove"
      ? `区域${ctx.input.mode === "crop" ? "裁切" : "遮挡"}.${format}`
      : `${ctx.toolId === "subtitle-burn" ? "字幕成片" : "处理结果"}.${format}`,
    { duration, ...size },
    {
      processing: "local",
      operation: ctx.toolId,
      subtitleMode:
        ctx.toolId === "subtitle-remove"
          ? "明确区域处理，不是无痕修复"
          : cues.length
            ? "用户提供时间轴或原文"
            : undefined,
    },
  );
  return {
    artifacts: [artifact],
    result: { mode: "local", operation: ctx.toolId, ...size, duration },
  };
}

async function scenes(
  ctx: ExecutionContext,
  dir: string,
): Promise<ExecutionResult> {
  const { asset, info } = await firstSource(ctx, ["video"]);
  inRange(info.duration!, 0.01, 180, "视频时长");
  const threshold = inRange(
    number(ctx.input.threshold, 0.3),
    0.05,
    0.9,
    "镜头阈值",
  );
  await progress(ctx, 10, "基于画面差异检测技术镜头边界");
  const { stderr } = await runProcess(
    FF(),
    [
      ...baseArgs,
      ...inputArgs(asset.path),
      "-an",
      "-vf",
      `select='gt(scene,${threshold})',showinfo`,
      "-fps_mode",
      "vfr",
      "-f",
      "null",
      "-",
    ],
    { signal: ctx.signal },
  );
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((t) => t > 0.05 && t < info.duration! - 0.05);
  const boundaries = [
    0,
    ...[...new Set(times)]
      .sort((a, b) => a - b)
      .filter((t, i, all) => i === 0 || t - all[i - 1]! > 0.1)
      .slice(0, 59),
    info.duration!,
  ];
  const artifacts: GeneratedArtifact[] = [],
    entries: {
      index: number;
      start: number;
      end: number;
      duration: number;
      frame: string;
      description: string;
    }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!,
      end = boundaries[i + 1]!;
    const name = `镜头-${String(i + 1).padStart(2, "0")}.jpg`,
      temp = path.join(dir, `scene-${i}.jpg`);
    await progress(
      ctx,
      30 + (i / (boundaries.length - 1)) * 60,
      `提取镜头关键帧 ${i + 1}/${boundaries.length - 1}`,
    );
    const frameTime = Math.max(
      0,
      Math.min(
        (start + end) / 2,
        info.duration! - 1 / (info.frameRate || 4) - 0.002,
      ),
    );
    await runProcess(
      FF(),
      [
        ...baseArgs,
        "-ss",
        String(frameTime),
        ...inputArgs(asset.path),
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2,format=yuvj420p",
        "-c:v",
        "mjpeg",
        "-threads",
        "1",
        "-q:v",
        "3",
        "-update",
        "1",
        temp,
      ],
      { signal: ctx.signal },
    );
    await probeMedia(temp, ctx.signal);
    const destination = path.join(ctx.outputDir, name);
    await rename(temp, destination);
    artifacts.push({
      path: destination,
      name,
      kind: "image",
      mime: "image/jpeg",
      metadata: { time: frameTime, start, end },
    });
    entries.push({
      index: i + 1,
      start,
      end,
      duration: end - start,
      frame: name,
      description: "基于像素变化的技术镜头；未进行语义理解",
    });
  }
  const result = {
    mode: "technical",
    method: "FFmpeg scene score",
    threshold,
    duration: info.duration,
    sceneCount: entries.length,
    scenes: entries,
    limitations:
      "仅检测视觉变化。不能据此推断营销机制、商品、人物身份或广告效果。",
  };
  const output = path.join(ctx.outputDir, "技术分镜.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  artifacts.unshift({
    path: output,
    kind: "document",
    mime: "application/json",
    name: "技术分镜.json",
    metadata: { mode: "technical" },
  });
  return { artifacts, result };
}

export async function runMediaTask(
  context: ExecutionContext,
): Promise<ExecutionResult> {
  checkAbort(context.signal);
  if (context.isCancellationRequested()) throw cancelled();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) controller.abort();
  const timer = setInterval(() => {
    try {
      if (context.isCancellationRequested()) controller.abort();
    } catch {
      controller.abort();
    }
  }, 150);
  timer.unref();
  const ctx = { ...context, signal: controller.signal };
  const dir = path.join(ctx.outputDir, `.work-${randomUUID()}`);
  try {
    await mkdir(ctx.outputDir, { recursive: true });
    await mkdir(dir);
    let result: ExecutionResult;
    if (ctx.toolId === "remix" || ctx.toolId === "slideshow")
      result = await montage(ctx, dir, ctx.toolId === "slideshow");
    else if (
      ["transcode", "trim", "subtitle-burn", "subtitle-remove"].includes(
        ctx.toolId,
      )
    )
      result = await transform(ctx, dir);
    else if (ctx.toolId === "scene-detect") result = await scenes(ctx, dir);
    else
      throw new MediaError(
        "UNSUPPORTED_TOOL",
        `不支持的本地媒体工具：${ctx.toolId}`,
      );
    checkAbort(ctx.signal);
    await progress(ctx, 98, "真实产物已完成探测与校验");
    return result;
  } finally {
    clearInterval(timer);
    context.signal.removeEventListener("abort", onAbort);
    await rm(dir, { recursive: true, force: true });
  }
}

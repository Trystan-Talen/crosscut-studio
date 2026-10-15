import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  analysisInstruction,
  parseAnalysisResult,
} from "../shared/analysis.js";
import { getSubtitleStyle } from "../shared/subtitle-styles.js";
import { validateProviderLimits } from "../shared/provider-limits.js";
import {
  OPENAI_VOICES,
  openaiBuiltInVoices,
} from "../shared/provider-voices.js";
import type {
  ExecutionAsset,
  ExecutionContext,
  ExecutionResult,
  GeneratedArtifact,
  MediaKind,
  ProviderConfig,
  ToolInput,
} from "../shared/types.js";
import {
  extractAudio,
  extractFrames,
  probeMedia,
  runMediaTask,
  validateMediaFile,
} from "./media.js";
import {
  safeFetch,
  SafeHttpError,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from "./safe-http.js";

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
/** Configured directories define provider scope, not proof of remote account access. */
export function validateProviderSelections(
  provider: ProviderConfig,
  capability: string,
  input: ToolInput,
): void {
  const voice =
    (typeof input.voice === "string" ? input.voice : "") ||
    (capability === "speech" ? (provider.voices[0]?.id ?? "") : "");
  const avatar = typeof input.avatar === "string" ? input.avatar : "";
  const requireDeclared = (field: "voices" | "avatars", id: string) => {
    const label = field === "voices" ? "音色" : "角色";
    if (!provider[field].length)
      throw new ProviderError(
        "PROVIDER_DIRECTORY_REQUIRED",
        `所选服务商尚未配置${label}目录，无法确认此 ID 的归属；请先在设置中登记该服务商的真实${label} ID。目录登记不代表服务商已授权。`,
      );
    if (!provider[field].some((entry) => entry.id === id))
      throw new ProviderError(
        "PROVIDER_SELECTION_MISMATCH",
        `此${label} ID 不在所选服务商的目录中，请重新选择或先更新该服务商目录。`,
      );
  };
  if (voice) {
    if (provider.kind === "heygen" && capability === "video.translate")
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "此翻译 profile 保留原声；指定替换音色需另行开通并验证企业能力。",
      );
    if (capability === "voice.clone")
      throw new ProviderError(
        "INVALID_INPUT",
        "音色克隆使用本次样本生成的音色，不能指定已有音色 ID。",
      );
    if (provider.kind === "openai" && capability === "speech") {
      const model = provider.models.speech || provider.model;
      if (
        ["tts-1", "tts-1-hd"].includes(model) &&
        !openaiBuiltInVoices(model).includes(voice)
      )
        throw new ProviderError(
          "VOICE_MODEL_UNSUPPORTED",
          "所选语音模型不支持此音色，请选择该模型支持的内置音色。",
        );
      if (!OPENAI_VOICES.includes(voice)) requireDeclared("voices", voice);
    } else requireDeclared("voices", voice);
  }
  if (avatar) {
    if (capability === "avatar.photo")
      throw new ProviderError(
        "INVALID_INPUT",
        "照片数字人使用本次照片创建角色，不能指定已有角色 ID。",
      );
    requireDeclared("avatars", avatar);
  }
}
type Obj = Record<string, unknown>;
// Synchronous responses have no queryable task ID. Once accepted, failures in
// parsing, downloads, or local post-processing must never enable paid replay.
const acceptedSynchronousResponses = new WeakSet<ExecutionContext>();
function recordSynchronousResponse(
  ctx: ExecutionContext,
  response: SafeFetchResponse,
) {
  if (response.ok) acceptedSynchronousResponses.add(ctx);
}
const object = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError("INVALID_RESPONSE", "服务返回的数据结构无效。");
  return value as Obj;
};
const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const needString = (value: unknown, label: string) => {
  const text = str(value);
  if (!text.trim())
    throw new ProviderError("INVALID_RESPONSE", `服务没有返回有效的${label}。`);
  return text;
};
const taskId = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw new ProviderError(
      "SUBMISSION_UNKNOWN",
      "服务没有返回可恢复的任务 ID，请核对受理结果后再重试。",
    );
  return value;
};
function submittedData(response: Obj): Obj {
  try {
    return object(response.data);
  } catch {
    throw new ProviderError(
      "SUBMISSION_UNKNOWN",
      "服务提交响应缺少任务数据，请核对受理结果。",
    );
  }
}
const inputString = (ctx: ExecutionContext, key: string, fallback = "") =>
  str(ctx.input[key]) || fallback;
const inputNumber = (ctx: ExecutionContext, key: string, fallback: number) =>
  typeof ctx.input[key] === "number" ? (ctx.input[key] as number) : fallback;
const pngLimit = 30 * 1024 * 1024;
const outputLimit = 210 * 1024 * 1024;
const getModel = (p: ProviderConfig, capability: string) => {
  const model = p.models?.[capability] || p.model;
  if (!model)
    throw new ProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "请配置此能力的真实模型 ID。",
    );
  return model;
};
const endpoint = (p: ProviderConfig, path: string) =>
  `${p.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
const auth = (p: ProviderConfig): Record<string, string> =>
  p.kind === "elevenlabs"
    ? { "xi-api-key": p.apiKey }
    : p.kind === "heygen"
      ? { "x-api-key": p.apiKey }
      : { authorization: `Bearer ${p.apiKey}` };
function checkHttp(r: SafeFetchResponse): void {
  if (r.ok) return;
  const codes: Record<number, [string, string]> = {
    400: ["INVALID_INPUT", "服务拒绝了输入参数，请检查模型和素材要求。"],
    401: ["PROVIDER_AUTHENTICATION", "服务商密钥无效或已过期。"],
    403: ["PROVIDER_PERMISSION", "服务商账户没有此模型或功能权限。"],
    404: ["REMOTE_NOT_FOUND", "服务商找不到请求的资源。"],
    409: ["PROVIDER_CONFLICT", "服务商资源尚未就绪或请求仍在处理中。"],
    413: ["INPUT_TOO_LARGE", "服务商不接受此大小的文件。"],
    422: ["INVALID_INPUT", "服务商参数或素材校验失败。"],
    429: ["PROVIDER_RATE_LIMIT", "服务商额度或请求频率受限，请稍后检查账户。"],
  };
  const entry = codes[r.status] ?? [
    "UPSTREAM_ERROR",
    `服务商请求失败（HTTP ${r.status}）。`,
  ];
  throw new ProviderError(entry[0], entry[1]);
}
function jsonResponse(r: SafeFetchResponse, submission = false): Obj {
  checkHttp(r);
  try {
    return object(JSON.parse(r.body.toString("utf8")));
  } catch (error) {
    if (submission)
      throw new ProviderError(
        "SUBMISSION_UNKNOWN",
        "服务返回内容无效，无法确认任务是否受理，需核对后重试。",
      );
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("INVALID_RESPONSE", "服务未返回有效 JSON。");
  }
}
async function call(
  p: ProviderConfig,
  path: string,
  options: SafeFetchOptions = {},
  ambiguous = false,
): Promise<SafeFetchResponse> {
  try {
    const response = await safeFetch(endpoint(p, path), {
      ...options,
      headers: { ...auth(p), ...options.headers },
    });
    if (ambiguous && response.status >= 500)
      throw new ProviderError(
        "SUBMISSION_UNKNOWN",
        "服务提交结果不明，需核对后再重试，避免重复计费。",
      );
    return response;
  } catch (error) {
    if (
      ambiguous &&
      error instanceof SafeHttpError &&
      [
        "NETWORK_ERROR",
        "UPSTREAM_TIMEOUT",
        "CANCELLED",
        "RESPONSE_TOO_LARGE",
      ].includes(error.code)
    )
      throw new ProviderError(
        "SUBMISSION_UNKNOWN",
        "连接中断，无法确认服务是否已接受任务，请核对后再重试。",
      );
    throw error;
  }
}
async function jsonCall(
  p: ProviderConfig,
  path: string,
  body: unknown,
  ctx: ExecutionContext,
  extra: Record<string, string> = {},
  ambiguous = true,
) {
  let r: SafeFetchResponse;
  for (let attempt = 0; ; attempt++) {
    r = await call(
      p,
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify(body),
        signal: ctx.signal,
        timeoutMs: 180_000,
        maxBytes: 64 * 1024 * 1024,
      },
      ambiguous,
    );
    let conflictCode = "";
    if (p.kind === "heygen" && extra["Idempotency-Key"] && r.status === 409) {
      try {
        conflictCode = str(
          object(object(JSON.parse(r.body.toString("utf8"))).error).code,
        );
      } catch {
        /* Treat an unknown conflict as an ordinary rejected response. */
      }
    }
    if (!["resource_not_ready", "request_in_progress"].includes(conflictCode))
      break;
    if (attempt >= 7)
      throw new ProviderError(
        conflictCode === "request_in_progress"
          ? "SUBMISSION_UNKNOWN"
          : "PROVIDER_NOT_READY",
        conflictCode === "request_in_progress"
          ? "服务仍在受理相同幂等请求，请核对后恢复。"
          : "服务商素材尚未就绪，请稍后重试。",
      );
    await delay(
      process.env.CROSSCUT_ALLOW_LOCAL_PROVIDERS === "1" ? 20 : 2000,
      undefined,
      { signal: ctx.signal },
    );
  }
  if (p.kind === "openai") recordSynchronousResponse(ctx, r);
  return jsonResponse(r, ambiguous);
}
type RemoteState = { kind: string; stage: string; id: string; at?: number };
const encodeState = (state: RemoteState) =>
  `cc1.${Buffer.from(JSON.stringify({ ...state, at: state.at ?? Date.now() })).toString("base64url")}`;
function decodeState(
  id: string | undefined,
  kind: string,
): RemoteState | undefined {
  if (!id) return;
  if (!id.startsWith("cc1.")) return { kind, stage: "task", id };
  try {
    const s = object(
      JSON.parse(Buffer.from(id.slice(4), "base64url").toString()),
    );
    if (
      s.kind !== kind ||
      typeof s.stage !== "string" ||
      typeof s.id !== "string"
    )
      throw new Error();
    return s as RemoteState;
  } catch {
    throw new ProviderError("INVALID_REMOTE_TASK", "无法恢复服务商任务标识。");
  }
}
async function remember(ctx: ExecutionContext, state: RemoteState) {
  await ctx.onRemoteTask(encodeState(state), {
    providerKind: state.kind,
    stage: state.stage,
  });
}
async function waitPoll(ctx: ExecutionContext) {
  await delay(
    process.env.CROSSCUT_ALLOW_LOCAL_PROVIDERS === "1" ? 20 : 3000,
    undefined,
    { signal: ctx.signal },
  );
}
function selectAsset(
  ctx: ExecutionContext,
  kind: MediaKind,
  required = true,
): ExecutionAsset | undefined {
  const asset = ctx.assets.find((a) => a.kind === kind);
  if (!asset && required)
    throw new ProviderError("INVALID_INPUT", `缺少 ${kind} 素材。`);
  return asset;
}
async function dataUrl(asset: ExecutionAsset, limit = pngLimit) {
  if (asset.size > limit)
    throw new ProviderError("INPUT_TOO_LARGE", "素材超出服务商单次请求限额。");
  const bytes = await readFile(asset.path);
  if (bytes.length > limit)
    throw new ProviderError("INPUT_TOO_LARGE", "素材超出服务商单次请求限额。");
  return `data:${asset.mime};base64,${bytes.toString("base64")}`;
}
async function blob(asset: ExecutionAsset) {
  return new Blob([new Uint8Array(await readFile(asset.path))], {
    type: asset.mime,
  });
}
async function saveMedia(
  ctx: ExecutionContext,
  bytes: Buffer,
  kind: MediaKind,
  name: string,
): Promise<GeneratedArtifact> {
  if (!bytes.length || bytes.length > outputLimit)
    throw new ProviderError(
      "INVALID_ARTIFACT",
      "服务返回的产物为空或超出大小限制。",
    );
  await mkdir(ctx.outputDir, { recursive: true });
  const temporary = join(ctx.outputDir, `${randomUUID()}.part`);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    const actual = await probeMedia(temporary, ctx.signal);
    if (
      actual.kind !== kind ||
      (kind !== "image" && (!actual.duration || actual.duration <= 0))
    )
      throw new ProviderError(
        "INVALID_ARTIFACT",
        "服务产物类型或时长与请求不符。",
      );
    if (actual.kind === "video" || actual.kind === "audio") {
      try {
        await validateMediaFile(temporary, ctx.signal);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        throw new ProviderError(
          "INVALID_ARTIFACT",
          "服务返回的音视频不能完整解码，产物可能已损坏。",
        );
      }
    }
    const ext: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "audio/flac": "flac",
    };
    const path = join(
      ctx.outputDir,
      `${randomUUID()}.${ext[actual.mime] ?? (kind === "video" ? "mp4" : kind === "audio" ? "audio" : "image")}`,
    );
    await rename(temporary, path);
    return {
      path,
      kind,
      mime: actual.mime,
      name,
      metadata: {
        duration: actual.duration,
        width: actual.width,
        height: actual.height,
      },
    };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function download(
  ctx: ExecutionContext,
  url: unknown,
  kind: MediaKind,
  name: string,
) {
  const r = await safeFetch(needString(url, "下载地址"), {
    signal: ctx.signal,
    timeoutMs: 180_000,
    maxBytes: outputLimit,
  });
  checkHttp(r);
  return saveMedia(ctx, r.body, kind, name);
}
async function textResult(
  ctx: ExecutionContext,
  result: unknown,
  text: string,
  extension = "txt",
): Promise<ExecutionResult> {
  await mkdir(ctx.outputDir, { recursive: true });
  const path = join(ctx.outputDir, `${randomUUID()}.${extension}`);
  const tmp = `${path}.part`;
  await writeFile(tmp, text);
  await rename(tmp, path);
  return {
    artifacts: [
      {
        path,
        name: `${ctx.toolId}.${extension}`,
        kind: extension === "srt" ? "subtitle" : "document",
        mime:
          extension === "json"
            ? "application/json"
            : extension === "srt"
              ? "application/x-subrip"
              : "text/plain",
      },
    ],
    result,
  };
}
function capability(ctx: ExecutionContext): string {
  if (["image-video", "text-video", "video-studio"].includes(ctx.toolId))
    return "video.task";
  if (ctx.toolId === "image-generate")
    return ctx.input.mode === "edit" ||
      ctx.assets.some((a) => a.kind === "image")
      ? "image.edit"
      : "image.generate";
  if (["agent-chat", "ad-script", "prompt-optimize"].includes(ctx.toolId))
    return "chat";
  if (
    [
      "video-understand",
      "analysis-timeline",
      "analysis-mechanism",
      "analysis-prompt",
      "ocr-prompt",
    ].includes(ctx.toolId)
  )
    return "video.analysis";
  return (
    (
      {
        tts: "speech",
        subtitles: "transcription",
        "voice-clone": "voice.clone",
        "text-avatar": "avatar.text",
        "tiktok-avatar": "avatar.text",
        "audio-avatar": "avatar.audio",
        "custom-avatar": "avatar.photo",
        "video-translate": "video.translate",
      } as Record<string, string>
    )[ctx.toolId] ?? `workflow:${ctx.toolId}`
  );
}
async function chat(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  const vision = capability(ctx) === "video.analysis";
  let instruction =
    "你是跨境广告创作助手。根据用户明确提供的信息回答，不编造商品效果、价格或已经完成的操作。";
  if (ctx.toolId === "ad-script")
    instruction +=
      " 输出可执行的广告文案与分镜，遵守指定语言和风格。价格采用输入 currency 指定的币种并保留 price 原值，不自行换算或补造折扣。";
  if (ctx.toolId === "prompt-optimize")
    instruction += " 改写并增强提示词，保留产品事实，只返回优化后的提示词。";
  const { analysisPromptBaseline: _baseline, ...promptInput } = ctx.input;
  const content: unknown[] = [
    { type: "text", text: JSON.stringify(promptInput) },
  ];
  let duration: number | null = null;
  if (vision) {
    instruction =
      "只根据附带的真实抽样画面分析；抽样帧不代表完整连续视频，也不能证明音轨内容。不要编造声音、转化数据或未观察到的事件。";
    const video = selectAsset(ctx, "video", false);
    const images = ctx.assets.filter((a) => a.kind === "image");
    if (video) {
      duration = video.duration;
      const frames = await extractFrames(
        video,
        join(ctx.outputDir, "frames"),
        8,
        ctx.signal,
      );
      for (const frame of frames) {
        content.push(
          { type: "text", text: `画面时间 ${frame.time.toFixed(3)} 秒` },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${(await readFile(frame.path)).toString("base64")}`,
            },
          },
        );
      }
    } else if (images.length) {
      for (const asset of images.slice(0, 8))
        content.push({
          type: "image_url",
          image_url: { url: await dataUrl(asset) },
        });
    } else
      throw new ProviderError(
        "INVALID_INPUT",
        "视觉分析需要真实图片或视频素材。",
      );
    instruction += " " + analysisInstruction(ctx.toolId, duration);
  }
  const history: { role: "user" | "assistant"; content: string }[] = [];
  if (ctx.toolId === "agent-chat" && ctx.input.history) {
    let entries: unknown;
    try {
      entries = JSON.parse(inputString(ctx, "history"));
    } catch {
      throw new ProviderError("INVALID_INPUT", "对话历史格式无效。");
    }
    for (const item of list(entries).slice(-16)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Obj;
      if (
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string" &&
        entry.content.trim() &&
        entry.content.length <= 10000
      )
        history.push({ role: entry.role, content: entry.content });
    }
  }
  const response = await jsonCall(
    p,
    "chat/completions",
    {
      model: getModel(p, vision ? "video.analysis" : "chat"),
      messages: [
        { role: "system", content: instruction },
        ...history,
        {
          role: "user",
          content: vision
            ? content
            : ctx.toolId === "agent-chat"
              ? inputString(ctx, "text")
              : JSON.stringify(promptInput),
        },
      ],
      stream: false,
    },
    ctx,
  );
  const first = object(list(response.choices)[0]);
  const message = object(first.message);
  if (message.refusal)
    throw new ProviderError("CONTENT_REJECTED", "服务拒绝生成此内容。");
  if (first.finish_reason === "length")
    throw new ProviderError(
      "INCOMPLETE_RESPONSE",
      "服务返回的文本被长度限制截断。",
    );
  const text = needString(message.content, "文本");
  let result: unknown = {
    text,
    ...(ctx.toolId === "prompt-optimize" ? { prompt: text } : {}),
  };
  if (vision) {
    try {
      const parsed = JSON.parse(
        text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
      );
      result = parseAnalysisResult(ctx.toolId, parsed, duration);
    } catch {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "视觉分析未返回有效的结构化结果或时间码。",
      );
    }
  }
  const out = await textResult(
    ctx,
    result,
    vision ? JSON.stringify(result, null, 2) : text,
    vision ? "json" : "txt",
  );
  out.usage =
    response.usage && typeof response.usage === "object"
      ? object(response.usage)
      : undefined;
  return out;
}
async function openai(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  const cap = capability(ctx);
  if (["chat", "video.analysis"].includes(cap)) return chat(ctx, p);
  if (cap === "image.generate" || cap === "image.edit") {
    const model = getModel(p, cap);
    const images = ctx.assets.filter((a) => a.kind === "image");
    if (cap === "image.edit" && !images.length)
      throw new ProviderError("INVALID_INPUT", "图像编辑需要参考图片。");
    let r: SafeFetchResponse;
    const ratio = inputString(ctx, "ratio", "1:1");
    const size =
      ratio === "auto"
        ? "auto"
        : ratio === "1:1"
          ? "1024x1024"
          : ["9:16", "2:3", "3:4"].includes(ratio)
            ? "1024x1536"
            : "1536x1024";
    const quality = inputString(ctx, "quality", "auto");
    if (images.length) {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", inputString(ctx, "prompt"));
      form.set("n", "1");
      form.set("size", size);
      form.set("quality", quality);
      for (const asset of images) {
        if (asset.size > pngLimit)
          throw new ProviderError("INPUT_TOO_LARGE", "参考图片过大。");
        form.append("image[]", await blob(asset), asset.name);
      }
      r = await call(
        p,
        "images/edits",
        {
          method: "POST",
          body: form,
          signal: ctx.signal,
          timeoutMs: 180_000,
          maxBytes: 64 * 1024 * 1024,
        },
        true,
      );
    } else
      r = await call(
        p,
        "images/generations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: inputString(ctx, "prompt"),
            n: 1,
            size,
            quality,
            output_format: "png",
          }),
          signal: ctx.signal,
          timeoutMs: 180_000,
          maxBytes: 64 * 1024 * 1024,
        },
        true,
      );
    recordSynchronousResponse(ctx, r);
    const result = jsonResponse(r, true);
    const image = object(list(result.data)[0]);
    let artifact: GeneratedArtifact;
    if (
      typeof image.b64_json === "string" &&
      /^[A-Za-z0-9+/\r\n]*={0,2}$/.test(image.b64_json)
    )
      artifact = await saveMedia(
        ctx,
        Buffer.from(image.b64_json, "base64"),
        "image",
        "生成图片",
      );
    else if (p.options?.imageUrlResponse === true)
      artifact = await download(ctx, image.url, "image", "生成图片");
    else
      throw new ProviderError(
        "INVALID_RESPONSE",
        "生图服务未返回有效的 Base64 图片。",
      );
    if (ratio !== "auto") {
      const [w, h] = ratio.split(":").map(Number);
      if (!w || !h) throw new ProviderError("INVALID_INPUT", "图片比例无效。");
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(artifact.path).metadata();
      const width = metadata.width!,
        height = metadata.height!;
      const cropWidth = Math.min(width, Math.round((height * w) / h)),
        cropHeight = Math.min(height, Math.round((width * h) / w));
      if (cropWidth !== width || cropHeight !== height) {
        const cropped = await sharp(artifact.path)
          .extract({
            left: Math.floor((width - cropWidth) / 2),
            top: Math.floor((height - cropHeight) / 2),
            width: cropWidth,
            height: cropHeight,
          })
          .png()
          .toBuffer();
        const previous = artifact.path;
        artifact = await saveMedia(ctx, cropped, "image", "生成图片.png");
        artifact.metadata = {
          ...artifact.metadata,
          adaptation: "local-center-crop",
          requestedRatio: ratio,
        };
        await rm(previous, { force: true });
      }
    }
    return {
      artifacts: [artifact],
      usage:
        result.usage && typeof result.usage === "object"
          ? object(result.usage)
          : undefined,
    };
  }
  if (cap === "speech") {
    const voice = inputString(ctx, "voice", p.voices[0]?.id ?? "");
    if (!voice)
      throw new ProviderError("INVALID_INPUT", "请选择服务商支持的音色 ID。");
    const r = await call(
      p,
      "audio/speech",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: getModel(p, "speech"),
          input: inputString(ctx, "text"),
          voice:
            new URL(p.baseUrl).hostname === "api.openai.com" &&
            !OPENAI_VOICES.includes(voice)
              ? { id: voice }
              : voice,
          response_format: "mp3",
          speed: inputNumber(ctx, "speed", 1),
        }),
        signal: ctx.signal,
        timeoutMs: 180_000,
        maxBytes: outputLimit,
      },
      true,
    );
    checkHttp(r);
    recordSynchronousResponse(ctx, r);
    return { artifacts: [await saveMedia(ctx, r.body, "audio", "AI配音.mp3")] };
  }
  if (cap === "transcription") return transcribe(ctx, p);
  throw new ProviderError(
    "UNSUPPORTED_CAPABILITY",
    "该 OpenAI 适配器不支持此能力。",
  );
}
function timestamp(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
async function transcribe(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  const model = getModel(p, "transcription");
  if (model !== "whisper-1" && p.options?.timestampTranscription !== true)
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "当前字幕流程需要支持 verbose_json 分段时间戳的识别模型。",
    );
  const asset = ctx.assets.find((a) => ["video", "audio"].includes(a.kind));
  if (!asset) throw new ProviderError("INVALID_INPUT", "字幕识别需要音视频。");
  const path = await extractAudio(
    asset,
    join(ctx.outputDir, "audio"),
    ctx.signal,
  );
  const bytes = await readFile(path);
  if (bytes.length > 25 * 1024 * 1024)
    throw new ProviderError(
      "INPUT_TOO_LARGE",
      "提取的音轨超过识别服务 25 MB 上限，请缩短素材。",
    );
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
    "source.wav",
  );
  form.set("model", model);
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const language = inputString(ctx, "language");
  if (language && !["auto", "自动"].includes(language))
    form.set("language", languages[language]?.iso ?? language);
  const raw = await call(
    p,
    "audio/transcriptions",
    {
      method: "POST",
      body: form,
      signal: ctx.signal,
      timeoutMs: 180_000,
      maxBytes: 8 * 1024 * 1024,
    },
    true,
  );
  recordSynchronousResponse(ctx, raw);
  const response = jsonResponse(raw, true);
  let segments = z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        text: z.string(),
      }),
    )
    .min(1)
    .safeParse(response.segments);
  if (!segments.success || segments.data.some((s) => s.end < s.start))
    throw new ProviderError(
      "INVALID_RESPONSE",
      "识别服务未提供有效的分段时间戳。",
    );
  const target = inputString(ctx, "targetLanguage");
  if (target && target !== "original" && target !== language) {
    if (!p.capabilities.includes("chat"))
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "跨语言字幕需要额外配置文字翻译能力。",
      );
    const translated = await jsonCall(
      p,
      "chat/completions",
      {
        model: getModel(p, "chat"),
        messages: [
          {
            role: "system",
            content: `Translate subtitle texts into ${target}. Return only a JSON array of strings, preserving the exact array length and order.`,
          },
          {
            role: "user",
            content: JSON.stringify(segments.data.map((s) => s.text)),
          },
        ],
        stream: false,
      },
      ctx,
    );
    let texts: string[];
    try {
      texts = z
        .array(z.string())
        .parse(
          JSON.parse(
            needString(
              object(object(list(translated.choices)[0]).message).content,
              "字幕翻译",
            ),
          ),
        );
      if (texts.length !== segments.data.length) throw new Error();
    } catch {
      throw new ProviderError("INVALID_RESPONSE", "字幕翻译数量或结构无效。");
    }
    segments = {
      success: true,
      data: segments.data.map((s, i) => ({ ...s, text: texts[i]! })),
    };
  }
  const srt = segments.data
    .map(
      (s, i) =>
        `${i + 1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${s.text.trim()}\n`,
    )
    .join("\n");
  return textResult(
    ctx,
    {
      segments: segments.data,
      language: target || language || response.language,
    },
    srt,
    "srt",
  );
}

const languages: Record<string, { iso: string; heygen: string }> = {
  英语: { iso: "en", heygen: "English" },
  中文: { iso: "zh", heygen: "Chinese (Mandarin, Simplified)" },
  日语: { iso: "ja", heygen: "Japanese" },
  韩语: { iso: "ko", heygen: "Korean" },
  西班牙语: { iso: "es", heygen: "Spanish" },
  法语: { iso: "fr", heygen: "French" },
  德语: { iso: "de", heygen: "German" },
  葡萄牙语: { iso: "pt", heygen: "Portuguese" },
  印尼语: { iso: "id", heygen: "Indonesian" },
  意大利语: { iso: "it", heygen: "Italian" },
  泰语: { iso: "th", heygen: "Thai" },
  越南语: { iso: "vi", heygen: "Vietnamese" },
  阿拉伯语: { iso: "ar", heygen: "Arabic" },
  土耳其语: { iso: "tr", heygen: "Turkish" },
  马来语: { iso: "ms", heygen: "Malay" },
  俄语: { iso: "ru", heygen: "Russian" },
  波兰语: { iso: "pl", heygen: "Polish" },
  荷兰语: { iso: "nl", heygen: "Dutch" },
  菲律宾语: { iso: "fil", heygen: "Filipino" },
  印地语: { iso: "hi", heygen: "Hindi" },
  瑞典语: { iso: "sv", heygen: "Swedish" },
  罗马尼亚语: { iso: "ro", heygen: "Romanian" },
};
async function ark(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  if (capability(ctx) !== "video.task")
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "Ark 适配器仅支持已实现的视频任务协议。",
    );
  let state = decodeState(ctx.remoteTaskId, "ark");
  if (!state) {
    if (ctx.assets.some((a) => a.kind === "video"))
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "当前 Ark 适配器未配置公网视频素材上传，不接受本机参考视频。",
      );
    if (!["mp4", "mov"].includes(inputString(ctx, "format", "mp4")))
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "当前支持 MP4 或经本地转码的 MOV。",
      );
    const model = getModel(p, "video.task");
    const duration = inputNumber(ctx, "duration", 5);
    const maxDuration = model.includes("2-5") ? 30 : 15;
    if (!Number.isInteger(duration) || duration < 4 || duration > maxDuration)
      throw new ProviderError(
        "INVALID_INPUT",
        `当前模型时长范围为 4–${maxDuration} 秒。`,
      );
    const images = ctx.assets.filter((a) => a.kind === "image");
    const audio = ctx.assets.filter((a) => a.kind === "audio");
    const mode = inputString(
      ctx,
      "mode",
      ctx.toolId === "image-video" ? "first-last" : "text",
    );
    if (mode === "text" && (images.length || audio.length))
      throw new ProviderError(
        "INVALID_INPUT",
        "文生视频模式不能忽略已选择的参考素材，请切换参考模式。",
      );
    if (
      mode === "first-last" &&
      (images.length < 1 || images.length > 2 || audio.length)
    )
      throw new ProviderError("INVALID_INPUT", "首尾帧模式只接受 1–2 张图片。");
    if (
      mode === "reference" &&
      (images.length > 9 ||
        audio.length > 3 ||
        (!images.length && !audio.length))
    )
      throw new ProviderError(
        "INVALID_INPUT",
        "请提供符合模型限制的参考素材。",
      );
    if (audio.length && !images.length)
      throw new ProviderError(
        "INVALID_INPUT",
        "音频参考需要同时提供图片参考。",
      );
    let prompt = inputString(ctx, "prompt");
    const negative = inputString(ctx, "negativePrompt");
    if (negative) prompt += `\n避免：${negative}`;
    const content: unknown[] = [{ type: "text", text: prompt }];
    for (let i = 0; i < images.length; i++) {
      const asset = images[i]!;
      if (
        !asset.width ||
        !asset.height ||
        Math.min(asset.width, asset.height) < 300 ||
        Math.max(asset.width, asset.height) > 6000 ||
        asset.width / asset.height < 0.4 ||
        asset.width / asset.height > 2.5
      )
        throw new ProviderError(
          "INVALID_INPUT",
          "参考图片需满足边长 300–6000 像素、宽高比 0.4–2.5。",
        );
      content.push({
        type: "image_url",
        image_url: { url: await dataUrl(asset) },
        role:
          mode === "reference"
            ? "reference_image"
            : i === 0
              ? "first_frame"
              : "last_frame",
      });
    }
    for (const asset of audio)
      content.push({
        type: "audio_url",
        audio_url: { url: await dataUrl(asset, 15 * 1024 * 1024) },
        role: "reference_audio",
      });
    const ratio = inputString(ctx, "ratio", "9:16");
    if (!["auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].includes(ratio))
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "当前 Ark 视频接口不支持所选画幅；请选择 16:9、4:3、1:1、3:4、9:16、21:9 或 auto。",
      );
    if (model.includes("2-5") && mode === "first-last" && ratio !== "auto")
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "Seedance 2.5 首尾帧模式要求自动保持首帧比例，请选择 auto。",
      );
    const payload = {
      model,
      content,
      duration,
      ratio: ratio === "auto" ? "adaptive" : ratio,
      resolution: inputString(ctx, "resolution", "720p"),
      generate_audio: ctx.input.audio !== false,
      return_last_frame: true,
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024 * 1024)
      throw new ProviderError(
        "INPUT_TOO_LARGE",
        "参考素材编码后的请求超过 64 MB。",
      );
    const response = await jsonCall(
      p,
      "contents/generations/tasks",
      payload,
      ctx,
    );
    state = { kind: "ark", stage: "task", id: taskId(response.id) };
    await remember(ctx, state);
  }
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = jsonResponse(
      await call(
        p,
        `contents/generations/tasks/${encodeURIComponent(state.id)}`,
        { signal: ctx.signal },
      ),
    );
    const status = str(response.status);
    if (status === "succeeded") {
      const content = object(response.content);
      const artifact = await download(
        ctx,
        content.video_url,
        "video",
        "生成视频.mp4",
      );
      let artifacts = [artifact];
      if (inputString(ctx, "format", "mp4") === "mov") {
        const info = await probeMedia(artifact.path, ctx.signal);
        const converted = await runMediaTask({
          ...ctx,
          toolId: "transcode",
          input: {
            format: "mov",
            ratio: "auto",
            resolution: inputString(ctx, "resolution", "720p"),
            volume: 100,
          },
          assets: [
            {
              id: randomUUID(),
              name: artifact.name,
              path: artifact.path,
              kind: "video",
              mime: artifact.mime,
              size: 0,
              duration: info.duration,
              width: info.width,
              height: info.height,
            },
          ],
          outputDir: join(ctx.outputDir, "converted"),
        });
        artifacts = converted.artifacts;
      }
      return {
        artifacts,
        usage:
          response.usage && typeof response.usage === "object"
            ? object(response.usage)
            : undefined,
      };
    }
    if (["failed", "expired", "cancelled"].includes(status))
      throw new ProviderError(
        status === "cancelled"
          ? "REMOTE_CANCELLED"
          : status === "expired"
            ? "REMOTE_EXPIRED"
            : "REMOTE_FAILED",
        status === "cancelled"
          ? "服务商已确认取消。"
          : status === "expired"
            ? "服务商任务已过期。"
            : "服务商视频生成失败，请检查素材和模型权限。",
      );
    if (!["queued", "running"].includes(status))
      throw new ProviderError(
        "UNKNOWN_REMOTE_STATUS",
        "服务商返回未知任务状态，已保留任务 ID 待核对。",
      );
    await ctx.onProgress(
      status === "queued" ? 15 : 45,
      status === "queued" ? "服务商排队中" : "服务商生成中",
    );
    await waitPoll(ctx);
  }
  throw new ProviderError(
    "REMOTE_PENDING",
    "服务商任务仍未结束，已保存任务 ID，可恢复查询。",
  );
}
async function elevenlabs(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  const cap = capability(ctx);
  if (!["voice.clone", "speech"].includes(cap))
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "ElevenLabs 适配器仅支持即时克隆与配音。",
    );
  const model = getModel(p, cap);
  const speed = inputNumber(ctx, "speed", 1);
  if (speed < 0.7 || speed > 1.2 || (model === "eleven_v3" && speed !== 1))
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "当前 ElevenLabs 模型不支持此语速；常规模型范围为 0.7–1.2，v3 请用默认语速。",
    );
  let voice = inputString(ctx, "voice", p.voices[0]?.id ?? "");
  const state = decodeState(ctx.remoteTaskId, "elevenlabs");
  if (state) {
    if (state.stage === "verification")
      throw new ProviderError(
        "VOICE_VERIFICATION_REQUIRED",
        "此音色需要在服务商完成核验。",
      );
    if (state.stage === "speech-submitting")
      throw new ProviderError(
        "SUBMISSION_UNKNOWN",
        "配音请求可能已受理，请核对服务商记录；不会自动重复生成。",
      );
    voice = state.id;
  }
  if (cap === "voice.clone" && !state) {
    if (ctx.input.consent !== true)
      throw new ProviderError("INVALID_INPUT", "请确认拥有该声音的使用授权。");
    const source = ctx.assets.find((a) => ["audio", "video"].includes(a.kind));
    if (!source) throw new ProviderError("INVALID_INPUT", "缺少音色样本。");
    const path =
      source.kind === "video"
        ? await extractAudio(
            source,
            join(ctx.outputDir, "reference-audio"),
            ctx.signal,
            { sampleRate: 44100, channels: 1 },
          )
        : source.path;
    const form = new FormData();
    form.set("name", `Crosscut ${ctx.jobId}`);
    form.set("remove_background_noise", String(ctx.input.denoise === true));
    form.append(
      "files",
      new Blob([new Uint8Array(await readFile(path))], {
        type: source.kind === "video" ? "audio/wav" : source.mime,
      }),
      source.kind === "video" ? "reference.wav" : source.name,
    );
    const response = jsonResponse(
      await call(
        p,
        "v1/voices/add",
        {
          method: "POST",
          body: form,
          signal: ctx.signal,
          timeoutMs: 180_000,
          maxBytes: 1024 * 1024,
        },
        true,
      ),
      true,
    );
    voice = taskId(response.voice_id);
    await remember(ctx, {
      kind: "elevenlabs",
      stage:
        response.requires_verification === false ? "voice" : "verification",
      id: voice,
    });
    if (response.requires_verification !== false)
      throw new ProviderError(
        "VOICE_VERIFICATION_REQUIRED",
        response.requires_verification === true
          ? "音色已创建，但需要在服务商完成核验后才能配音。"
          : "音色已创建，但服务未确认核验状态，请先在服务商检查此音色。",
      );
  }
  if (!voice)
    throw new ProviderError(
      "INVALID_INPUT",
      "请选择真实的 ElevenLabs 音色 ID。",
    );
  const body: Obj = { text: inputString(ctx, "text"), model_id: model };
  if (model !== "eleven_v3") body.voice_settings = { speed };
  const language = inputString(ctx, "language");
  if (language && model !== "eleven_multilingual_v2")
    body.language_code = languages[language]?.iso ?? language;
  await remember(ctx, {
    kind: "elevenlabs",
    stage: "speech-submitting",
    id: voice,
  });
  let response: SafeFetchResponse;
  try {
    response = await call(
      p,
      `v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctx.signal,
        timeoutMs: 180_000,
        maxBytes: outputLimit,
      },
      true,
    );
    checkHttp(response);
    recordSynchronousResponse(ctx, response);
  } catch (error) {
    if (error instanceof ProviderError && error.code !== "SUBMISSION_UNKNOWN")
      await remember(ctx, { kind: "elevenlabs", stage: "voice", id: voice });
    throw error;
  }
  return {
    artifacts: [await saveMedia(ctx, response.body, "audio", "生成配音.mp3")],
    result: {
      voiceId: voice,
      languageMode:
        model === "eleven_multilingual_v2"
          ? "automatic-from-input-text"
          : "language-code",
    },
  };
}
async function heygenUpload(
  ctx: ExecutionContext,
  p: ProviderConfig,
  asset: ExecutionAsset,
): Promise<string> {
  const bytes = await readFile(asset.path);
  if (bytes.length <= 32 * 1024 * 1024) {
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: asset.mime }),
      asset.name,
    );
    const result = jsonResponse(
      await call(p, "v3/assets", {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": `${ctx.jobId}.asset.${asset.id}` },
        signal: ctx.signal,
        timeoutMs: 180_000,
        maxBytes: 1024 * 1024,
      }),
    );
    return needString(object(result.data).asset_id, "素材 ID");
  }
  const created = object(
    (
      await jsonCall(
        p,
        "v3/assets/direct-uploads",
        {
          filename: asset.name,
          content_type: asset.mime,
          size_bytes: bytes.length,
        },
        ctx,
        { "Idempotency-Key": `${ctx.jobId}.upload.${asset.id}` },
      )
    ).data,
  );
  if (typeof created.max_bytes !== "number" || bytes.length > created.max_bytes)
    throw new ProviderError("INPUT_TOO_LARGE", "文件超出服务商直传上限。");
  const rawHeaders = object(created.upload_headers);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (
      typeof value !== "string" ||
      ["authorization", "x-api-key", "xi-api-key", "cookie", "host"].includes(
        key.toLowerCase(),
      )
    )
      throw new ProviderError(
        "INVALID_RESPONSE",
        "服务商返回不安全的素材上传头。",
      );
    headers[key] = value;
  }
  checkHttp(
    await safeFetch(needString(created.upload_url, "素材上传地址"), {
      method: "PUT",
      headers,
      body: bytes,
      signal: ctx.signal,
      timeoutMs: 180_000,
      maxBytes: 1024 * 1024,
      maxRedirects: 0,
    }),
  );
  const id = needString(created.asset_id, "素材 ID");
  const completed = object(
    (
      await jsonCall(
        p,
        `v3/assets/${encodeURIComponent(id)}/complete`,
        {},
        ctx,
        { "Idempotency-Key": `${ctx.jobId}.complete.${asset.id}` },
      )
    ).data,
  );
  if (completed.asset_id !== id)
    throw new ProviderError("INVALID_RESPONSE", "素材上传确认 ID 不匹配。");
  return id;
}
async function burnReturnedSubtitle(
  ctx: ExecutionContext,
  video: GeneratedArtifact,
  url: unknown,
  style: string,
): Promise<ExecutionResult> {
  const response = await safeFetch(needString(url, "字幕地址"), {
    signal: ctx.signal,
    maxBytes: 2 * 1024 * 1024,
  });
  checkHttp(response);
  const srt = response.body.toString("utf8");
  if (!/\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(srt))
    throw new ProviderError("INVALID_RESPONSE", "服务未返回有效 SRT 字幕。");
  const measured = await probeMedia(video.path, ctx.signal);
  return runMediaTask({
    ...ctx,
    toolId: "subtitle-burn",
    input: { subtitleText: srt, subtitleStyle: style },
    assets: [
      {
        id: randomUUID(),
        name: video.name,
        path: video.path,
        kind: "video",
        mime: video.mime,
        size: 0,
        duration: measured.duration,
        width: measured.width,
        height: measured.height,
      },
    ],
    outputDir: join(ctx.outputDir, "captioned"),
  });
}
async function heygen(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  const cap = capability(ctx);
  if (
    ![
      "avatar.text",
      "avatar.audio",
      "avatar.photo",
      "video.translate",
    ].includes(cap)
  )
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "此 HeyGen 适配器不支持所选工作流。",
    );
  const selectedStyle = inputString(ctx, "subtitleStyle", "none");
  if (selectedStyle !== "none" && !getSubtitleStyle(selectedStyle))
    throw new ProviderError(
      "INVALID_INPUT",
      "不支持的字幕样式，请选择现有预设。",
    );
  let state = decodeState(ctx.remoteTaskId, "heygen");
  const engine = p.models?.[cap] || p.model;
  if (cap !== "video.translate" && (!state || state.stage === "photo")) {
    if (engine && !["avatar_iv", "avatar_v", "avatar_iii"].includes(engine))
      throw new ProviderError(
        "PROVIDER_NOT_CONFIGURED",
        "请配置有效的 HeyGen avatar 引擎。",
      );
    if (
      cap === "avatar.photo" &&
      inputString(ctx, "prompt") &&
      ["avatar_v", "avatar_iii"].includes(engine)
    )
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "当前照片动作提示仅验证 Avatar IV profile。",
      );
  }
  if (
    state?.stage === "photo" &&
    (!state.at || Date.now() - state.at > 23 * 60 * 60 * 1000)
  )
    throw new ProviderError(
      "SUBMISSION_UNKNOWN",
      "多阶段任务已超出安全幂等恢复窗口，请核对服务商视频记录后重新操作。",
    );
  if (!state || state.stage === "photo") {
    if (cap === "video.translate") {
      if (inputString(ctx, "voice"))
        throw new ProviderError(
          "UNSUPPORTED_CAPABILITY",
          "此翻译 profile 保留原声；指定替换音色需另行开通并验证企业能力。",
        );
      const video = selectAsset(ctx, "video")!;
      const assetId = await heygenUpload(ctx, p, video);
      const requested =
        languages[inputString(ctx, "language")]?.heygen ??
        inputString(ctx, "language");
      const available = jsonResponse(
        await call(p, "v3/video-translations/languages", {
          signal: ctx.signal,
        }),
      );
      const languageData = object(available.data);
      const languageValues = list(languageData.languages).map((v) =>
        typeof v === "string"
          ? v
          : str(object(v).name) || str(object(v).language),
      );
      const chosen =
        languageValues.find((v) => v === requested) ||
        languageValues.find((v) => v.startsWith(`${requested} (`)) ||
        languageValues.find(
          (v) => v === languages[inputString(ctx, "language")]?.iso,
        );
      if (!chosen)
        throw new ProviderError(
          "UNSUPPORTED_CAPABILITY",
          "当前服务未列出所选翻译语言，请更新服务商语言配置。",
        );
      const response = await jsonCall(
        p,
        "v3/video-translations",
        {
          video: { type: "asset_id", asset_id: assetId },
          output_languages: [chosen],
          mode: "speed",
          translate_audio_only: ctx.input.lipSync === false,
        },
        ctx,
        { "Idempotency-Key": `${ctx.jobId}.translation` },
      );
      state = {
        kind: "heygen",
        stage: "translation",
        id: taskId(list(submittedData(response).video_translation_ids)[0]),
      };
      await remember(ctx, state);
    } else {
      const ratio = inputString(ctx, "ratio", "auto");
      if (!["auto", "16:9", "9:16", "1:1", "4:5", "5:4"].includes(ratio))
        throw new ProviderError(
          "UNSUPPORTED_CAPABILITY",
          "当前 HeyGen profile 不支持所选画面比例。",
        );
      if (inputString(ctx, "quality", "standard") === "professional")
        throw new ProviderError(
          "UNSUPPORTED_CAPABILITY",
          "专业数字人模式的供应商参数尚未验证，请选择标准模式。",
        );
      let avatarId = inputString(ctx, "avatar");
      if (cap === "avatar.photo") {
        if (!state) {
          const photo = selectAsset(ctx, "image")!;
          const id = await heygenUpload(ctx, p, photo);
          const created = await jsonCall(
            p,
            "v3/avatars",
            {
              type: "photo",
              name: `Crosscut ${ctx.jobId}`,
              file: { type: "asset_id", asset_id: id },
            },
            ctx,
            { "Idempotency-Key": `${ctx.jobId}.photo` },
          );
          const item = submittedData(created).avatar_item;
          state = {
            kind: "heygen",
            stage: "photo",
            id: taskId(
              item && typeof item === "object" ? (item as Obj).id : undefined,
            ),
          };
          await remember(ctx, state);
        }
        avatarId = state.id;
        const until = Date.now() + 30 * 60 * 1000;
        while (true) {
          const look = object(
            jsonResponse(
              await call(
                p,
                `v3/avatars/looks/${encodeURIComponent(avatarId)}`,
                { signal: ctx.signal },
              ),
            ).data,
          );
          if (look.status === "completed") break;
          if (look.status === "failed")
            throw new ProviderError("REMOTE_FAILED", "照片人物创建失败。");
          if (!["processing", "pending_consent"].includes(str(look.status)))
            throw new ProviderError(
              "UNKNOWN_REMOTE_STATUS",
              "照片人物返回未知状态。",
            );
          if (look.status === "pending_consent")
            throw new ProviderError(
              "AVATAR_CONSENT_REQUIRED",
              "此人物需要在服务商完成同意流程。",
            );
          if (Date.now() > until)
            throw new ProviderError(
              "REMOTE_PENDING",
              "照片人物仍在创建中，已保存 ID。",
            );
          await waitPoll(ctx);
        }
      }
      if (!avatarId)
        throw new ProviderError("INVALID_INPUT", "请选择真实的人物外观 ID。");
      const body: Obj = {
        type: "avatar",
        avatar_id: avatarId,
        aspect_ratio: ratio,
        resolution: "1080p",
      };
      if (engine) {
        if (!["avatar_iv", "avatar_v", "avatar_iii"].includes(engine))
          throw new ProviderError(
            "PROVIDER_NOT_CONFIGURED",
            "请配置有效的 HeyGen avatar 引擎。",
          );
        body.engine = { type: engine };
      }
      if (cap === "avatar.text") {
        body.script = inputString(ctx, "text");
        body.voice_id = inputString(ctx, "voice");
        body.voice_settings = {
          speed: inputNumber(ctx, "speed", 1),
          volume: inputNumber(ctx, "volume", 100) / 100,
          ...(inputString(ctx, "language")
            ? {
                locale:
                  languages[inputString(ctx, "language")]?.iso ??
                  inputString(ctx, "language"),
              }
            : {}),
        };
      } else
        body.audio_asset_id = await heygenUpload(
          ctx,
          p,
          selectAsset(ctx, "audio")!,
        );
      if (cap === "avatar.photo" && inputString(ctx, "prompt")) {
        if (engine === "avatar_v" || engine === "avatar_iii")
          throw new ProviderError(
            "UNSUPPORTED_CAPABILITY",
            "当前照片动作提示仅验证 Avatar IV profile。",
          );
        body.motion_prompt = inputString(ctx, "prompt");
      }
      if (selectedStyle !== "none") body.caption = { file_format: "srt" };
      const created = await jsonCall(p, "v3/videos", body, ctx, {
        "Idempotency-Key": `${ctx.jobId}.video`,
      });
      state = {
        kind: "heygen",
        stage: "video",
        id: taskId(submittedData(created).video_id),
      };
      await remember(ctx, state);
    }
  }
  const until = Date.now() + 2 * 60 * 60 * 1000;
  const translation = state.stage === "translation";
  while (Date.now() < until) {
    const result = object(
      jsonResponse(
        await call(
          p,
          `v3/${translation ? "video-translations" : "videos"}/${encodeURIComponent(state.id)}`,
          { signal: ctx.signal },
        ),
      ).data,
    );
    const status = str(result.status);
    if (status === "completed") {
      const video = await download(
        ctx,
        result.video_url,
        "video",
        translation ? "翻译视频.mp4" : "数字人视频.mp4",
      );
      const style = translation
        ? ctx.input.subtitles === true
          ? "minimal"
          : "none"
        : selectedStyle;
      if (style !== "none")
        return burnReturnedSubtitle(
          ctx,
          video,
          translation ? result.srt_caption_url : result.subtitle_url,
          style,
        );
      return { artifacts: [video], result: { remoteId: state.id } };
    }
    if (status === "failed")
      throw new ProviderError(
        "REMOTE_FAILED",
        "服务商视频任务失败，请核对素材、人物与账户权限。",
      );
    if (!["pending", translation ? "running" : "processing"].includes(status))
      throw new ProviderError(
        "UNKNOWN_REMOTE_STATUS",
        "服务商返回未知状态，已保存任务 ID。",
      );
    await ctx.onProgress(
      status === "pending" ? 20 : 50,
      status === "pending" ? "服务商排队中" : "服务商处理中",
    );
    await waitPoll(ctx);
  }
  throw new ProviderError(
    "REMOTE_PENDING",
    "服务商任务仍在处理中，已保存任务 ID。",
  );
}
async function workflow(
  ctx: ExecutionContext,
  p: ProviderConfig,
): Promise<ExecutionResult> {
  const declared = jsonResponse(
    await call(p, "capabilities", { signal: ctx.signal }),
  );
  if (
    declared.protocol !== "workflow-http-v1" ||
    !list(declared.operations).includes(ctx.toolId)
  )
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "工作流服务未声明此协议版本或工具能力。",
    );
  let state = decodeState(ctx.remoteTaskId, "workflow");
  if (!state) {
    if (ctx.assets.length && declared.acceptsDataUrls !== true)
      throw new ProviderError(
        "UNSUPPORTED_CAPABILITY",
        "工作流服务没有声明支持本地素材 data URL 输入。",
      );
    const assets = [];
    for (const asset of ctx.assets)
      assets.push({
        id: asset.id,
        kind: asset.kind,
        mime: asset.mime,
        name: asset.name,
        dataUrl: await dataUrl(asset, 40 * 1024 * 1024),
      });
    const body = {
      protocol: "workflow-http-v1",
      idempotencyKey: ctx.jobId,
      operation: ctx.toolId,
      input: ctx.input,
      assets,
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024)
      throw new ProviderError("INPUT_TOO_LARGE", "工作流请求超过 64 MB。");
    const created = await jsonCall(p, "jobs", body, ctx, {
      "Idempotency-Key": ctx.jobId,
    });
    state = { kind: "workflow", stage: "task", id: taskId(created.jobId) };
    await remember(ctx, state);
  }
  const until = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < until) {
    const result = jsonResponse(
      await call(p, `jobs/${encodeURIComponent(state.id)}`, {
        signal: ctx.signal,
      }),
    );
    const status = str(result.status);
    if (status === "succeeded") {
      const outputs = list(result.outputs);
      if (!outputs.length)
        throw new ProviderError(
          "INVALID_RESPONSE",
          "工作流成功状态没有实际产物。",
        );
      const artifacts: GeneratedArtifact[] = [];
      for (const item of outputs) {
        const output = object(item);
        const kind = str(output.kind);
        if (!["image", "video", "audio"].includes(kind))
          throw new ProviderError(
            "INVALID_RESPONSE",
            "工作流返回未支持的产物类型。",
          );
        artifacts.push(
          await download(
            ctx,
            output.url,
            kind as MediaKind,
            str(output.name) || "工作流产物",
          ),
        );
      }
      if (
        artifacts.every((a) => a.kind !== "video") &&
        [
          "replication",
          "product-avatar",
          "link-video",
          "subtitle-remove",
        ].includes(ctx.toolId)
      )
        throw new ProviderError(
          "INVALID_ARTIFACT",
          "此工作流必须返回视频产物。",
        );
      return { artifacts, result: result.result };
    }
    if (["failed", "cancelled"].includes(status))
      throw new ProviderError(
        status === "cancelled" ? "REMOTE_CANCELLED" : "REMOTE_FAILED",
        status === "cancelled" ? "工作流已确认取消。" : "工作流执行失败。",
      );
    if (!["queued", "running"].includes(status))
      throw new ProviderError("UNKNOWN_REMOTE_STATUS", "工作流返回未知状态。");
    await ctx.onProgress(
      status === "queued" ? 15 : 45,
      status === "queued" ? "工作流排队中" : "工作流运行中",
    );
    await waitPoll(ctx);
  }
  throw new ProviderError("REMOTE_PENDING", "工作流仍未完成，已保存任务 ID。");
}
export async function runProvider(
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const orderedIds = Object.entries(ctx.input)
    .filter(([key, value]) => key.endsWith("Ids") && Array.isArray(value))
    .flatMap(([, value]) => value as string[]);
  if (orderedIds.length)
    ctx = {
      ...ctx,
      assets: [...ctx.assets].sort((a, b) => {
        const ai = orderedIds.indexOf(a.id),
          bi = orderedIds.indexOf(b.id);
        return (
          (ai < 0 ? orderedIds.length : ai) - (bi < 0 ? orderedIds.length : bi)
        );
      }),
    };
  const p = ctx.provider;
  if (!p?.apiKey || !p.baseUrl)
    throw new ProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "请先配置此工具所需的服务商和密钥。",
    );
  let base: URL;
  try {
    base = new URL(p.baseUrl);
  } catch {
    throw new ProviderError("PROVIDER_NOT_CONFIGURED", "服务商基址格式错误。");
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        process.env.CROSSCUT_ALLOW_LOCAL_PROVIDERS === "1" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  )
    throw new ProviderError("UNSAFE_URL", "服务商必须使用 HTTPS 保护密钥。");
  const cap = capability(ctx);
  if (!p.capabilities.includes(cap))
    throw new ProviderError(
      "UNSUPPORTED_CAPABILITY",
      "所选服务商没有配置此工具需要的能力。",
    );
  validateProviderSelections(p, cap, ctx.input);
  if (!ctx.remoteTaskId)
    validateProviderLimits(p, ctx.toolId, ctx.input, ctx.assets);
  ctx.signal.throwIfAborted();
  await mkdir(ctx.outputDir, { recursive: true });
  try {
    if (p.kind === "openai") return await openai(ctx, p);
    if (p.kind === "ark") return await ark(ctx, p);
    if (p.kind === "elevenlabs") return await elevenlabs(ctx, p);
    if (p.kind === "heygen") return await heygen(ctx, p);
    if (p.kind === "workflow") return await workflow(ctx, p);
    throw new ProviderError("UNSUPPORTED_PROVIDER", "不支持此服务商类型。");
  } catch (error) {
    if (acceptedSynchronousResponses.has(ctx))
      throw new ProviderError(
        "RESULT_PROCESSING_FAILED",
        "服务商已返回成功响应，但产物解析、下载或本地处理未完成；请先核对服务商记录，避免重复计费。",
      );
    throw error;
  } finally {
    acceptedSynchronousResponses.delete(ctx);
  }
}
export async function cancelProvider(
  config: ProviderConfig,
  remoteTaskId: string,
  toolId: string,
): Promise<{ cancelled: boolean; supported: boolean; message: string }> {
  const state = decodeState(remoteTaskId, config.kind);
  if (!state)
    return {
      cancelled: false,
      supported: false,
      message: "没有可取消的远程任务。",
    };
  if (config.kind === "ark") {
    const result = jsonResponse(
      await call(
        config,
        `contents/generations/tasks/${encodeURIComponent(state.id)}`,
      ),
    );
    if (result.status === "cancelled")
      return {
        cancelled: true,
        supported: true,
        message: "服务商已取消任务。",
      };
    if (result.status !== "queued")
      return {
        cancelled: false,
        supported: false,
        message:
          "服务商仅支持取消排队任务；处理中或已结束任务不能通过此操作取消。",
      };
    checkHttp(
      await call(
        config,
        `contents/generations/tasks/${encodeURIComponent(state.id)}`,
        { method: "DELETE" },
      ),
    );
    const after = jsonResponse(
      await call(
        config,
        `contents/generations/tasks/${encodeURIComponent(state.id)}`,
      ),
    );
    return {
      cancelled: after.status === "cancelled",
      supported: true,
      message:
        after.status === "cancelled"
          ? "服务商已确认取消。"
          : "取消尚未确认，将继续同步服务商状态。",
    };
  }
  if (config.kind === "workflow") {
    const caps = jsonResponse(await call(config, "capabilities"));
    if (
      caps.protocol !== "workflow-http-v1" ||
      !list(caps.operations).includes(toolId) ||
      caps.supportsCancellation !== true
    )
      return {
        cancelled: false,
        supported: false,
        message: "此工作流没有声明取消能力。",
      };
    const response = jsonResponse(
      await call(config, `jobs/${encodeURIComponent(state.id)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    if (response.status === "cancelled")
      return {
        cancelled: true,
        supported: true,
        message: "工作流已确认取消。",
      };
    return {
      cancelled: false,
      supported: response.status !== "not_supported",
      message:
        response.status === "accepted"
          ? "工作流已接收取消请求，仍需等待最终确认。"
          : "工作流尚未确认取消。",
    };
  }
  return {
    cancelled: false,
    supported: false,
    message: "当前服务未提供已验证的远程取消协议；删除产物不等于取消生成。",
  };
}

import { requiredCapability } from "./catalog.js";
import type { ExecutionAsset, ProviderPublic, ToolInput } from "./types.js";

export type LimitProvider = Pick<
  ProviderPublic,
  "kind" | "model" | "models" | "capabilities"
> & { options?: Record<string, unknown> };
export type LimitAsset = Pick<
  ExecutionAsset,
  "kind" | "width" | "height" | "size" | "duration"
>;
export interface ProviderFieldLimit {
  choices?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  visible?: boolean;
  disabled?: boolean;
  reason?: string;
}
export interface ProviderLimits {
  fields: Record<string, ProviderFieldLimit>;
  warnings: string[];
}
export class ProviderLimitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderLimitError";
  }
}
const ARK_RATIOS = ["auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const HEYGEN_RATIOS = ["auto", "16:9", "9:16", "1:1", "4:5", "5:4"];
const HEYGEN_ENGINES = ["avatar_iv", "avatar_v", "avatar_iii"];
const stringInput = (input: ToolInput, key: string, fallback = "") =>
  typeof input[key] === "string" && input[key] ? String(input[key]) : fallback;
const modelFor = (p: LimitProvider, cap: string) => p.models[cap] || p.model;
const arkMode = (toolId: string, input: ToolInput) =>
  stringInput(input, "mode", toolId === "image-video" ? "first-last" : "text");
// Unknown endpoint aliases retain the conservative adapter profile. The model
// name alone never establishes remote entitlement or arbitrary model support.
const ark25 = (model: string) =>
  /^(doubao|dreamina)-seedance-2-5(?:-|$)/.test(model);
const requiresTranslation = (input: ToolInput) => {
  const target = stringInput(input, "targetLanguage");
  return (
    !!target &&
    target !== "original" &&
    target !== stringInput(input, "language")
  );
};
const translationConfigured = (p: LimitProvider) => {
  const model = modelFor(p, "chat");
  return (
    p.capabilities.includes("chat") &&
    !!model &&
    model !== "whisper-1" &&
    !/^gpt-4o(?:-mini)?-transcribe(?:-|$)/.test(model)
  );
};

/** Limits of this adapter profile; these are not promises of model/account support. */
export function getProviderLimits(
  provider: LimitProvider,
  toolId: string,
  input: ToolInput,
): ProviderLimits {
  const cap = requiredCapability(toolId, input);
  const model = modelFor(provider, cap);
  const fields: ProviderLimits["fields"] = {};
  const warnings = [
    "以下为当前适配器允许的参数范围；模型、地区和账号的实际支持仍须由服务商确认。",
  ];
  if (provider.kind === "ark" && cap === "video.task") {
    const mode = arkMode(toolId, input);
    const firstLast25 = ark25(model) && mode === "first-last";
    fields.ratio = {
      choices: firstLast25 ? ["auto"] : ARK_RATIOS,
      reason: firstLast25
        ? "此 2.5 首尾帧 profile 必须保持首帧比例。"
        : "当前 Ark 视频 profile 的画幅范围。",
    };
    fields.duration = {
      min: 4,
      max: ark25(model) ? 30 : 15,
      integer: true,
      reason: "时长须为整数秒；未知模型使用保守的 4–15 秒适配范围。",
    };
    fields.format = { choices: ["mp4", "mov"], reason: "MOV 由本地转码生成。" };
    fields.mode = { choices: ["text", "first-last", "reference"] };
    fields.sourceIds = {
      visible: mode !== "text",
      min: mode === "text" ? 0 : 1,
      max: mode === "text" ? 0 : mode === "first-last" ? 2 : 9,
      reason:
        mode === "first-last"
          ? "按首帧、尾帧顺序选择 1–2 张图片。"
          : "参考模式最多 9 张图片；文字模式不接收参考素材。",
    };
    fields.audioIds = {
      visible: mode === "reference",
      min: 0,
      max: mode === "reference" ? 3 : 0,
      reason: "仅参考模式支持至多 3 段音频，且必须同时提供图片。",
    };
    fields.videoIds = {
      visible: false,
      disabled: true,
      max: 0,
      reason: "当前 Ark 适配器未接入本机参考视频的公网上传。",
    };
    warnings.push(
      "参考图片需满足边长 300–6000 像素、宽高比 0.4–2.5；音频不能单独作为参考。",
    );
    if (!/^(doubao|dreamina)-seedance-/.test(model))
      warnings.push(
        "该模型或端点别名未识别为已知 Seedance profile；没有推断其真实生成能力。",
      );
  }
  if (provider.kind === "heygen" && cap.startsWith("avatar.")) {
    fields.ratio = {
      choices: HEYGEN_RATIOS,
      reason: "当前 HeyGen 数字人 profile 的画幅范围。",
    };
    fields.quality = {
      choices: ["standard"],
      reason: "专业模式的供应商参数尚未验证。",
    };
    if (cap === "avatar.photo") {
      const motion = !model || model === "avatar_iv";
      fields.prompt = {
        visible: motion,
        disabled: !motion,
        reason:
          "照片动作提示仅在 Avatar IV profile 支持；空引擎沿用服务商默认引擎，需确认账号配置。",
      };
    }
  }
  if (provider.kind === "heygen" && cap === "video.translate")
    fields.voice = {
      visible: false,
      disabled: true,
      reason: "此翻译 profile 保留原声，不支持指定替换音色。",
    };
  if (
    provider.kind === "elevenlabs" &&
    ["speech", "voice.clone"].includes(cap)
  ) {
    fields.speed = {
      min: model === "eleven_v3" ? 1 : 0.7,
      max: model === "eleven_v3" ? 1 : 1.2,
      disabled: model === "eleven_v3",
      reason:
        model === "eleven_v3"
          ? "此 v3 profile 仅支持默认语速 1。"
          : "当前 ElevenLabs 配音 profile 支持语速 0.7–1.2。",
    };
    if (model === "eleven_multilingual_v2")
      warnings.push("此模型按输入原文语言朗读，语言选择不会自动翻译配音文案。");
  }
  if (provider.kind === "openai" && cap === "transcription") {
    if (
      model !== "whisper-1" &&
      provider.options?.timestampTranscription !== true
    )
      warnings.push(
        "当前模型尚未声明支持 verbose_json 分段时间码，不能执行此字幕 profile。",
      );
    fields.targetLanguage = {
      disabled: !translationConfigured(provider),
      reason: "跨语言字幕还需要同一服务商的 chat 能力及模型；原语转写不需要。",
    };
    warnings.push(
      "提取的 16 kHz 单声道 WAV 必须不超过 25 MB。该大小在提取音轨后再次验证。",
    );
  }
  return { fields, warnings };
}

/** Call before any external request. Asset descriptors must come from owned, probed assets. */
export function validateProviderLimits(
  provider: LimitProvider,
  toolId: string,
  input: ToolInput,
  assets: readonly LimitAsset[] = [],
): void {
  const cap = requiredCapability(toolId, input);
  const model = modelFor(provider, cap);
  const fail = (code: string, message: string): never => {
    throw new ProviderLimitError(code, message);
  };
  const fields = getProviderLimits(provider, toolId, input).fields;
  for (const [key, rule] of Object.entries(fields)) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      rule.choices &&
      typeof value === "string" &&
      !rule.choices.includes(value)
    )
      fail(
        "UNSUPPORTED_CAPABILITY",
        rule.reason || `当前适配器不支持 ${key} 的所选值。`,
      );
    const numeric =
      typeof value === "number"
        ? value
        : Array.isArray(value)
          ? value.length
          : undefined;
    if (
      numeric !== undefined &&
      (!Number.isFinite(numeric) ||
        (rule.min !== undefined && numeric < rule.min) ||
        (rule.max !== undefined && numeric > rule.max) ||
        (rule.integer && !Number.isInteger(numeric)))
    )
      fail("INVALID_INPUT", rule.reason || `${key} 超出当前适配器限制。`);
  }
  if (provider.kind === "ark" && cap === "video.task") {
    if (!model) fail("PROVIDER_NOT_CONFIGURED", "请配置视频模型 ID。");
    if (assets.some((asset) => asset.kind === "video"))
      fail("UNSUPPORTED_CAPABILITY", "当前 Ark 适配器不接收本机参考视频。");
    const images = assets.filter((asset) => asset.kind === "image");
    const audio = assets.filter((asset) => asset.kind === "audio");
    const mode = arkMode(toolId, input);
    if (mode === "text" && (images.length || audio.length))
      fail(
        "INVALID_INPUT",
        "文字模式不能忽略已选择的参考素材，请切换参考模式。",
      );
    if (
      mode === "first-last" &&
      (images.length < 1 || images.length > 2 || audio.length)
    )
      fail("INVALID_INPUT", "首尾帧模式只接受 1–2 张图片，不能添加音频参考。");
    if (
      mode === "reference" &&
      (!images.length || images.length > 9 || audio.length > 3)
    )
      fail("INVALID_INPUT", "参考模式需要 1–9 张图片，可附加至多 3 段音频。");
    for (const image of images) {
      if (
        !image.width ||
        !image.height ||
        Math.min(image.width, image.height) < 300 ||
        Math.max(image.width, image.height) > 6000 ||
        image.width / image.height < 0.4 ||
        image.width / image.height > 2.5
      )
        fail(
          "INVALID_INPUT",
          "参考图片需满足边长 300–6000 像素、宽高比 0.4–2.5。",
        );
      if (image.size > 30 * 1024 * 1024)
        fail("INPUT_TOO_LARGE", "图片参考超过适配器 30 MB 上限。");
    }
    if (audio.some((asset) => asset.size > 15 * 1024 * 1024))
      fail("INPUT_TOO_LARGE", "音频参考超过适配器 15 MB 上限。");
  }
  if (provider.kind === "heygen" && cap.startsWith("avatar.")) {
    if (model && !HEYGEN_ENGINES.includes(model))
      fail("PROVIDER_NOT_CONFIGURED", "请配置有效的 HeyGen avatar 引擎。");
    if (
      cap === "avatar.photo" &&
      stringInput(input, "prompt") &&
      ["avatar_v", "avatar_iii"].includes(model)
    )
      fail(
        "UNSUPPORTED_CAPABILITY",
        "当前照片动作提示仅验证 Avatar IV profile。",
      );
  }
  if (
    provider.kind === "heygen" &&
    cap === "video.translate" &&
    stringInput(input, "voice")
  )
    fail(
      "UNSUPPORTED_CAPABILITY",
      "当前翻译 profile 保留原声，不能指定替换音色。",
    );
  if (
    provider.kind === "elevenlabs" &&
    ["speech", "voice.clone"].includes(cap) &&
    !model
  )
    fail("PROVIDER_NOT_CONFIGURED", "请配置配音或克隆试听使用的 TTS 模型。");
  if (provider.kind === "openai" && cap === "transcription") {
    if (!model) fail("PROVIDER_NOT_CONFIGURED", "请配置字幕识别模型。");
    if (
      model !== "whisper-1" &&
      provider.options?.timestampTranscription !== true
    )
      fail(
        "UNSUPPORTED_CAPABILITY",
        "字幕流程需要支持 verbose_json 分段时间码的识别模型。",
      );
    if (requiresTranslation(input) && !translationConfigured(provider))
      fail(
        "PROVIDER_NOT_CONFIGURED",
        "跨语言字幕需要先配置同一服务商的 chat 能力及模型，尚未调用识别服务。",
      );
  }
}

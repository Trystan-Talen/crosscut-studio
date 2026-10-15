import type { Field, ProviderPublic, ToolInput } from "../../shared/types";
import type { ProviderFieldLimit } from "../../shared/provider-limits";
import {
  OPENAI_VOICES,
  openaiBuiltInVoices,
} from "../../shared/provider-voices";
import { AssetField } from "../ui";
import { ProviderDirectoryField } from "./ProviderDirectoryField";

export function readableLimit(text: string) {
  return text
    .replace(
      "当前模型尚未声明支持 verbose_json 分段时间码，不能执行此字幕 profile。",
      "非 whisper-1 模型需在服务器声明支持分段时间码；提交前会检查该能力。",
    )
    .replaceAll("profile", "配置")
    .replaceAll("适配器", "接入方式");
}
export function providerOptions(
  provider: ProviderPublic | undefined,
  key: string,
) {
  if (!provider) return [];
  if (key === "avatar")
    return provider.avatars.map((item) => ({
      value: item.id,
      label: `${item.name}${item.scene ? ` · ${item.scene}` : ""}`,
    }));
  if (key !== "voice") return [];
  const allowedBuiltIns = openaiBuiltInVoices(
    provider.models.speech ?? provider.model,
  );
  const declared = provider.voices
    .filter(
      (item) =>
        provider.kind !== "openai" ||
        !OPENAI_VOICES.includes(item.id) ||
        allowedBuiltIns.includes(item.id),
    )
    .map((item) => ({
      value: item.id,
      label: `${item.name}${item.language ? ` · ${item.language}` : ""}`,
    }));
  const builtIn =
    provider.kind === "openai"
      ? allowedBuiltIns.map((id) => ({ value: id, label: `${id} · 内置音色` }))
      : [];
  return [
    ...declared,
    ...builtIn.filter(
      (item) => !declared.some((voice) => voice.value === item.value),
    ),
  ];
}
export function ToolField({
  field,
  value,
  onChange,
  provider,
  limit,
}: {
  field: Field;
  value: ToolInput[string] | undefined;
  onChange: (value: ToolInput[string]) => void;
  provider?: ProviderPublic;
  limit?: ProviderFieldLimit;
}) {
  const id = `field-${field.key}`;
  const isDirectory = ["voice", "avatar"].includes(field.key);
  const voiceOptions = isDirectory ? providerOptions(provider, field.key) : [];
  const allOptions = voiceOptions.length ? voiceOptions : (field.options ?? []);
  const options = limit?.choices
    ? allOptions.filter((option) => limit.choices!.includes(option.value))
    : allOptions;
  const minimum = Math.max(field.min ?? -Infinity, limit?.min ?? -Infinity);
  const maximum = Math.min(field.max ?? Infinity, limit?.max ?? Infinity);
  const numeric =
    typeof value === "number"
      ? value
      : Array.isArray(value)
        ? value.length
        : undefined;
  const invalidChoice =
    !!limit?.choices &&
    typeof value === "string" &&
    !!value &&
    !limit.choices.includes(value);
  const invalidRange =
    numeric !== undefined &&
    (numeric < minimum ||
      numeric > maximum ||
      (!!limit?.integer && !Number.isInteger(numeric)));
  const hasValue =
    value !== undefined &&
    value !== "" &&
    value !== false &&
    (!Array.isArray(value) || value.length > 0);
  const invalid = invalidChoice || invalidRange;
  const reason = limit?.reason ? readableLimit(limit.reason) : "";
  const correction =
    limit?.min !== undefined && limit.min === limit.max
      ? limit.min
      : field.default;
  if (limit?.visible === false)
    return (
      <div className="field full-field">
        <span className="field-label">{field.label}</span>
        <small>{reason || "当前服务不支持此选项。"}</small>
        {hasValue && (
          <>
            <p className="field-error">
              已保留原值
              {Array.isArray(value)
                ? `（${value.length} 份素材）`
                : `：${String(value)}`}
              。请清除或切换支持它的模式/服务。
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onChange(
                  Array.isArray(value)
                    ? []
                    : typeof value === "boolean"
                      ? false
                      : "",
                )
              }
            >
              清除此项已保存内容
            </button>
          </>
        )}
      </div>
    );
  if (isDirectory)
    return (
      <ProviderDirectoryField
        key={`${provider?.id ?? "none"}:${field.key}`}
        field={field}
        value={value}
        provider={provider}
        options={options}
        onChange={onChange}
        disabled={limit?.disabled}
        reason={reason}
      />
    );
  if (field.type === "assets")
    return (
      <div className="field full-field">
        <span className="field-label">
          {field.label}
          {field.required && <em>*</em>}
        </span>
        <AssetField
          label={field.label}
          value={Array.isArray(value) ? value : []}
          accepts={field.accepts}
          max={Number.isFinite(maximum) ? maximum : 100}
          help={field.help}
          onChange={onChange}
        />
        {field.help && <small>{field.help}</small>}
        {reason && <small>{reason}</small>}
        {invalidRange && hasValue && (
          <small className="field-error">
            已保留当前选择，请调整素材数量。
          </small>
        )}
      </div>
    );
  if (field.type === "boolean")
    return (
      <label className="switch-field" htmlFor={id}>
        <span>
          {field.label}
          {field.help && <small>{field.help}</small>}
        </span>
        <input
          id={id}
          type="checkbox"
          disabled={limit?.disabled}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch" aria-hidden="true" />
      </label>
    );
  return (
    <label
      className={`field ${field.type === "textarea" ? "full-field" : ""}`}
      htmlFor={id}
    >
      <span>
        {field.label}
        {field.required && <em>*</em>}
      </span>
      {field.type === "textarea" ? (
        <div className="textarea-wrap">
          <textarea
            id={id}
            required={field.required}
            disabled={limit?.disabled}
            maxLength={field.maxLength}
            value={String(value ?? "")}
            placeholder={field.placeholder}
            rows={5}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.maxLength && (
            <small className="char-count">
              {String(value ?? "").length} / {field.maxLength}
            </small>
          )}
        </div>
      ) : field.type === "select" || isDirectory ? (
        <select
          id={id}
          required={field.required}
          disabled={limit?.disabled || (isDirectory && !voiceOptions.length)}
          aria-invalid={invalid || undefined}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {isDirectory && !voiceOptions.length
              ? "请先在设置中登记此服务的目录"
              : `请选择${field.label}`}
          </option>
          {invalidChoice && (
            <option value={String(value)} disabled>
              {optionLabels[String(value)] ?? String(value)}
              （当前服务不支持，请更改）
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {optionLabels[option.value] ?? option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          required={field.required}
          min={Number.isFinite(minimum) ? minimum : undefined}
          max={Number.isFinite(maximum) ? maximum : undefined}
          step={
            field.type === "number" ? (limit?.integer ? 1 : "any") : undefined
          }
          disabled={limit?.disabled}
          aria-invalid={invalid || undefined}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          value={
            typeof value === "boolean" || Array.isArray(value)
              ? ""
              : (value ?? "")
          }
          onChange={(e) =>
            onChange(
              field.type === "number" && e.target.value !== ""
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
      {field.help && <small>{field.help}</small>}
      {reason && <small>{reason}</small>}
      {invalid && (
        <small className="field-error">
          已保留原值，请调整为当前服务支持的参数。
        </small>
      )}
      {limit?.disabled &&
        (invalid || field.key === "targetLanguage") &&
        correction !== undefined &&
        JSON.stringify(value) !== JSON.stringify(correction) && (
          <button
            type="button"
            className="text-button"
            onClick={(event) => {
              event.preventDefault();
              onChange(correction);
            }}
          >
            使用允许的默认值
          </button>
        )}
      {["voice", "avatar"].includes(field.key) && (
        <small>
          {provider
            ? `${provider.name}：${voiceOptions.length ? "仅显示该服务的已配置目录" : "请先在设置中登记你有权使用的 ID；登记不代表账户授权已验证"}`
            : "先选择模型服务，再选择该服务的角色或音色"}
        </small>
      )}
    </label>
  );
}
const optionLabels: Record<string, string> = {
  auto: "自适应",
  text: "文字生成",
  reference: "多模态参考",
  "first-last": "首尾帧",
  generate: "文生图",
  edit: "图生图 / 图像编辑",
  low: "快速",
  medium: "均衡",
  high: "精细",
  standard: "标准模式",
  professional: "专业模式",
  none: "无字幕",
  minimal: "简约字幕",
  bold: "醒目字幕",
  contrast: "高对比字幕",
  cover: "区域遮挡（本地）",
  crop: "裁切字幕区域（本地）",
  inpaint: "智能修复（需服务）",
  follow: "跟随参考视频",
  on: "开启",
  off: "关闭",
  mp4: "MP4",
  mov: "MOV",
};

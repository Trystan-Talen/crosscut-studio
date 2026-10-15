import { useState } from "react";
import { Search } from "lucide-react";
import type { Field, ProviderPublic, ToolInput } from "../../shared/types";

interface DirectoryItem {
  value: string;
  label: string;
  language?: string;
  gender?: string;
  scene?: string;
}
interface DirectoryFilters {
  search: string;
  language: string;
  gender: string;
  scene: string;
}
export function directoryView(
  items: DirectoryItem[],
  filters: DirectoryFilters,
  selected: string,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  const matches = items.filter(
    (item) =>
      (!search ||
        `${item.label} ${item.value}`.toLocaleLowerCase().includes(search)) &&
      (!filters.language || item.language === filters.language) &&
      (!filters.gender || item.gender === filters.gender) &&
      (!filters.scene || item.scene === filters.scene),
  );
  const current = items.find((item) => item.value === selected);
  return {
    matches,
    preserved: current && !matches.includes(current) ? current : undefined,
  };
}
export function ProviderDirectoryField({
  field,
  value,
  provider,
  options,
  onChange,
  disabled,
  reason,
}: {
  field: Field;
  value: ToolInput[string] | undefined;
  provider?: ProviderPublic;
  options: { value: string; label: string }[];
  onChange: (value: ToolInput[string]) => void;
  disabled?: boolean;
  reason?: string;
}) {
  const voice = field.key === "voice";
  const label = voice ? "音色" : "角色";
  const id = `field-${field.key}`;
  const [filters, setFilters] = useState<DirectoryFilters>({
    search: "",
    language: "",
    gender: "",
    scene: "",
  });
  const items: DirectoryItem[] = options.map((option) => {
    const metadata = voice
      ? provider?.voices.find((item) => item.id === option.value)
      : provider?.avatars.find((item) => item.id === option.value);
    return {
      ...option,
      gender: metadata?.gender,
      language:
        metadata && "language" in metadata ? metadata.language : undefined,
      scene: metadata && "scene" in metadata ? metadata.scene : undefined,
    };
  });
  const choices = (key: "language" | "gender" | "scene") =>
    [...new Set(items.flatMap((item) => (item[key] ? [item[key]!] : [])))].sort(
      (a, b) => a.localeCompare(b, "zh-CN"),
    );
  const selected = String(value ?? "");
  const { matches, preserved } = directoryView(items, filters, selected);
  const genderLabel = (gender: string) =>
    ({
      male: voice ? "男声" : "男性",
      female: voice ? "女声" : "女性",
      unknown: "未标注",
    })[gender] ?? gender;
  const hasFilters = Object.values(filters).some(Boolean);
  return (
    <div className="field directory-field">
      <label className="field-label" htmlFor={id}>
        {field.label}
        {field.required && <em>*</em>}
      </label>
      {items.length > 0 && (
        <div className="directory-filters">
          <label className="directory-search">
            <Search size={14} />
            <input
              aria-label={`搜索${label}名称或 ID`}
              placeholder={`搜索${label}名称或 ID`}
              maxLength={300}
              value={filters.search}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  search: event.target.value,
                }))
              }
            />
          </label>
          <div className="directory-filter-row">
            <label>
              <span>{voice ? "语言" : "场景"}</span>
              <select
                aria-label={`${label}${voice ? "语言" : "场景"}筛选`}
                value={voice ? filters.language : filters.scene}
                disabled={!choices(voice ? "language" : "scene").length}
                onChange={(event) =>
                  setFilters((previous) => ({
                    ...previous,
                    [voice ? "language" : "scene"]: event.target.value,
                  }))
                }
              >
                <option value="">
                  {choices(voice ? "language" : "scene").length
                    ? "全部"
                    : "目录未标注"}
                </option>
                {choices(voice ? "language" : "scene").map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>性别</span>
              <select
                aria-label={`${label}性别筛选`}
                value={filters.gender}
                disabled={!choices("gender").length}
                onChange={(event) =>
                  setFilters((previous) => ({
                    ...previous,
                    gender: event.target.value,
                  }))
                }
              >
                <option value="">
                  {choices("gender").length ? "全部" : "目录未标注"}
                </option>
                {choices("gender").map((item) => (
                  <option key={item} value={item}>
                    {genderLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <small role="status">
              匹配 {matches.length} / {items.length} 个{label}
            </small>
            {hasFilters && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setFilters({
                    search: "",
                    language: "",
                    gender: "",
                    scene: "",
                  })
                }
              >
                清除筛选
              </button>
            )}
          </div>
        </div>
      )}
      <select
        id={id}
        required={field.required}
        disabled={disabled || !items.length}
        value={selected}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">
          {items.length ? `请选择${label}` : "请先在设置中登记此服务的目录"}
        </option>
        {preserved && (
          <option value={preserved.value}>
            {preserved.label}（当前选择，不符合筛选）
          </option>
        )}
        {matches.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label} · {item.value}
          </option>
        ))}
      </select>
      {preserved && (
        <small className="directory-preserved">
          当前选择不符合筛选，仍然保留。重新选择才会更换{label}。
        </small>
      )}
      {!matches.length && items.length > 0 && (
        <small>没有匹配目录项，可以调整或清除筛选。</small>
      )}
      {field.help && <small>{field.help}</small>}
      {reason && <small>{reason}</small>}
      <small>
        {provider
          ? `${provider.name}：${items.length ? "仅显示该服务的目录，登记不代表账户权限已验证。" : "请先在设置中登记你有权使用的 ID。"}`
          : "先选择模型服务，再选择该服务的角色或音色。"}
      </small>
      {voice && items.length > 0 && (
        <small>目录未提供试听文件；可在 AI 配音中提交短文案生成样音。</small>
      )}
    </div>
  );
}

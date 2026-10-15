import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";

export function MultiFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = [...new Set([...options, ...value])]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .filter((option) => option.toLowerCase().includes(search.toLowerCase()));
  return (
    <details
      className={`multi-filter ${value.length ? "has-selection" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        {label}
        {value.length > 0 && <span>{value.length}</span>}
        <ChevronDown size={14} />
      </summary>
      <div className="multi-filter-popover">
        <label className="search">
          <Search size={14} />
          <input
            aria-label={`搜索${label}`}
            placeholder={`搜索${label}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="row">
          <small>{value.length ? `已选 ${value.length} 项` : "不限制"}</small>
          <button
            type="button"
            className="text-button"
            disabled={!value.length}
            onClick={() => onChange([])}
          >
            清除
          </button>
        </div>
        <div className="multi-filter-options" role="group" aria-label={label}>
          {filtered.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={value.includes(option)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, option]
                      : value.filter((item) => item !== option),
                  )
                }
              />
              <span>{option}</span>
            </label>
          ))}
          {!filtered.length && (
            <p className="small muted">
              {options.length ? "没有匹配选项" : "添加参考广告后，可在这里筛选"}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

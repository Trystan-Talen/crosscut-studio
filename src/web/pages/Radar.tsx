import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  ArrowUpDown,
  Bookmark,
  ChevronDown,
  Compass,
  ExternalLink,
  Heart,
  Plus,
  RotateCcw,
  Search,
  Upload,
} from "lucide-react";
import type { RadarAsset } from "../../shared/types";
import { message, navigate, post, queryString, useQuery } from "../api";
import { useWorkspace } from "../context";
import { MultiFilter } from "../components/MultiFilter";
import "./library-filters.css";
import {
  AssetField,
  Drawer,
  Empty,
  ErrorPanel,
  Loading,
  MediaPreview,
  Notice,
  PageTitle,
} from "../ui";

const count = (v: number | null) =>
  v == null
    ? "未知"
    : new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(v);
const formatLabels: Record<string, string> = {
  vertical: "竖屏",
  horizontal: "横屏",
  square: "方形",
};
export function Radar() {
  const { notify } = useWorkspace();
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [country, setCountry] = useState<string[]>([]);
  const [industry, setIndustry] = useState<string[]>([]);
  const [objective, setObjective] = useState<string[]>([]);
  const [format, setFormat] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [sort, setSort] = useState("likes");
  const [order, setOrder] = useState("desc");
  const [importing, setImporting] = useState(false);
  const [focused, setFocused] = useState<RadarAsset | null>(null);
  const all = useQuery<{ items: RadarAsset[] }>("/radar", { items: [] });
  const list = useQuery<{ items: RadarAsset[]; total: number }>(
    `/radar?${queryString({ search: submitted, country: country.join(","), industryPaths: industry.length ? JSON.stringify(industry) : undefined, objective: objective.join(","), format, tags: tags.length ? JSON.stringify(tags) : undefined, from: dateBoundary(from), before: dateBoundary(through, true), favorite: favorite ? 1 : undefined, sort, order })}`,
    { items: [], total: 0 },
  );
  const filtered = !!(
    submitted ||
    country.length ||
    industry.length ||
    objective.length ||
    format ||
    tags.length ||
    from ||
    through
  );
  async function bookmark(item: RadarAsset) {
    try {
      const updated = await post<RadarAsset>(`/radar/${item.id}/favorite`, {
        favorite: !item.favorite,
      });
      if (focused?.id === item.id) setFocused(updated);
      list.refresh();
      all.refresh();
    } catch (e) {
      notify(message(e));
    }
  }
  function reset() {
    setSearch("");
    setSubmitted("");
    setCountry([]);
    setIndustry([]);
    setObjective([]);
    setFormat("");
    setTags([]);
    setFrom("");
    setThrough("");
    setFavorite(false);
    setSort("likes");
    setOrder("desc");
  }
  return (
    <>
      <PageTitle
        eyebrow="RESEARCH BEFORE YOU CREATE"
        title="好创意，从观察开始。"
        description="整理你有权使用的参考广告，连接指标、镜头与下一次创作。"
        actions={
          <button className="button primary" onClick={() => setImporting(true)}>
            <Plus size={17} />
            添加参考广告
          </button>
        }
      />
      <div className="radar-intro">
        <Compass size={22} />
        <p>
          这是你的私人灵感库。素材与指标来自你导入的数据，不包含参考平台的专有广告数据库。
        </p>
      </div>
      <div className="panel radar-filters">
        <form
          className="search radar-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(search);
          }}
        >
          <Search size={17} />
          <input
            aria-label="搜索参考广告"
            placeholder="搜索标题、品牌、来源链接或 ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="button primary small-button">搜索</button>
        </form>
        <div className="filter-row">
          <MultiFilter
            label="国家 / 地区"
            value={country}
            onChange={setCountry}
            options={all.data.items.map((a) => a.country).filter(Boolean)}
          />
          <IndustryFilter
            value={industry}
            onChange={setIndustry}
            items={all.data.items}
          />
          <MultiFilter
            label="关联素材标签"
            value={tags}
            onChange={setTags}
            options={all.data.items.flatMap((item) => item.asset?.tags ?? [])}
          />
          <MultiFilter
            label="推广目标"
            value={objective}
            onChange={setObjective}
            options={all.data.items.map((a) => a.objective).filter(Boolean)}
          />
          <select
            aria-label="素材版式"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="">全部版式</option>
            <option value="vertical">竖屏</option>
            <option value="horizontal">横屏</option>
            <option value="square">方形</option>
          </select>
          <button
            className="icon-button"
            title="重置筛选"
            aria-label="重置筛选"
            onClick={reset}
          >
            <RotateCcw size={17} />
          </button>
        </div>
        <div className="collection-date-filters radar-dates">
          <span>添加日期</span>
          <label>
            <span>开始</span>
            <input
              type="date"
              aria-label="参考广告添加开始日期"
              value={from}
              max={through || undefined}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <span aria-hidden="true">—</span>
          <label>
            <span>结束（含当天）</span>
            <input
              type="date"
              aria-label="参考广告添加结束日期"
              value={through}
              min={from || undefined}
              onChange={(event) => setThrough(event.target.value)}
            />
          </label>
          <small>本地管理功能 · 当前设备时区</small>
        </div>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button
            className={!favorite ? "active" : ""}
            onClick={() => {
              setFavorite(false);
              if (sort === "favorite_at") setSort("created_at");
            }}
          >
            全部灵感 <span>{all.data.items.length}</span>
          </button>
          <button
            className={favorite ? "active" : ""}
            onClick={() => {
              setFavorite(true);
              setSort("favorite_at");
              setOrder("desc");
            }}
          >
            <Bookmark size={15} />
            我的收藏
          </button>
        </div>
        <div className="actions">
          <span className="small muted">{list.data.total} 条参考</span>
          <select
            aria-label="排序指标"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {favorite && <option value="favorite_at">按收藏时间</option>}
            {[
              ["likes", "按点赞"],
              ["shares", "按分享"],
              ["comments", "按评论"],
              ["ctr", "按点击率"],
              ["budget", "按预算"],
              ["created_at", "按添加时间"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label={
              order === "desc" ? "降序，点击改升序" : "升序，点击改降序"
            }
            onClick={() => setOrder(order === "desc" ? "asc" : "desc")}
          >
            <ArrowUpDown size={17} />
          </button>
        </div>
      </div>
      {list.error && <ErrorPanel error={list.error} retry={list.refresh} />}
      {list.loading ? (
        <Loading />
      ) : list.data.items.length ? (
        <div className="radar-grid">
          {list.data.items.map((item) => (
            <article className="radar-card" key={item.id}>
              <button
                className="radar-cover"
                onClick={() => setFocused(item)}
                aria-label={`查看${item.title}分析`}
              >
                {item.asset ? (
                  <MediaPreview asset={item.asset} compact />
                ) : (
                  <div className="reference-placeholder">
                    <Compass size={40} strokeWidth={1.1} />
                    <span>参考资料</span>
                  </div>
                )}
                <span className="radar-industry">
                  {item.industry || "未分类"}
                </span>
                <span className="radar-likes">
                  <Heart size={13} />
                  {count(item.likes)}
                </span>
              </button>
              <div className="radar-info">
                <button
                  className="radar-title"
                  onClick={() => setFocused(item)}
                >
                  {item.title}
                </button>
                <p>{item.brand || "未标注品牌"}</p>
                {!!item.asset?.tags.length && (
                  <div
                    className="asset-tags radar-linked-tags"
                    aria-label="关联素材标签"
                  >
                    {item.asset.tags.slice(0, 5).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                )}
                <div className="row">
                  <span className="small muted">
                    CTR <b>{item.ctr == null ? "未知" : `${item.ctr}%`}</b>
                  </span>
                  <button
                    className={`bookmark ${item.favorite ? "selected" : ""}`}
                    onClick={() => void bookmark(item)}
                    aria-label={
                      item.favorite
                        ? `取消收藏${item.title}`
                        : `收藏${item.title}`
                    }
                    aria-pressed={item.favorite}
                  >
                    <Bookmark
                      size={16}
                      fill={item.favorite ? "currentColor" : "none"}
                    />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={Compass}
            title={
              filtered
                ? "没有找到匹配的参考"
                : favorite
                  ? "把值得研究的素材收藏起来"
                  : "为灵感建立一座素材库"
            }
            detail={
              filtered
                ? "调整行业、标签或添加日期；清除筛选后可以查看全部参考。"
                : favorite
                  ? "点击参考广告的收藏按钮，下次更快找到它。"
                  : "添加有权使用的视频与指标，或批量导入 JSON 数据。"
            }
          >
            {(submitted ||
              country.length ||
              industry.length ||
              objective.length ||
              format ||
              tags.length ||
              from ||
              through) && (
              <button className="button secondary" onClick={reset}>
                重置筛选
              </button>
            )}
            <button
              className="button secondary"
              onClick={() => setImporting(true)}
            >
              <Upload size={16} />
              导入参考资料
            </button>
          </Empty>
        </section>
      )}
      <Drawer
        open={importing}
        title="添加参考广告"
        onClose={() => setImporting(false)}
        wide
      >
        <RadarImport
          onDone={() => {
            setImporting(false);
            list.refresh();
            all.refresh();
            notify("参考广告已保存");
          }}
        />
      </Drawer>
      <Drawer
        open={!!focused}
        title="参考素材分析"
        onClose={() => setFocused(null)}
        wide
      >
        {focused && (
          <RadarDetail
            item={focused}
            onBookmark={() => void bookmark(focused)}
          />
        )}
      </Drawer>
    </>
  );
}
function IndustryFilter({
  items,
  value,
  onChange,
}: {
  items: RadarAsset[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const nodes = new Map<
    string,
    { path: string; label: string; depth: number; count: number }
  >();
  for (const item of items) {
    if (!item.industry) continue;
    const parts = item.industry.split("/").map((part) => part.trim());
    parts.forEach((label, index) => {
      const path = parts.slice(0, index + 1).join(" / ");
      const node = nodes.get(path) ?? { path, label, depth: index, count: 0 };
      node.count++;
      nodes.set(path, node);
    });
  }
  const allNodes = [...nodes.values()].sort((a, b) =>
    a.path.localeCompare(b.path, "zh-CN"),
  );
  const visible = new Set<string>();
  for (const node of allNodes) {
    if (
      node.path.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    ) {
      const parts = node.path.split(" / ");
      parts.forEach((_, index) =>
        visible.add(parts.slice(0, index + 1).join(" / ")),
      );
    }
  }
  return (
    <details
      className={`multi-filter industry-tree ${value.length ? "has-selection" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        行业分类{value.length > 0 && <span>{value.length}</span>}
        <ChevronDown size={14} />
      </summary>
      <div className="multi-filter-popover">
        <label className="search">
          <Search size={14} />
          <input
            aria-label="搜索行业分类"
            placeholder="搜索父类或子类"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="row">
          <small>选择父类包含全部下级</small>
          <button
            type="button"
            className="text-button"
            disabled={!value.length}
            onClick={() => onChange([])}
          >
            清除
          </button>
        </div>
        <div
          className="multi-filter-options"
          role="group"
          aria-label="行业层级分类"
        >
          {allNodes
            .filter((node) => visible.has(node.path))
            .map((node) => {
              const ancestorSelected = value.some((selected) =>
                node.path.startsWith(`${selected} / `),
              );
              const checked = value.includes(node.path) || ancestorSelected;
              const partial =
                !checked &&
                value.some((selected) =>
                  selected.startsWith(`${node.path} / `),
                );
              return (
                <label
                  key={node.path}
                  className={ancestorSelected ? "included-by-parent" : ""}
                  style={{ paddingLeft: `${4 + node.depth * 16}px` }}
                >
                  <input
                    type="checkbox"
                    aria-label={`${node.path}，${node.count} 条`}
                    checked={checked}
                    ref={(input) => {
                      if (input) input.indeterminate = partial;
                    }}
                    disabled={
                      ancestorSelected || (!checked && value.length >= 50)
                    }
                    onChange={(event) => {
                      const remaining = value.filter(
                        (selected) =>
                          selected !== node.path &&
                          !selected.startsWith(`${node.path} / `),
                      );
                      onChange(
                        event.target.checked
                          ? [...remaining, node.path]
                          : remaining,
                      );
                    }}
                  />
                  <span>{node.label}</span>
                  <small>{node.count}</small>
                </label>
              );
            })}
          {!visible.size && (
            <p className="small muted">
              {items.length
                ? "没有匹配行业"
                : "导入含行业分类的参考资料后显示层级"}
            </p>
          )}
        </div>
        <p className="small muted">
          数量来自本地全部参考记录，包含子分类；同级多选取并集。
        </p>
      </div>
    </details>
  );
}
function dateBoundary(value: string, afterDay = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (afterDay) date.setDate(date.getDate() + 1);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function RadarImport({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState("single");
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    try {
      if (mode === "json") {
        const parsed: unknown = JSON.parse(data.json);
        const items = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && "items" in parsed
            ? (parsed as { items: unknown }).items
            : null;
        if (!Array.isArray(items))
          throw new Error("导入内容应为数组，或包含 items 数组的对象。");
        await post("/radar/import", { items });
      } else {
        const payload: Record<string, unknown> = {
          ...data,
          assetId: ids[0] ?? null,
          metrics: [],
        };
        for (const key of ["likes", "shares", "comments", "ctr", "budget"])
          payload[key] = data[key] === "" ? null : Number(data[key]);
        await post("/radar", payload);
      }
      onDone();
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? "JSON 格式不正确，请检查后重试。"
          : message(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="tabs">
        <button
          className={mode === "single" ? "active" : ""}
          onClick={() => setMode("single")}
        >
          添加单条
        </button>
        <button
          className={mode === "json" ? "active" : ""}
          onClick={() => setMode("json")}
        >
          批量导入 JSON
        </button>
      </div>
      <form onSubmit={(e) => void submit(e)}>
        {mode === "json" ? (
          <>
            <label className="field">
              <span>参考广告 JSON 数据</span>
              <textarea
                required
                name="json"
                rows={15}
                spellCheck={false}
                placeholder={
                  '[\n  {"title":"广告标题", "brand":"品牌", "country":"美国", "industry":"美妆 / 护肤", "objective":"转化", "format":"vertical", "sourceUrl":"https://…", "assetId":null, "likes":null, "shares":null, "comments":null, "ctr":null, "budget":null, "metrics":[]}\n]'
                }
              />
            </label>
            <p className="small muted">
              industry 保留单层文字兼容，也支持“父类 /
              子类”路径，最多5级；选择父类将包括全部下级。分类和数量仅根据你导入的记录生成。关联素材标签在素材库中维护。
            </p>
            <p className="small muted">
              metrics 支持 time、retention、clicks、ctr、conversions、cvr
              字段。没有的指标请填 null 或留空数组，不应填入推测数据。
            </p>
          </>
        ) : (
          <>
            <label className="field">
              <span>参考标题 *</span>
              <input required name="title" maxLength={500} />
            </label>
            <div className="form-two">
              {[
                ["brand", "品牌"],
                ["country", "国家 / 地区"],
                ["objective", "推广目标"],
              ].map(([name, label]) => (
                <label className="field" key={name}>
                  <span>{label}</span>
                  <input name={name} maxLength={100} />
                </label>
              ))}
              <label className="field">
                <span>行业分类路径</span>
                <input
                  name="industry"
                  maxLength={300}
                  placeholder="例如：美妆 / 护肤 / 精华"
                />
                <small>用 / 分隔，最多5级；单层行业也可使用。</small>
              </label>
            </div>
            <label className="field">
              <span>来源链接</span>
              <input name="sourceUrl" type="url" placeholder="https://…" />
            </label>
            <label className="field">
              <span>画面版式</span>
              <select name="format">
                <option value="vertical">竖屏</option>
                <option value="horizontal">横屏</option>
                <option value="square">方形</option>
              </select>
            </label>
            <div className="field">
              <span className="field-label">
                关联已授权视频 <small>选填，拆解与复刻时需要</small>
              </span>
              <AssetField
                label="参考视频"
                value={ids}
                onChange={setIds}
                accepts={["video"]}
                max={1}
              />
            </div>
            <details className="details">
              <summary>投放指标（选填）</summary>
              <div className="settings-grid">
                {[
                  ["likes", "点赞"],
                  ["shares", "分享"],
                  ["comments", "评论"],
                  ["ctr", "CTR（%）"],
                  ["budget", "预算"],
                ].map(([name, label]) => (
                  <label className="field" key={name}>
                    <span>{label}</span>
                    <input
                      name={name}
                      type="number"
                      min="0"
                      step="any"
                      placeholder="未知请留空"
                    />
                  </label>
                ))}
              </div>
            </details>
          </>
        )}
        <Notice>
          请导入你有权使用的资料。数据只在本地保存，添加链接不会自动抓取或下载外部视频。
        </Notice>
        {error && <ErrorPanel error={error} />}
        <button className="button primary" disabled={busy}>
          {busy
            ? "正在保存…"
            : mode === "json"
              ? "导入参考广告"
              : "保存参考广告"}
        </button>
      </form>
    </>
  );
}
function RadarDetail({
  item,
  onBookmark,
}: {
  item: RadarAsset;
  onBookmark: () => void;
}) {
  const [metric, setMetric] = useState<
    "retention" | "clicks" | "ctr" | "conversions" | "cvr"
  >("retention");
  const values = item.metrics.filter((m) => typeof m[metric] === "number");
  const max = Math.max(1, ...values.map((v) => v[metric] ?? 0));
  const maxTime = Math.max(1, ...values.map((v) => v.time));
  const path = values
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${20 + (v.time / maxTime) * 580},${175 - ((v[metric] ?? 0) / max) * 150}`,
    )
    .join(" ");
  return (
    <>
      {item.asset ? (
        <MediaPreview asset={item.asset} />
      ) : (
        <Empty
          icon={Compass}
          title="未关联本地视频"
          detail="这条参考保存了指标和来源。添加视频后才可进入拆解与复刻。"
        />
      )}
      <div className="detail-title">
        <p className="eyebrow">{item.brand || "REFERENCE AD"}</p>
        <h2>{item.title}</h2>
        <button className="button secondary" onClick={onBookmark}>
          <Bookmark size={16} fill={item.favorite ? "currentColor" : "none"} />
          {item.favorite ? "已收藏" : "收藏参考"}
        </button>
      </div>
      <div className="radar-metrics">
        {[
          ["点赞", count(item.likes)],
          ["分享", count(item.shares)],
          ["评论", count(item.comments)],
          ["CTR", item.ctr == null ? "未知" : `${item.ctr}%`],
          ["预算", count(item.budget)],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <dl className="metadata-grid">
        {[
          ["国家 / 地区", item.country],
          ["行业", item.industry],
          ["推广目标", item.objective],
          ["版式", formatLabels[item.format] ?? item.format],
        ].map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value || "未知"}</dd>
          </div>
        ))}
      </dl>
      {!!item.asset?.tags.length && (
        <div className="radar-detail-tags">
          <span className="small muted">关联素材标签（在素材库编辑）</span>
          <div className="asset-tags">
            {item.asset.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </div>
      )}
      {item.sourceUrl && (
        <a
          className="text-button"
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          查看原始来源 <ExternalLink size={14} />
        </a>
      )}
      <section className="metrics-chart">
        <h3>逐秒表现</h3>
        <div className="tabs">
          {(
            [
              ["retention", "留存"],
              ["clicks", "点击"],
              ["ctr", "CTR"],
              ["conversions", "转化"],
              ["cvr", "CVR"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={metric === key ? "active" : ""}
              onClick={() => setMetric(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {values.length ? (
          <>
            <svg
              viewBox="0 0 620 210"
              role="img"
              aria-label={`${metric}逐秒数据曲线，数据来自导入记录`}
            >
              <path d="M20 20V175H605" stroke="#dce2d8" fill="none" />
              <path d={path} fill="none" stroke="#4f7746" strokeWidth="3" />
              <text x="20" y="200" fontSize="12">
                0s
              </text>
              <text x="560" y="200" fontSize="12">
                {maxTime}s
              </text>
            </svg>
            <p className="small muted">
              图表直接显示导入的数据，不推断缺失时间点或实际投放效果。
            </p>
          </>
        ) : (
          <Empty
            title="没有这项逐秒指标"
            detail="你可以在导入时提供真实数据；此处不会补造表现曲线。"
          />
        )}
      </section>
      <div className="drawer-footer">
        <button
          className="button secondary"
          disabled={!item.assetId}
          onClick={() =>
            navigate("analysis", { asset: item.assetId ?? undefined })
          }
        >
          拆解这条视频
        </button>
        <button
          className="button primary"
          disabled={!item.assetId}
          onClick={() =>
            navigate("replication", { asset: item.assetId ?? undefined })
          }
        >
          创作我的版本 <ArrowRight size={16} />
        </button>
      </div>
    </>
  );
}

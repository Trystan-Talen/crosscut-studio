import { useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  Film,
  FolderOpen,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { Asset } from "../../shared/types";
import {
  bytes,
  date,
  duration,
  message,
  patch,
  post,
  queryString,
  useQuery,
} from "../api";
import { useWorkspace } from "../context";
import { MultiFilter } from "../components/MultiFilter";
import "./library-filters.css";
import {
  Drawer,
  Empty,
  ErrorPanel,
  Loading,
  MediaPreview,
  Notice,
  PageTitle,
  UploadButton,
} from "../ui";
const kinds = [
  ["", "全部素材"],
  ["video", "视频"],
  ["image", "图片"],
  ["audio", "音频"],
  ["subtitle", "字幕"],
  ["document", "文档"],
];
export function Library() {
  const { refresh, notify } = useWorkspace();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");
  const [sort, setSort] = useState("newest");
  const [trash, setTrash] = useState(false);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery<{ items: Asset[]; total: number; tags: string[] }>(
    `/assets?${queryString({ search, kind, tags: tags.length ? JSON.stringify(tags) : undefined, from: dateBoundary(from), before: dateBoundary(through, true), sort, trash: trash ? 1 : 0 })}`,
    { items: [], total: 0, tags: [] },
  );
  const filtered = !!(search || kind || tags.length || from || through);
  function resetFilters() {
    setSearch("");
    setKind("");
    setTags([]);
    setFrom("");
    setThrough("");
    setSort("newest");
  }
  async function change(asset: Asset, deleted: boolean) {
    try {
      await patch(`/assets/${asset.id}`, { deleted });
      list.refresh();
      refresh();
      setSelected(null);
      notify(deleted ? "已移入回收站，可随时恢复" : "素材已恢复");
    } catch (e) {
      notify(message(e));
    }
  }
  async function demo() {
    setBusy(true);
    try {
      await post("/assets/demo");
      refresh();
      list.refresh();
      notify("已添加 Crosscut 本地示例素材，素材来源标记为示例");
    } catch (e) {
      notify(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const item = await patch<Asset>(`/assets/${selected.id}`, {
        name: String(form.get("name")),
        tags: String(form.get("tags"))
          .split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean),
      });
      setSelected(item);
      refresh();
      list.refresh();
      notify("素材信息已保存");
    } catch (e) {
      notify(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="YOUR MATERIALS, TOGETHER"
        title="每一份素材，都有下一种可能。"
        description="整理图片、镜头、声音和字幕，让创作随时开始。"
        actions={
          <UploadButton
            onUploaded={() => {
              list.refresh();
              refresh();
              notify("素材已上传");
            }}
          />
        }
      />
      <div className="library-heading">
        <div className="tabs">
          <button
            className={!trash ? "active" : ""}
            onClick={() => setTrash(false)}
          >
            <FolderOpen size={16} />
            全部素材
          </button>
          <button
            className={trash ? "active" : ""}
            onClick={() => setTrash(true)}
          >
            <Trash2 size={16} />
            回收站
          </button>
        </div>
        <span className="small muted">{list.data.total} 份素材</span>
      </div>
      <div className="toolbar collection-toolbar">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="搜索素材名称、标签或 ID"
            placeholder="搜索素材名称、标签或 ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="素材类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {kinds.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <MultiFilter
          label="素材标签"
          options={list.data.tags}
          value={tags}
          onChange={setTags}
        />
        <select
          aria-label="素材排序"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="newest">最近添加</option>
          <option value="oldest">最早添加</option>
          <option value="name">名称顺序</option>
          <option value="size">文件从大到小</option>
        </select>
        {!trash && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void demo()}
          >
            <Plus size={15} />
            添加明确标记的示例素材
          </button>
        )}
      </div>
      <div className="collection-date-filters">
        <span>添加日期</span>
        <label>
          <span>开始</span>
          <input
            type="date"
            aria-label="素材添加开始日期"
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
            aria-label="素材添加结束日期"
            value={through}
            min={from || undefined}
            onChange={(event) => setThrough(event.target.value)}
          />
        </label>
        <small>按当前设备时区筛选</small>
        {(filtered || sort !== "newest") && (
          <button className="text-button" onClick={resetFilters}>
            <RotateCcw size={14} />
            重置筛选
          </button>
        )}
      </div>
      {trash && (
        <Notice>
          回收站中的素材不会出现在创作选择器。已有任务保留输入记录，你可以恢复素材继续使用。
        </Notice>
      )}
      {list.error && <ErrorPanel error={list.error} retry={list.refresh} />}
      {list.loading ? (
        <Loading />
      ) : list.data.items.length ? (
        <div className="asset-grid library-grid">
          {list.data.items.map((asset) => (
            <article className="asset-card" key={asset.id}>
              <button
                className="asset-open"
                onClick={() => setSelected(asset)}
                aria-label={`预览${asset.name}`}
              >
                <MediaPreview asset={asset} compact />
                <span className="media-kind">
                  {kinds.find(([k]) => k === asset.kind)?.[1]}
                  {asset.duration ? ` · ${duration(asset.duration)}` : ""}
                </span>
              </button>
              <div className="asset-card-info">
                <button
                  className="asset-name"
                  onClick={() => setSelected(asset)}
                >
                  {asset.name}
                </button>
                <div className="row">
                  <span>
                    {bytes(asset.size)} · {date(asset.createdAt)}
                  </span>
                  {asset.source.includes("demo") && (
                    <span className="tiny-badge">示例</span>
                  )}
                </div>
                <div className="asset-tags">
                  {asset.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
              <div className="asset-card-actions">
                <a
                  className="text-button"
                  href={`/api/assets/${asset.id}/file?download=1`}
                >
                  <ArrowDownToLine size={14} />
                  下载
                </a>
                <button
                  className="text-button"
                  onClick={() => void change(asset, !trash)}
                >
                  {trash ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                  {trash ? "恢复" : "移入回收站"}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={trash ? Trash2 : Film}
            title={
              filtered
                ? "没有找到符合筛选的素材"
                : trash
                  ? "回收站是空的"
                  : "从第一份素材开始"
            }
            detail={
              filtered
                ? "调整名称、标签、类型或添加日期，也可以清除筛选后查看全部。"
                : trash
                  ? "暂时移走的素材会保存在这里。"
                  : "上传产品图片、参考视频或口播音频，在这里建立你的创作素材库。"
            }
          >
            {filtered && (
              <button className="button secondary" onClick={resetFilters}>
                清除筛选
              </button>
            )}
            {!trash && (
              <UploadButton
                onUploaded={() => {
                  list.refresh();
                  refresh();
                }}
              />
            )}
          </Empty>
        </div>
      )}
      <Drawer
        open={!!selected}
        title="素材详情"
        onClose={() => setSelected(null)}
        wide
      >
        {selected && (
          <>
            <MediaPreview asset={selected} />
            <div className="metadata-grid">
              <div>
                <span>文件类型</span>
                <b>{selected.mime}</b>
              </div>
              <div>
                <span>文件大小</span>
                <b>{bytes(selected.size)}</b>
              </div>
              <div>
                <span>分辨率 / 时长</span>
                <b>
                  {selected.width
                    ? `${selected.width} × ${selected.height}`
                    : "—"}{" "}
                  {duration(selected.duration)}
                </b>
              </div>
              <div>
                <span>来源</span>
                <b>{selected.source}</b>
              </div>
            </div>
            <form onSubmit={(e) => void rename(e)} key={selected.id}>
              <label className="field">
                <span>素材名称</span>
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={selected.name}
                />
              </label>
              <label className="field">
                <span>标签</span>
                <input
                  name="tags"
                  placeholder="用逗号分隔，例如：护肤、美国、产品图"
                  defaultValue={selected.tags.join("，")}
                />
              </label>
              <div className="actions">
                <button className="button primary" disabled={busy}>
                  保存信息
                </button>
                <a
                  className="button secondary"
                  href={`/api/assets/${selected.id}/file?download=1`}
                >
                  <ArrowDownToLine size={16} />
                  下载原文件
                </a>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void change(selected, !trash)}
                >
                  {trash ? "恢复素材" : "移入回收站"}
                </button>
              </div>
            </form>
          </>
        )}
      </Drawer>
    </>
  );
}
function dateBoundary(value: string, afterDay = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (afterDay) date.setDate(date.getDate() + 1);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

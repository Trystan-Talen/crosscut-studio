import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Film,
  Image,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
  Video,
  X,
  FileText,
  Folder,
  ScanLine,
  WandSparkles,
  Mic,
  Scissors,
  Languages,
  Subtitles,
  PersonStanding,
  type LucideIcon,
} from "lucide-react";
import type { Asset, Job, MediaKind, Tool } from "../shared/types";
import {
  api,
  ApiError,
  bytes,
  date,
  duration,
  message,
  navigate,
  post,
  useQuery,
} from "./api";
import { useWorkspace } from "./context";

const icons: Record<string, LucideIcon> = {
  clapperboard: Film,
  imageplay: Video,
  link: Film,
  userround: PersonStanding,
  userroundpen: PersonStanding,
  userroundcheck: PersonStanding,
  contactround: PersonStanding,
  shoppingbag: Layers3,
  audiolines: AudioLines,
  scaneye: ScanLine,
  scantext: ScanLine,
  wandSparkles: WandSparkles,
  wandsparkles: WandSparkles,
  copyplus: Layers3,
  monitorplay: Video,
  galleryverticalend: Image,
  split: Scissors,
  crop: Scissors,
  eraser: Scissors,
  captions: Subtitles,
  filetext: FileText,
  image: Image,
  video: Video,
  film: Film,
  audio: AudioLines,
  sparkles: Sparkles,
  layers: Layers3,
  scissors: Scissors,
  mic: Mic,
  languages: Languages,
  subtitles: Subtitles,
  person: PersonStanding,
  scan: ScanLine,
  wand: WandSparkles,
  file: FileText,
  folder: Folder,
};
export function ToolIcon({ name, size = 22 }: { name: string; size?: number }) {
  const Icon = icons[name.toLowerCase()] ?? Sparkles;
  return <Icon size={size} strokeWidth={1.6} />;
}
export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function Empty({
  icon: Icon = Layers3,
  title,
  detail,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Icon size={30} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}
export function Notice({
  children,
  danger = false,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      className={`notice ${danger ? "danger" : ""}`}
      role={danger ? "alert" : undefined}
    >
      <CircleAlert size={17} />
      <div>{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} /> 正在读取创作空间…
    </div>
  );
}
export function ErrorPanel({
  error,
  retry,
}: {
  error: string;
  retry?: () => void;
}) {
  return (
    <Notice danger>
      {error}
      {retry && (
        <button className="text-button" onClick={retry}>
          重新加载
        </button>
      )}
    </Notice>
  );
}
export const statuses: Record<string, string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  needs_review: "待核对",
};
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {statuses[status] ?? status}
    </span>
  );
}
export function Availability({ tool }: { tool: Tool }) {
  return (
    <span
      className={`availability ${tool.availability === "local" ? "is-local" : tool.availability === "configured" ? "is-ready" : ""}`}
    >
      {tool.availability === "local"
        ? "本地处理"
        : tool.availability === "configured"
          ? "服务已配置"
          : "需配置服务"}
    </span>
  );
}
export function Drawer({
  open,
  title,
  children,
  onClose,
  wide = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`drawer ${wide ? "wide" : ""}`}
      aria-labelledby={heading}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="drawer-inner">
        <div className="drawer-head">
          <h2 id={heading}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭面板"
          >
            <X size={20} />
          </button>
        </div>
        <div className="drawer-body">{open && children}</div>
      </div>
    </dialog>
  );
}
export function MediaPreview({
  asset,
  compact = false,
}: {
  asset: Asset;
  compact?: boolean;
}) {
  return (
    <div className={`media-preview ${compact ? "compact" : ""}`}>
      {asset.kind === "image" ? (
        <img src={asset.url} alt={asset.name} loading="lazy" />
      ) : asset.kind === "video" ? (
        compact ? (
          <>
            <img
              src={asset.thumbnailUrl || `/api/assets/${asset.id}/thumbnail`}
              alt=""
              loading="lazy"
            />
            <Play size={28} className="play-overlay" />
          </>
        ) : (
          <video src={asset.url} controls preload="metadata" playsInline />
        )
      ) : asset.kind === "audio" ? (
        compact ? (
          <AudioLines size={36} />
        ) : (
          <audio src={asset.url} controls preload="metadata" />
        )
      ) : (
        <FileText size={36} />
      )}
    </div>
  );
}
export function UploadButton({
  onUploaded,
  kinds,
  children = "上传素材",
  multiple = true,
}: {
  onUploaded: (assets: Asset[]) => void;
  kinds?: MediaKind[];
  children?: ReactNode;
  multiple?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const { notify } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    for (const file of files) form.append("files", file);
    try {
      const result = await api<{ items: Asset[] }>("/assets", {
        method: "POST",
        body: form,
      });
      onUploaded(result.items);
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.details &&
        typeof e.details === "object" &&
        "items" in e.details &&
        Array.isArray(e.details.items) &&
        e.details.items.length
      ) {
        onUploaded(e.details.items as Asset[]);
        notify(message(e));
      }
      setError(message(e));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  const accept = kinds
    ?.flatMap((kind) =>
      kind === "image"
        ? ["image/png", "image/jpeg", "image/webp"]
        : kind === "video"
          ? ["video/mp4", "video/quicktime", "video/webm"]
          : kind === "audio"
            ? ["audio/mpeg", "audio/wav", "audio/mp4"]
            : kind === "subtitle"
              ? [".srt"]
              : [],
    )
    .join(",");
  return (
    <>
      <input
        ref={ref}
        className="sr-only"
        tabIndex={-1}
        aria-label="选择上传文件"
        type="file"
        multiple={multiple}
        accept={accept}
        onChange={(e) => void upload(e.target.files)}
      />
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => ref.current?.click()}
      >
        {busy ? (
          <LoaderCircle size={17} className="spin" />
        ) : (
          <Upload size={17} />
        )}
        {busy ? "正在上传…" : children}
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
export function AssetPicker({
  open,
  onClose,
  onSelect,
  selected = [],
  kinds,
  max = 100,
  title = "选择素材",
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (ids: string[]) => void;
  selected?: string[];
  kinds?: MediaKind[];
  max?: number;
  title?: string;
}) {
  const { refresh } = useWorkspace();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string[]>(selected);
  const list = useQuery<{ items: Asset[]; total: number }>(
    open ? `/assets?search=${encodeURIComponent(query)}` : null,
    { items: [], total: 0 },
  );
  useEffect(() => {
    if (open) setSelection(selected);
  }, [open]);
  const items = list.data.items.filter(
    (a) => !kinds?.length || kinds.includes(a.kind),
  );
  function toggle(id: string) {
    setSelection((value) =>
      value.includes(id)
        ? value.filter((v) => v !== id)
        : max === 1
          ? [id]
          : value.length < max
            ? [...value, id]
            : value,
    );
  }
  return (
    <Drawer open={open} title={title} onClose={onClose} wide>
      <div className="toolbar">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="搜索素材"
            placeholder="搜索素材名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <UploadButton
          kinds={kinds}
          onUploaded={(assets) => {
            list.refresh();
            refresh();
            setSelection((value) =>
              [...value, ...assets.map((a) => a.id)].slice(0, max),
            );
          }}
        />
      </div>
      <p className="muted small">
        最多选择 {max} 项 · 已选 {selection.length} 项
        {kinds?.length
          ? ` · ${kinds.map((kind) => ({ image: "图片", video: "视频", audio: "音频", subtitle: "字幕", document: "文档" })[kind]).join(" / ")}`
          : ""}
      </p>
      {list.error && <ErrorPanel error={list.error} retry={list.refresh} />}
      {list.loading ? (
        <Loading />
      ) : items.length ? (
        <div className="asset-grid picker-grid">
          {items.map((asset) => (
            <button
              className={`asset-tile ${selection.includes(asset.id) ? "selected" : ""}`}
              type="button"
              key={asset.id}
              onClick={() => toggle(asset.id)}
              aria-pressed={selection.includes(asset.id)}
            >
              <MediaPreview asset={asset} compact />
              <span className="asset-check">
                {selection.includes(asset.id) && <Check size={14} />}
              </span>
              <strong>{asset.name}</strong>
              <span>
                {bytes(asset.size)} {duration(asset.duration)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="这里还没有合适的素材"
          detail="上传图片、视频或音频，随后即可用于创作。"
        />
      )}
      <div className="drawer-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            onSelect(selection);
            onClose();
          }}
        >
          使用所选素材 <ArrowRight size={16} />
        </button>
      </div>
    </Drawer>
  );
}
export function AssetField({
  label,
  value,
  onChange,
  accepts,
  max = 100,
  help,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  accepts?: MediaKind[];
  max?: number;
  help?: string;
}) {
  const [open, setOpen] = useState(false);
  const { assets, refresh } = useWorkspace();
  return (
    <div className="asset-field">
      <div className="selected-assets">
        {value.map((id) => {
          const asset = assets.find((a) => a.id === id);
          return (
            <div className="selected-asset" key={id}>
              {asset && <MediaPreview asset={asset} compact />}
              <span>{asset?.name ?? `素材 ${id.slice(0, 8)}`}</span>
              <button
                type="button"
                aria-label={`移除${asset?.name ?? "素材"}`}
                className="icon-button"
                onClick={() => onChange(value.filter((v) => v !== id))}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="asset-add" onClick={() => setOpen(true)}>
        <Plus size={20} />
        <span>
          {value.length ? "管理所选素材" : `添加${label}`}
          <small>{help ?? "从素材库选择，或上传新文件"}</small>
        </span>
      </button>
      <AssetPicker
        title={`选择${label}`}
        open={open}
        selected={value}
        kinds={accepts}
        max={max}
        onClose={() => setOpen(false)}
        onSelect={(ids) => {
          onChange(ids);
          refresh();
        }}
      />
    </div>
  );
}
export function JobRow({ job, onClick }: { job: Job; onClick: () => void }) {
  const { tools } = useWorkspace();
  return (
    <button className="job-row" onClick={onClick}>
      <span className="job-symbol">
        <Film size={20} />
      </span>
      <span className="job-main">
        <strong>{job.title}</strong>
        <small>
          {date(job.createdAt)} ·{" "}
          {tools.find((tool) => tool.id === job.toolId)?.title ?? "创作任务"}
        </small>
      </span>
      <Status status={job.status} />
      <ChevronRight size={17} />
    </button>
  );
}
export function JobPanel({
  id,
  onClose,
  reuse,
}: {
  id: string | null;
  onClose: () => void;
  reuse?: (job: Job) => void;
}) {
  const { notify, refresh } = useWorkspace();
  const task = useQuery<Job | null>(id ? `/jobs/${id}` : null, null, 2500);
  const [busy, setBusy] = useState(false);
  const job = task.data;
  async function action(type: string) {
    if (!job) return;
    setBusy(true);
    try {
      await post(`/jobs/${job.id}/${type}`);
      task.refresh();
      refresh();
      notify(
        type === "cancel"
          ? "已提交取消请求，请以任务最终状态为准"
          : "任务已重新排队，详情保留原有记录",
      );
    } catch (e) {
      notify(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer open={!!id} title="任务详情" onClose={onClose} wide>
      {task.error && <ErrorPanel error={task.error} retry={task.refresh} />}
      {task.loading && !job ? (
        <Loading />
      ) : (
        job && (
          <>
            <div className="row">
              <div>
                <h2>{job.title}</h2>
                <p className="small muted">
                  {date(job.createdAt)} · {job.id}
                </p>
              </div>
              <Status status={job.status} />
            </div>
            {(job.status === "running" || job.status === "queued") && (
              <div className="progress-block">
                <progress max="100" value={job.progress} />
                <span>
                  服务报告进度 {job.progress}%
                  {job.cancelRequested ? " · 正在请求取消" : ""}
                </span>
              </div>
            )}
            {job.error && (
              <Notice danger>
                {job.error}
                {job.errorCode && (
                  <small className="block">{job.errorCode}</small>
                )}
              </Notice>
            )}
            {job.status === "needs_review" && (
              <Notice>
                远程服务的受理结果尚未确定。请核对服务商任务记录后处理，避免重复付费提交。
              </Notice>
            )}
            <div className="actions wrap">
              {["queued", "running"].includes(job.status) && (
                <button
                  className="button secondary"
                  disabled={busy || job.cancelRequested}
                  onClick={() => void action("cancel")}
                >
                  取消任务
                </button>
              )}
              {["failed", "cancelled"].includes(job.status) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void action("retry")}
                >
                  <RefreshCw size={16} />
                  重新执行
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => {
                  if (reuse) reuse(job);
                  else navigate("studio", { tool: job.toolId, job: job.id });
                  onClose();
                }}
              >
                复用配置
              </button>
              {job.outputs.length > 0 && (
                <a
                  className="button primary"
                  href={`/api/jobs/${job.id}/download`}
                >
                  <ArrowDownToLine size={16} />
                  下载全部产物
                </a>
              )}
            </div>
            {job.outputs.length ? (
              <div className="result-grid">
                {job.outputs.map((asset) => (
                  <div className="output-card" key={asset.id}>
                    <MediaPreview asset={asset} />
                    <div className="row">
                      <span className="truncate">{asset.name}</span>
                      <a
                        className="icon-button"
                        href={`/api/assets/${asset.id}/file?download=1`}
                        aria-label={`下载${asset.name}`}
                      >
                        <ArrowDownToLine size={17} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : job.status === "succeeded" && !job.result ? (
              <Notice>任务没有可显示的产物。</Notice>
            ) : null}
            {job.result != null && (
              <section className="result-text">
                <h3>生成结果</h3>
                <StructuredResult value={job.result} />
              </section>
            )}
            <details className="details">
              <summary>输入快照</summary>
              <pre>{JSON.stringify(job.input, null, 2)}</pre>
            </details>
            <details className="details" open>
              <summary>处理记录</summary>
              {job.events?.length ? (
                <ol className="event-list">
                  {job.events.map((event) => (
                    <li key={event.id}>
                      <Clock3 size={14} />
                      <div>
                        <span>{event.message}</span>
                        <small>{date(event.createdAt)}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted small">暂无处理事件</p>
              )}
            </details>
          </>
        )
      )}
    </Drawer>
  );
}
export function StructuredResult({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <div className="prose-result">{value}</div>;
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    const textKey = ["text", "content", "script", "prompt"].find(
      (key) => typeof result[key] === "string",
    );
    if (textKey)
      return <div className="prose-result">{String(result[textKey])}</div>;
    if (result.mode === "local") {
      const metrics = [
        ...(typeof result.width === "number" &&
        typeof result.height === "number"
          ? [["画面尺寸", `${result.width} × ${result.height} px`]]
          : []),
        ...(typeof result.duration === "number"
          ? [
              [
                "成片时长",
                `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(result.duration)} 秒`,
              ],
            ]
          : []),
        ...(Array.isArray(result.sourceOrder)
          ? [["素材片段", `${result.sourceOrder.length} 个`]]
          : []),
      ];
      return (
        <>
          <dl className="result-facts">
            {metrics.map(([label, content]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{content}</dd>
              </div>
            ))}
          </dl>
          <details className="details">
            <summary>技术详情</summary>
            <pre className="json-result">{JSON.stringify(value, null, 2)}</pre>
          </details>
        </>
      );
    }
    if (Array.isArray(result.mechanisms))
      return (
        <>
          {typeof result.summary === "string" && (
            <p className="prose-result">{result.summary}</p>
          )}
          <div className="mechanism-list">
            {result.mechanisms.map((entry, index) => {
              const item = entry as Record<string, unknown>;
              return (
                <article className="mechanism-card" key={index}>
                  <span className="eyebrow">
                    机制 {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{String(item.name ?? "创意机制")}</h3>
                  <dl>
                    <dt>镜头证据</dt>
                    <dd>{String(item.evidence ?? "")}</dd>
                    <dt>优化建议</dt>
                    <dd>{String(item.suggestion ?? "")}</dd>
                  </dl>
                </article>
              );
            })}
          </div>
        </>
      );
    if (result.mode === "technical" || Array.isArray(result.timeline))
      return (
        <>
          {typeof result.summary === "string" && (
            <p className="prose-result">{result.summary}</p>
          )}
          {typeof result.limitations === "string" && (
            <p className="small muted">{result.limitations}</p>
          )}
          {result.mode === "technical" && (
            <dl className="result-facts">
              {typeof result.sceneCount === "number" && (
                <div>
                  <dt>检测到的镜头</dt>
                  <dd>{result.sceneCount} 段</dd>
                </div>
              )}
              {typeof result.duration === "number" && (
                <div>
                  <dt>视频时长</dt>
                  <dd>
                    {new Intl.NumberFormat("zh-CN", {
                      maximumFractionDigits: 2,
                    }).format(result.duration)}{" "}
                    秒
                  </dd>
                </div>
              )}
            </dl>
          )}
          <details className="details">
            <summary>查看完整结构化数据</summary>
            <pre className="json-result">{JSON.stringify(value, null, 2)}</pre>
          </details>
        </>
      );
  }
  return (
    <details className="details">
      <summary>技术详情</summary>
      <pre className="json-result">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function CopyButton({
  text,
  label = "复制",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  const { notify } = useWorkspace();
  return (
    <button
      type="button"
      className="button secondary small-button"
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => notify("无法访问剪贴板，请选择文本复制。"))
      }
    >
      {done ? <CheckCircle2 size={15} /> : <Copy size={15} />}
      {done ? "已复制" : label}
    </button>
  );
}

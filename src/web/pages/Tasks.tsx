import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import type { Draft, Job } from "../../shared/types";
import {
  date,
  message,
  navigate,
  patch,
  queryString,
  remove,
  useQuery,
} from "../api";
import { useWorkspace } from "../context";
import { BatchSummary } from "../components/BatchSummary";
import { isWorkflowDraft } from "../workflow-state";
import {
  Empty,
  ErrorPanel,
  JobPanel,
  Loading,
  PageTitle,
  Status,
  statuses,
} from "../ui";
export function Tasks({ params }: { params: URLSearchParams }) {
  const { tools, notify } = useWorkspace();
  const [tab, setTab] = useState(params.get("tab") ?? "jobs");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [toolId, setToolId] = useState("");
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(20);
  const [job, setJob] = useState<string | null>(params.get("id"));
  const [draftTrash, setDraftTrash] = useState(false);
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [draftError, setDraftError] = useState("");
  const jobs = useQuery<{ items: Job[]; total: number }>(
    `/jobs?${queryString({ search, status, toolId, offset: page * size, limit: size })}`,
    { items: [], total: 0 },
    4000,
  );
  const drafts = useQuery<{ items: Draft[]; total: number }>("/drafts", {
    items: [],
    total: 0,
  });
  const trashDrafts = useQuery<{ items: Draft[]; total: number }>(
    tab === "drafts" && draftTrash ? "/drafts?trash=1" : null,
    { items: [], total: 0 },
  );
  const currentDrafts = draftTrash ? trashDrafts : drafts;
  const visibleDrafts = currentDrafts.data.items.filter((draft) =>
    draft.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  async function changeDraft(draft: Draft, restore: boolean) {
    setDraftBusy(draft.id);
    setDraftError("");
    try {
      if (restore) await patch(`/drafts/${draft.id}`, { deleted: false });
      else await remove(`/drafts/${draft.id}`);
      drafts.refresh();
      trashDrafts.refresh();
      notify(
        restore
          ? "草稿已恢复，可在我的草稿中继续编辑"
          : "草稿已移入回收站，可随时恢复",
      );
    } catch (error) {
      setDraftError(message(error));
    } finally {
      setDraftBusy(null);
    }
  }
  const batches = new Map<string, Job[]>();
  jobs.data.items.forEach((item) =>
    batches.set(item.batchId, [...(batches.get(item.batchId) ?? []), item]),
  );
  return (
    <>
      <PageTitle
        eyebrow="EVERY CREATION HAS A STORY"
        title="每一次创作，都有迹可循。"
        description="查看真实处理进度，继续编辑草稿，下载完成的作品。"
        actions={
          <button className="button primary" onClick={() => navigate("studio")}>
            <Plus size={17} />
            新建创作
          </button>
        }
      />
      <div className="toolbar">
        <div className="tabs">
          <button
            className={tab === "jobs" ? "active" : ""}
            onClick={() => setTab("jobs")}
          >
            任务记录
          </button>
          <button
            className={tab === "drafts" ? "active" : ""}
            onClick={() => setTab("drafts")}
          >
            我的草稿 <span>{drafts.data.total}</span>
          </button>
        </div>
        <label className="search">
          <Search size={17} />
          <input
            aria-label="搜索任务或草稿"
            placeholder="搜索创作名称"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
      </div>
      {tab === "jobs" ? (
        <>
          <div className="task-filters">
            <select
              aria-label="筛选任务状态"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option value="">全部状态</option>
              {Object.entries(statuses).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选工具"
              value={toolId}
              onChange={(e) => {
                setToolId(e.target.value);
                setPage(0);
              }}
            >
              <option value="">全部工具</option>
              {tools.map((tool) => (
                <option value={tool.id} key={tool.id}>
                  {tool.title}
                </option>
              ))}
            </select>
            <span className="small muted">
              共 {jobs.data.total} 项任务 · 自动更新真实状态
            </span>
          </div>
          {[...batches.values()].map((items) => (
            <BatchSummary
              key={items[0].batchId}
              jobs={items}
              onChanged={jobs.refresh}
            />
          ))}
          {jobs.error && <ErrorPanel error={jobs.error} retry={jobs.refresh} />}
          <div className="panel table-panel">
            {jobs.loading && !jobs.data.items.length ? (
              <Loading />
            ) : jobs.data.items.length ? (
              <>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>创作名称</th>
                        <th>工具</th>
                        <th>创建时间</th>
                        <th>状态</th>
                        <th>产物</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.data.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <button
                              className="table-link"
                              onClick={() => setJob(item.id)}
                            >
                              {item.title}
                            </button>
                            <small>{item.id.slice(0, 8)}</small>
                          </td>
                          <td>
                            {tools.find((t) => t.id === item.toolId)?.title ??
                              item.toolId}
                          </td>
                          <td>{date(item.createdAt)}</td>
                          <td>
                            <Status status={item.status} />
                            {item.status === "running" && (
                              <progress
                                value={item.progress}
                                max="100"
                                aria-label={`处理进度 ${item.progress}%`}
                              />
                            )}
                          </td>
                          <td>
                            {item.outputs.length
                              ? `${item.outputs.length} 份`
                              : "—"}
                          </td>
                          <td>
                            <div className="actions">
                              <button
                                className="text-button"
                                onClick={() => setJob(item.id)}
                              >
                                查看 <ArrowRight size={14} />
                              </button>
                              {item.outputs.length > 0 && (
                                <a
                                  className="icon-button"
                                  href={`/api/jobs/${item.id}/download`}
                                  aria-label={`下载${item.title}全部产物`}
                                >
                                  <ArrowDownToLine size={16} />
                                </a>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>共 {jobs.data.total} 项</span>
                  <select
                    aria-label="每页数量"
                    value={size}
                    onChange={(e) => {
                      setSize(Number(e.target.value));
                      setPage(0);
                    }}
                  >
                    <option value={20}>20 条 / 页</option>
                    <option value={50}>50 条 / 页</option>
                    <option value={100}>100 条 / 页</option>
                  </select>
                  <button
                    className="icon-button"
                    disabled={page === 0}
                    aria-label="上一页"
                    onClick={() => setPage((v) => v - 1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span>{page + 1}</span>
                  <button
                    className="icon-button"
                    disabled={(page + 1) * size >= jobs.data.total}
                    aria-label="下一页"
                    onClick={() => setPage((v) => v + 1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </>
            ) : (
              <Empty
                icon={FileText}
                title="还没有符合条件的任务"
                detail="在创作工作室开始处理，真实任务会自动保存在这里。"
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div className="toolbar">
            <div className="tabs">
              <button
                className={!draftTrash ? "active" : ""}
                onClick={() => {
                  setDraftTrash(false);
                  setDraftError("");
                }}
              >
                <FileText size={15} />
                可继续编辑
              </button>
              <button
                className={draftTrash ? "active" : ""}
                onClick={() => {
                  setDraftTrash(true);
                  setDraftError("");
                }}
              >
                <Trash2 size={15} />
                回收站
              </button>
            </div>
            <span className="small muted">
              {visibleDrafts.length} 份草稿
              {draftTrash ? " · 恢复后可继续编辑" : ""}
            </span>
          </div>
          {currentDrafts.error && (
            <ErrorPanel
              error={currentDrafts.error}
              retry={currentDrafts.refresh}
            />
          )}
          {draftError && <ErrorPanel error={draftError} />}
          {currentDrafts.loading ? (
            <Loading />
          ) : (
            <>
              <div className="draft-grid">
                {visibleDrafts.map((draft) => (
                  <article className="panel draft-card" key={draft.id}>
                    <div className="row">
                      <span className="tool-icon">
                        <FileText size={20} />
                      </span>
                      <span className="tiny-badge">
                        {draftTrash ? "回收站" : "草稿"}
                      </span>
                    </div>
                    <h3>{draft.title}</h3>
                    <p>
                      {isWorkflowDraft(draft)
                        ? "多步骤工作流"
                        : (tools.find((t) => t.id === draft.toolId)?.title ??
                          draft.toolId)}
                    </p>
                    <small className="muted">{date(draft.updatedAt)}</small>
                    <div className="row">
                      {draftTrash ? (
                        <button
                          className="button secondary small-button"
                          disabled={!!draftBusy}
                          onClick={() => void changeDraft(draft, true)}
                        >
                          <RotateCcw size={15} />
                          {draftBusy === draft.id ? "正在恢复…" : "恢复草稿"}
                        </button>
                      ) : (
                        <>
                          <button
                            className="text-button"
                            onClick={() =>
                              navigate(
                                isWorkflowDraft(draft) ? "workflows" : "studio",
                                {
                                  tool: isWorkflowDraft(draft)
                                    ? undefined
                                    : draft.toolId,
                                  draft: draft.id,
                                },
                              )
                            }
                          >
                            继续编辑 <ArrowRight size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`将草稿${draft.title}移入回收站`}
                            disabled={!!draftBusy}
                            onClick={() => void changeDraft(draft, false)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!visibleDrafts.length && (
                <div className="panel">
                  <Empty
                    title={
                      search
                        ? "没有匹配的草稿"
                        : draftTrash
                          ? "回收站为空"
                          : "灵感可以先存起来"
                    }
                    detail={
                      search
                        ? "试试其他名称，或清空搜索。"
                        : draftTrash
                          ? "移除的草稿会保存在这里，你可以随时恢复。"
                          : "编辑任一工具并保存草稿，下次随时接着创作。"
                    }
                  />
                </div>
              )}
            </>
          )}
        </>
      )}
      <JobPanel
        id={job}
        onClose={() => {
          setJob(null);
          jobs.refresh();
        }}
      />
    </>
  );
}

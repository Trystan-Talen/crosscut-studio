import { useState, type FormEvent } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import type { Asset, Draft, Job, Project } from "../../shared/types";
import {
  api,
  date,
  message,
  navigate,
  patch,
  post,
  queryString,
  useQuery,
} from "../api";
import { useWorkspace } from "../context";
import {
  AssetPicker,
  Drawer,
  Empty,
  ErrorPanel,
  JobPanel,
  JobRow,
  Loading,
  MediaPreview,
  PageTitle,
} from "../ui";
export function Projects({ params }: { params: URLSearchParams }) {
  const { refresh, notify } = useWorkspace();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Project | "new" | null>(
    params.get("new") ? "new" : null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useQuery<{ items: Project[]; total: number }>(
    `/projects?${queryString({ search, archived: archived ? 1 : 0 })}`,
    { items: [], total: 0 },
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body = Object.fromEntries(form);
      if (editing && editing !== "new")
        await patch(`/projects/${editing.id}`, body);
      else await post("/projects", body);
      list.refresh();
      refresh();
      setEditing(null);
      notify("项目已保存");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function archive(item: Project) {
    try {
      await patch(`/projects/${item.id}`, { archived: !archived });
      list.refresh();
      refresh();
      notify(archived ? "项目已恢复" : "项目已归档，相关素材与任务仍保留");
    } catch (e) {
      notify(message(e));
    }
  }
  const focused = list.data.items.find((p) => p.id === params.get("id"));
  return (
    <>
      {focused ? (
        <ProjectDetail project={focused} />
      ) : (
        <>
          <PageTitle
            eyebrow="ORGANIZE YOUR NEXT CAMPAIGN"
            title="让创作，有条不紊。"
            description="按产品、品牌或市场管理项目，把素材、草稿和作品放在一起。"
            actions={
              <button
                className="button primary"
                onClick={() => setEditing("new")}
              >
                <Plus size={17} />
                新建项目
              </button>
            }
          />
          <div className="toolbar">
            <div className="tabs">
              <button
                className={!archived ? "active" : ""}
                onClick={() => setArchived(false)}
              >
                进行中的项目
              </button>
              <button
                className={archived ? "active" : ""}
                onClick={() => setArchived(true)}
              >
                已归档
              </button>
            </div>
            <label className="search">
              <Search size={17} />
              <input
                aria-label="搜索项目"
                placeholder="搜索项目"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          {list.error && <ErrorPanel error={list.error} retry={list.refresh} />}
          {list.loading ? (
            <Loading />
          ) : list.data.items.length ? (
            <div className="project-grid">
              {list.data.items.map((item, index) => (
                <article className="project-card" key={item.id}>
                  <button
                    className={`project-cover tone-${index % 4}`}
                    onClick={() => navigate("projects", { id: item.id })}
                  >
                    <Folder size={42} strokeWidth={1.1} />
                    <span>{item.brand || "YOUR NEXT CAMPAIGN"}</span>
                    <ArrowRight size={20} />
                  </button>
                  <div className="project-content">
                    <button
                      className="project-title"
                      onClick={() => navigate("projects", { id: item.id })}
                    >
                      {item.name}
                    </button>
                    <p>
                      {item.description ||
                        "还没有项目描述。为团队的下一次创作写下目标。"}
                    </p>
                    <div className="project-meta">
                      <span>{item.market || "全部市场"}</span>
                      <span>{date(item.updatedAt)}</span>
                    </div>
                    <div className="row">
                      <button
                        className="text-button"
                        onClick={() => setEditing(item)}
                      >
                        <Pencil size={14} />
                        编辑信息
                      </button>
                      <button
                        className="text-button"
                        onClick={() => void archive(item)}
                      >
                        {archived ? (
                          <RotateCcw size={14} />
                        ) : (
                          <Archive size={14} />
                        )}
                        {archived ? "恢复项目" : "归档"}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="panel">
              <Empty
                icon={FolderPlus}
                title={
                  archived ? "还没有归档项目" : "给下一个创意，一个专属空间"
                }
                detail="建立项目，集中管理素材、草稿与创作任务。"
              >
                <button
                  className="button primary"
                  onClick={() => setEditing("new")}
                >
                  <Plus size={16} />
                  新建项目
                </button>
              </Empty>
            </div>
          )}
        </>
      )}
      <Drawer
        open={!!editing}
        title={editing === "new" ? "创建新项目" : "编辑项目"}
        onClose={() => setEditing(null)}
      >
        {editing && (
          <form
            key={typeof editing === "string" ? "new" : editing.id}
            onSubmit={(e) => void save(e)}
          >
            <label className="field">
              <span>项目名称 *</span>
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={editing === "new" ? "" : editing.name}
                placeholder="例如：秋季护肤新品 · 北美"
                autoFocus
              />
            </label>
            <label className="field">
              <span>项目描述</span>
              <textarea
                name="description"
                maxLength={2000}
                defaultValue={editing === "new" ? "" : editing.description}
                placeholder="这次创作想达成什么目标？"
              />
            </label>
            <div className="form-two">
              <label className="field">
                <span>品牌</span>
                <input
                  name="brand"
                  maxLength={100}
                  defaultValue={editing === "new" ? "" : editing.brand}
                />
              </label>
              <label className="field">
                <span>目标市场</span>
                <input
                  name="market"
                  maxLength={100}
                  defaultValue={editing === "new" ? "" : editing.market}
                  placeholder="美国、欧洲、东南亚…"
                />
              </label>
            </div>
            {error && <ErrorPanel error={error} />}
            <button className="button primary" disabled={busy}>
              {busy ? "保存中…" : "保存项目"}
            </button>
          </form>
        )}
      </Drawer>
    </>
  );
}
function ProjectDetail({ project }: { project: Project }) {
  const { notify } = useWorkspace();
  const [job, setJob] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const jobs = useQuery<{ items: Job[] }>(
    `/jobs?projectId=${project.id}`,
    { items: [] },
    5000,
  );
  const assets = useQuery<{ items: Asset[] }>(
    `/assets?projectId=${project.id}`,
    { items: [] },
  );
  const drafts = useQuery<{ items: Draft[] }>("/drafts", { items: [] });
  return (
    <>
      <button className="back-link" onClick={() => navigate("projects")}>
        <ArrowLeft size={16} />
        所有项目
      </button>
      <PageTitle
        eyebrow={project.brand || "PROJECT"}
        title={project.name}
        description={
          project.description || "把这个项目的素材与创作汇集在这里。"
        }
        actions={
          <button
            className="button primary"
            onClick={() =>
              navigate("studio", { tool: "video-studio", project: project.id })
            }
          >
            <Plus size={17} />
            新建创作
          </button>
        }
      />
      <div className="project-detail-grid">
        <section className="panel">
          <div className="section-heading">
            <h2>项目素材</h2>
            <button className="text-button" onClick={() => setPick(true)}>
              <Plus size={16} />
              管理素材
            </button>
          </div>
          {assets.error && (
            <ErrorPanel error={assets.error} retry={assets.refresh} />
          )}
          {assets.data.items.length ? (
            <div className="asset-grid picker-grid">
              {assets.data.items.map((asset) => (
                <a
                  className="asset-tile"
                  key={asset.id}
                  href={`/api/assets/${asset.id}/file?download=1`}
                >
                  <MediaPreview asset={asset} compact />
                  <strong>{asset.name}</strong>
                </a>
              ))}
            </div>
          ) : (
            <Empty
              title="为项目添几份素材"
              detail="选择素材库中已有的图片、视频与音频。"
            />
          )}
        </section>
        <section className="panel">
          <h2>项目草稿</h2>
          {drafts.data.items
            .filter((d) => d.projectId === project.id)
            .map((draft) => (
              <button
                className="job-row"
                key={draft.id}
                onClick={() =>
                  navigate("studio", { tool: draft.toolId, draft: draft.id })
                }
              >
                <span className="job-main">
                  <strong>{draft.title}</strong>
                  <small>{date(draft.updatedAt)}</small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          {!drafts.data.items.some((d) => d.projectId === project.id) && (
            <Empty
              title="还没有项目草稿"
              detail="在创作工作室选择此项目并保存草稿。"
            />
          )}
        </section>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>项目任务</h2>
          <span className="small muted">{jobs.data.items.length} 项</span>
        </div>
        {jobs.error && <ErrorPanel error={jobs.error} retry={jobs.refresh} />}
        {jobs.data.items.length ? (
          jobs.data.items.map((item) => (
            <JobRow key={item.id} job={item} onClick={() => setJob(item.id)} />
          ))
        ) : (
          <Empty
            title="第一项创作，即将开始"
            detail="项目的任务、状态和产物会汇集在这里。"
          />
        )}
      </section>
      <AssetPicker
        open={pick}
        onClose={() => setPick(false)}
        selected={assets.data.items.map((a) => a.id)}
        onSelect={(ids) =>
          void patch(`/projects/${project.id}/assets`, { assetIds: ids })
            .then(() => {
              assets.refresh();
              notify("项目素材已更新");
            })
            .catch((e) => notify(message(e)))
        }
      />
      <JobPanel id={job} onClose={() => setJob(null)} />
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Clock3,
  Film,
  History,
  ListVideo,
  Play,
  RefreshCw,
  Save,
  ScanLine,
  Sparkles,
} from "lucide-react";
import "./analysis.css";
import { AnalysisDetails } from "./AnalysisDetails";
import type { Job } from "../../shared/types";
import { date, message, navigate, patch, post, useQuery } from "../api";
import { useWorkspace } from "../context";
import {
  AssetField,
  CopyButton,
  Drawer,
  Empty,
  ErrorPanel,
  JobPanel,
  Loading,
  Notice,
  PageTitle,
  Status,
  StructuredResult,
} from "../ui";
interface AnalysisRecord {
  id: string;
  assetId: string;
  createdAt: string;
  versions: { version: number; jobs: Job[]; prompt: string }[];
}
interface AnalysisSummary {
  id: string;
  assetId: string;
  createdAt: string;
  version: number;
  assetName: string;
  source: string;
  mode: "technical" | "semantic";
  status: Job["status"] | "partial";
  taskCount: number;
  completed: number;
}
export function Analysis({ params }: { params: URLSearchParams }) {
  const { assets, providers, notify, refresh } = useWorkspace();
  const [ids, setIds] = useState<string[]>(
    params.get("asset") ? [params.get("asset")!] : [],
  );
  const [mode, setMode] = useState<"technical" | "semantic">("technical");
  const [provider, setProvider] = useState("");
  const [analysisId, setAnalysisId] = useState<string | null>(params.get("id"));
  const [version, setVersion] = useState<number | null>(null);
  const [tab, setTab] = useState("timeline");
  const [history, setHistory] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState<{
    start: number;
    end: number;
    playing: boolean;
  } | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState("");
  const [historyMode, setHistoryMode] = useState("");
  const [historySource, setHistorySource] = useState("");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [historyOrder, setHistoryOrder] = useState("newest");
  const [historyPage, setHistoryPage] = useState(0);
  const routeAnalysisId = params.get("id");
  const routeAssetId = params.get("asset");
  useEffect(() => {
    setAnalysisId(routeAnalysisId);
    setVersion(null);
    setError("");
    if (!routeAnalysisId && routeAssetId) setIds([routeAssetId]);
  }, [routeAnalysisId, routeAssetId]);
  const historyQuery = new URLSearchParams({
    limit: "20",
    offset: String(historyPage * 20),
    order: historyOrder,
  });
  if (historySearch) historyQuery.set("search", historySearch);
  if (historyStatus) historyQuery.set("status", historyStatus);
  if (historyMode) historyQuery.set("mode", historyMode);
  if (historySource) historyQuery.set("source", historySource);
  if (historyFrom)
    historyQuery.set("from", new Date(`${historyFrom}T00:00:00`).toISOString());
  if (historyTo) {
    const end = new Date(`${historyTo}T00:00:00`);
    end.setDate(end.getDate() + 1);
    historyQuery.set("before", end.toISOString());
  }
  useEffect(
    () => setHistoryPage(0),
    [
      historySearch,
      historyStatus,
      historyMode,
      historySource,
      historyFrom,
      historyTo,
      historyOrder,
    ],
  );
  useEffect(() => {
    setPlayback(null);
  }, [analysisId, ids[0]]);
  useEffect(() => {
    if (!playback?.playing) return;
    let frame = 0;
    const check = () => {
      const player = video.current;
      if (player && player.currentTime >= playback.end) {
        player.pause();
        player.currentTime = playback.end;
        setPlayback((value) => (value ? { ...value, playing: false } : null));
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [playback]);
  const records = useQuery<{ items: AnalysisSummary[]; total: number }>(
    `/analyses?${historyQuery}`,
    { items: [], total: 0 },
  );
  const detail = useQuery<AnalysisRecord | null>(
    analysisId ? `/analyses/${analysisId}` : null,
    null,
    analysisId ? 3000 : 0,
  );
  const current =
    detail.data?.versions.find((v) => v.version === version) ??
    detail.data?.versions.reduce((latest, item) =>
      item.version > latest.version ? item : latest,
    );
  const asset = assets.find((a) => a.id === (detail.data?.assetId ?? ids[0]));
  const running = current?.jobs.some((j) =>
    ["queued", "running"].includes(j.status),
  );
  const compatible = providers.filter(
    (p) => p.configured && p.capabilities.includes("video.analysis"),
  );
  const chosen = compatible.find((p) => p.id === provider) ?? compatible[0];
  const sectionJob =
    current?.jobs.find((j) => j.toolId === `analysis-${tab}`) ??
    (tab === "timeline"
      ? current?.jobs.find((j) => j.toolId === "scene-detect")
      : undefined);
  useEffect(() => {
    if (detail.data?.assetId) setIds([detail.data.assetId]);
  }, [detail.data?.assetId]);
  useEffect(() => {
    setPrompt(
      current?.prompt ??
        textResult(
          current?.jobs.find((j) => j.toolId === "analysis-prompt")?.result,
        ),
    );
  }, [
    analysisId,
    current?.version,
    current?.prompt,
    current?.jobs.find((j) => j.toolId === "analysis-prompt")?.status,
  ]);
  async function start() {
    if (!ids[0]) {
      setError("请先选择一条视频。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await post<{ id: string; version: number }>("/analyses", {
        assetId: ids[0],
        mode,
        providerId: mode === "semantic" ? chosen?.id : undefined,
      });
      setAnalysisId(result.id);
      navigate("analysis", { id: result.id });
      setVersion(result.version);
      records.refresh();
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry(section?: string) {
    if (!analysisId) return;
    setBusy(true);
    try {
      await post(`/analyses/${analysisId}/retry`, {
        section,
        providerId: chosen?.id,
      });
      detail.refresh();
      records.refresh();
      setVersion(null);
      notify("已创建新的拆解版本");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function seek(seconds: number, end?: number) {
    const player = video.current;
    if (!player || !Number.isFinite(seconds)) return;
    try {
      player.currentTime = seconds;
      setPlayback(
        end && end > seconds ? { start: seconds, end, playing: true } : null,
      );
      void player.play().catch(() => {
        setPlayback(null);
        setError("浏览器未能播放此视频。请查看素材详情，必要时先转为 MP4。");
      });
    } catch {
      setPlayback(null);
      setError("视频尚未就绪，请稍后重试。");
    }
  }
  const timeline = findTimeline(sectionJob?.result);
  return (
    <>
      <PageTitle
        eyebrow="LOOK CLOSER, CREATE BETTER"
        title="拆开镜头，看见创意。"
        description="从技术分镜到叙事结构，让参考视频成为可操作的创作依据。"
        actions={
          <button className="button secondary" onClick={() => setHistory(true)}>
            <History size={17} />
            拆解记录
          </button>
        }
      />
      <div className="analysis-layout">
        <aside className="panel analysis-source">
          <div className="section-heading">
            <h2>参考视频</h2>
            {analysisId && (
              <button
                className="text-button"
                onClick={() => {
                  setAnalysisId(null);
                  setVersion(null);
                  navigate("analysis");
                }}
              >
                新建拆解
              </button>
            )}
          </div>
          {asset ? (
            <>
              <video
                ref={video}
                src={asset.url}
                controls
                playsInline
                preload="metadata"
                className="analysis-video"
              />
              <p className="video-caption">{asset.name}</p>
              {playback && (
                <p className="playback-range" role="status">
                  {playback.playing ? "正在播放" : "片段已结束"}{" "}
                  {time(playback.start)} – {time(playback.end)}
                </p>
              )}
            </>
          ) : (
            <div className="analysis-video-placeholder">
              <Film size={46} strokeWidth={1} />
              <p>先放入一条参考视频</p>
            </div>
          )}
          {!analysisId && (
            <>
              <AssetField
                label="拆解视频"
                value={ids}
                onChange={setIds}
                accepts={["video"]}
                max={1}
              />
              <fieldset className="mode-cards">
                <legend>选择拆解方式</legend>
                <label className={mode === "technical" ? "selected" : ""}>
                  <input
                    type="radio"
                    name="analysisMode"
                    checked={mode === "technical"}
                    onChange={() => setMode("technical")}
                  />
                  <ScanLine size={18} />
                  <span>
                    <b>技术分镜检测</b>
                    <small>本地检测镜头变化与媒体参数</small>
                  </span>
                  <span className="tiny-badge">本地</span>
                </label>
                <label className={mode === "semantic" ? "selected" : ""}>
                  <input
                    type="radio"
                    name="analysisMode"
                    checked={mode === "semantic"}
                    onChange={() => setMode("semantic")}
                  />
                  <Sparkles size={18} />
                  <span>
                    <b>AI 语义拆解</b>
                    <small>分镜、机制与反推提示词</small>
                  </span>
                </label>
              </fieldset>
              {mode === "semantic" && (
                <>
                  {compatible.length ? (
                    <label className="field">
                      <span>视觉分析服务</span>
                      <select
                        value={chosen?.id ?? ""}
                        onChange={(e) => setProvider(e.target.value)}
                      >
                        {compatible.map((p) => (
                          <option value={p.id} key={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <Notice>
                      语义拆解需要视觉分析服务。
                      <button
                        className="text-button"
                        onClick={() => navigate("settings")}
                      >
                        前往配置
                      </button>
                    </Notice>
                  )}
                  <p className="disclosure">
                    开始后，参考视频的必要帧与分析要求会发送至{" "}
                    {chosen?.name ?? "所选模型服务"}
                    。本地技术检测不含商业机制结论。
                  </p>
                </>
              )}
              {error && <ErrorPanel error={error} />}
              <button
                className="button primary full"
                disabled={
                  busy || !ids.length || (mode === "semantic" && !chosen)
                }
                onClick={() => void start()}
              >
                <ScanLine size={17} />
                {busy ? "正在创建…" : "开始拆解"}
              </button>
            </>
          )}
          {analysisId && (
            <>
              <label className="field">
                <span>分析版本</span>
                <select
                  value={current?.version ?? ""}
                  onChange={(e) => setVersion(Number(e.target.value))}
                >
                  {detail.data?.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      V{v.version}
                      {v.version ===
                      detail.data?.versions.reduce((latest, item) =>
                        item.version > latest.version ? item : latest,
                      )?.version
                        ? " · 最新版本"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button secondary full"
                disabled={busy || running}
                onClick={() => void retry()}
              >
                <RefreshCw size={16} />
                全部重新拆解
              </button>
              <button
                className="button primary full mt"
                onClick={() =>
                  navigate("replication", { asset: detail.data?.assetId })
                }
              >
                创作我的产品版本 <ArrowRight size={16} />
              </button>
              {error && <ErrorPanel error={error} />}
            </>
          )}
        </aside>
        <section className="panel analysis-results">
          {detail.error && (
            <ErrorPanel error={detail.error} retry={detail.refresh} />
          )}
          {analysisId ? (
            <>
              <div className="analysis-tabs">
                {[
                  { id: "timeline", title: "分镜时间轴", number: "01" },
                  { id: "mechanism", title: "创意机制", number: "02" },
                  { id: "prompt", title: "反推提示词", number: "03" },
                ].map((item) => {
                  const job = current?.jobs.find(
                    (j) =>
                      j.toolId === `analysis-${item.id}` ||
                      (item.id === "timeline" && j.toolId === "scene-detect"),
                  );
                  return (
                    <button
                      key={item.id}
                      className={tab === item.id ? "active" : ""}
                      onClick={() => setTab(item.id)}
                    >
                      <b>{item.number}</b>
                      <span>{item.title}</span>
                      {job && <Status status={job.status} />}
                    </button>
                  );
                })}
              </div>
              {detail.loading && !current ? (
                <Loading />
              ) : sectionJob ? (
                <>
                  <div className="section-heading">
                    <h2>
                      {tab === "timeline"
                        ? "分镜时间轴"
                        : tab === "mechanism"
                          ? "创意机制诊断"
                          : "可编辑提示词"}
                    </h2>
                    <div className="actions">
                      <button
                        className="text-button"
                        onClick={() => setJobId(sectionJob.id)}
                      >
                        任务详情
                      </button>
                      {sectionJob.toolId.startsWith("analysis-") && (
                        <button
                          className="icon-button"
                          aria-label="重新拆解此部分"
                          disabled={busy || running}
                          onClick={() => void retry(tab)}
                        >
                          <RefreshCw size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  {sectionJob.status !== "succeeded" ? (
                    <>
                      <Status status={sectionJob.status} />
                      {sectionJob.error && (
                        <Notice danger>{sectionJob.error}</Notice>
                      )}
                      {["queued", "running"].includes(sectionJob.status) && (
                        <div className="processing-state">
                          <ScanLine size={38} strokeWidth={1} />
                          <h3>正在分析真实视频内容</h3>
                          <p>你可以离开页面，任务与结果会保存在拆解记录中。</p>
                          <progress value={sectionJob.progress} max={100} />
                        </div>
                      )}
                    </>
                  ) : tab === "prompt" ? (
                    <>
                      <textarea
                        className="prompt-result"
                        aria-label="完整可编辑提示词"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={20}
                      />
                      <div className="actions wrap">
                        <button
                          className="button secondary"
                          onClick={() =>
                            void patch(`/analyses/${analysisId}/prompt`, {
                              version: current?.version,
                              prompt,
                            })
                              .then(() => {
                                detail.refresh();
                                notify("当前版本提示词已保存");
                              })
                              .catch((e) => setError(message(e)))
                          }
                        >
                          <Save size={16} />
                          保存修改
                        </button>
                        <CopyButton text={prompt} />
                        <button
                          className="button primary"
                          disabled={!prompt.trim()}
                          onClick={() =>
                            navigate("studio", { tool: "video-studio", prompt })
                          }
                        >
                          用这份提示词创作 <ArrowRight size={16} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      {sectionJob.toolId === "scene-detect" && (
                        <Notice>
                          本结果来自画面变化检测，仅描述镜头边界与媒体属性，不推断叙事含义或投放效果。
                        </Notice>
                      )}
                      {tab === "timeline" && timeline.length > 0 && (
                        <div className="timeline-list">
                          {timeline.map((scene, index) => (
                            <button
                              className="timeline-scene"
                              key={index}
                              onClick={() => seek(scene.start, scene.end)}
                            >
                              <span className="scene-number">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              <div>
                                <b>{scene.title || `镜头 ${index + 1}`}</b>
                                <small>
                                  <Clock3 size={12} />
                                  {time(scene.start)} – {time(scene.end)}
                                </small>
                                {scene.description && (
                                  <p>{scene.description}</p>
                                )}
                              </div>
                              <Play size={16} />
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="result-text">
                        <AnalysisDetails
                          value={sectionJob.result}
                          onSeek={seek}
                          fallback={
                            <StructuredResult value={sectionJob.result} />
                          }
                        />
                      </div>
                      {sectionJob.outputs.map((output) => (
                        <a
                          className="button secondary small-button"
                          key={output.id}
                          href={`/api/assets/${output.id}/file?download=1`}
                        >
                          下载 {output.name}
                        </a>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <Empty
                  title="当前版本未执行这一项分析"
                  detail="技术检测只产生镜头与媒体参数；语义机制和反推提示词需要配置视觉模型服务。"
                />
              )}
            </>
          ) : (
            <div className="analysis-welcome">
              <span className="eyebrow">THREE WAYS TO SEE MORE</span>
              <h2>
                不止看到画面，
                <br />
                更理解画面如何成立。
              </h2>
              {[
                {
                  number: "01",
                  title: "看清镜头结构",
                  text: "检测片段边界，沿着时间轴还原画面变化。",
                  icon: ListVideo,
                },
                {
                  number: "02",
                  title: "理解创意机制",
                  text: "使用视觉模型分析内容，记录判断所依据的镜头。",
                  icon: Sparkles,
                },
                {
                  number: "03",
                  title: "把观察变成行动",
                  text: "保存可编辑提示词，继续创作你自己的产品故事。",
                  icon: ArrowRight,
                },
              ].map((item) => (
                <div className="analysis-feature" key={item.number}>
                  <span>{item.number}</span>
                  <item.icon size={22} />
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <Drawer open={history} title="拆解记录" onClose={() => setHistory(false)}>
        <div className="analysis-history-filters">
          <label className="field">
            <span>搜索素材或拆解编号</span>
            <input
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </label>
          <label className="field">
            <span>拆解方式</span>
            <select
              value={historyMode}
              onChange={(e) => setHistoryMode(e.target.value)}
            >
              <option value="">全部方式</option>
              <option value="technical">本地技术分镜</option>
              <option value="semantic">AI语义拆解</option>
            </select>
          </label>
          <label className="field">
            <span>处理状态</span>
            <select
              value={historyStatus}
              onChange={(e) => setHistoryStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="queued">排队中</option>
              <option value="running">处理中</option>
              <option value="succeeded">已完成</option>
              <option value="partial">部分完成</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
              <option value="needs_review">待核对</option>
            </select>
          </label>
          <label className="field">
            <span>素材来源</span>
            <select
              value={historySource}
              onChange={(e) => setHistorySource(e.target.value)}
            >
              <option value="">全部来源</option>
              <option value="upload">上传素材</option>
              <option value="generated">创作产物</option>
              <option value="demo">原创示例</option>
            </select>
          </label>
          <label className="field">
            <span>开始日期</span>
            <input
              type="date"
              value={historyFrom}
              onChange={(e) => setHistoryFrom(e.target.value)}
            />
          </label>
          <label className="field">
            <span>结束日期</span>
            <input
              type="date"
              min={historyFrom || undefined}
              value={historyTo}
              onChange={(e) => setHistoryTo(e.target.value)}
            />
          </label>
          <label className="field">
            <span>时间排序</span>
            <select
              value={historyOrder}
              onChange={(e) => setHistoryOrder(e.target.value)}
            >
              <option value="newest">最新在前</option>
              <option value="oldest">最早在前</option>
            </select>
          </label>
        </div>
        {records.loading && <Loading />}
        {records.error && (
          <ErrorPanel error={records.error} retry={records.refresh} />
        )}
        {records.data.items.length ? (
          records.data.items.map((item) => (
            <button
              className="job-row"
              key={item.id}
              onClick={() => {
                setAnalysisId(item.id);
                navigate("analysis", { id: item.id });
                setVersion(null);
                setHistory(false);
              }}
            >
              <span className="job-symbol">
                <ScanLine size={20} />
              </span>
              <span className="job-main">
                <strong>{item.assetName}</strong>
                <small>
                  {date(item.createdAt)} · V{item.version} ·{" "}
                  {item.mode === "technical" ? "技术" : "语义"} ·{" "}
                  {item.completed}/{item.taskCount} 完成
                </small>
              </span>
              {item.status === "partial" ? (
                <span className="status">部分完成</span>
              ) : (
                <Status status={item.status} />
              )}
              <ArrowRight size={17} />
            </button>
          ))
        ) : (
          <Empty
            title="没有符合条件的拆解记录"
            detail="调整筛选，或开始第一次拆解。所有版本会保存在这里。"
          />
        )}
        <div className="actions analysis-history-pager">
          <span>
            共 {records.data.total} 条 · 第 {historyPage + 1} 页
          </span>
          <button
            className="button secondary"
            disabled={historyPage === 0}
            onClick={() => setHistoryPage((p) => p - 1)}
          >
            上一页
          </button>
          <button
            className="button secondary"
            disabled={(historyPage + 1) * 20 >= records.data.total}
            onClick={() => setHistoryPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </Drawer>
      <JobPanel id={jobId} onClose={() => setJobId(null)} />
    </>
  );
}
function textResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const data = result as Record<string, unknown>;
    for (const key of ["prompt", "text", "content"])
      if (typeof data[key] === "string") return data[key] as string;
  }
  return result ? JSON.stringify(result, null, 2) : "";
}
function findTimeline(
  result: unknown,
): { start: number; end: number; title: string; description: string }[] {
  if (!result || typeof result !== "object") return [];
  const object = result as Record<string, unknown>;
  const entries = Array.isArray(result)
    ? result
    : ["scenes", "segments", "shots", "timeline"]
        .map((key) => object[key])
        .find(Array.isArray);
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && typeof e === "object")
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        start: Number(item.start ?? item.startTime ?? 0),
        end: Number(item.end ?? item.endTime ?? 0),
        title: String(item.title ?? item.label ?? ""),
        description: String(item.description ?? item.visual ?? ""),
      };
    })
    .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end));
}
function time(seconds: number) {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

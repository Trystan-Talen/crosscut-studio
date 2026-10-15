import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Gamepad2,
  Link2,
  Plus,
  Save,
  ShoppingBag,
} from "lucide-react";
import type { Draft, Job, ToolInput } from "../../shared/types";
import { date, message, navigate, post, useQuery, useRoute } from "../api";
import { useWorkspace } from "../context";
import { useWorkflowDraft } from "../components/useWorkflowDraft";
import {
  isWorkflowDraft,
  newWorkflow,
  restoreWorkflow,
  workflowInput,
  workflowName,
  type WorkflowForm,
  type WorkflowKind,
  type WorkflowStage,
  type WorkflowState,
} from "../workflow-state";
import {
  AssetField,
  Empty,
  ErrorPanel,
  JobPanel,
  JobRow,
  Loading,
  Notice,
  PageTitle,
  StructuredResult,
} from "../ui";
import { ToolEditor } from "./Studio";

export function Workflows() {
  const { user } = useWorkspace();
  const { params } = useRoute();
  const selectedId = params.get("draft");
  const drafts = useQuery<{ items: Draft[] }>("/drafts", { items: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!selectedId) drafts.refresh();
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, 0));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);
  const workflows = drafts.data.items
    .filter(isWorkflowDraft)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  function saved(draft: Draft) {
    drafts.setData((previous) => ({
      items: [draft, ...previous.items.filter((item) => item.id !== draft.id)],
    }));
  }
  async function create(flow: WorkflowKind) {
    setBusy(true);
    setError("");
    try {
      const state = newWorkflow(flow, user.id);
      const draft = await post<Draft>("/drafts", {
        title: state.title,
        toolId: `workflow-${flow}`,
        input: workflowInput(state),
      });
      saved(draft);
      navigate("workflows", { draft: draft.id });
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  if (selectedId) {
    const draft = workflows.find((item) => item.id === selectedId);
    let restored: WorkflowState | null = null;
    let failure = "";
    if (draft) {
      try {
        restored = restoreWorkflow(draft, user.id);
      } catch (e) {
        failure = message(e);
      }
    }
    if (draft && restored)
      return (
        <WorkflowEditor
          key={`${user.id}:${draft.id}`}
          draft={draft}
          initial={restored}
          onSaved={saved}
        />
      );
    return (
      <>
        <button className="back-link" onClick={() => navigate("workflows")}>
          <ArrowLeft size={16} />
          全部工作流
        </button>
        {drafts.loading ? (
          <Loading />
        ) : (
          <ErrorPanel
            error={
              drafts.error ||
              failure ||
              "当前账号找不到这份工作流。若已移入回收站，请先在我的草稿中恢复。"
            }
            retry={drafts.refresh}
          />
        )}
      </>
    );
  }
  const latest = workflows[0];
  return (
    <>
      <PageTitle
        eyebrow="A CLEAR PATH FROM IDEA TO OUTPUT"
        title="让创作，顺着流程发生。"
        description="每一步都有真实输入与产物，保存进度，下次接着完成。"
      />
      {error && <ErrorPanel error={error} />}
      {drafts.error && (
        <ErrorPanel error={drafts.error} retry={drafts.refresh} />
      )}
      {latest && (
        <section className="panel workflow-resume">
          <div>
            <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
            <h2>{latest.title}</h2>
            <p className="muted">
              当前账号的流程 · {date(latest.updatedAt)} 保存
            </p>
          </div>
          <button
            className="button primary"
            onClick={() => navigate("workflows", { draft: latest.id })}
          >
            继续上次流程 <ArrowRight size={16} />
          </button>
        </section>
      )}
      {workflows.length > 1 && (
        <details className="details workflow-history">
          <summary>其他已保存的流程（{workflows.length - 1}）</summary>
          {workflows.slice(1).map((draft) => (
            <div className="row" key={draft.id}>
              <div>
                <strong>{draft.title}</strong>
                <small className="muted"> · {date(draft.updatedAt)}</small>
              </div>
              <button
                className="text-button"
                onClick={() => navigate("workflows", { draft: draft.id })}
              >
                继续流程 <ArrowRight size={15} />
              </button>
            </div>
          ))}
        </details>
      )}
      <div className="workflow-grid">
        <button
          className="workflow-card game"
          disabled={busy || drafts.loading}
          onClick={() => void create("game")}
        >
          <div className="workflow-visual">
            <Gamepad2 size={74} strokeWidth={1} />
            <span className="workflow-orbit" />
          </div>
          <span className="eyebrow">CONCEPT TO MOTION</span>
          <h2>游戏概念视频</h2>
          <p>先确定场景画面，再让它拥有动作与镜头。</p>
          <div className="workflow-mini-steps">
            <span>创意图像</span>
            <ArrowRight size={14} />
            <span>图生视频</span>
          </div>
          <strong>
            {busy ? "正在建立流程…" : "新建游戏流程"}
            <Plus size={17} />
          </strong>
        </button>
        <button
          className="workflow-card commerce"
          disabled={busy || drafts.loading}
          onClick={() => void create("commerce")}
        >
          <div className="workflow-visual">
            <ShoppingBag size={74} strokeWidth={1} />
            <span className="workflow-orbit" />
          </div>
          <span className="eyebrow">PRODUCT TO STORY</span>
          <h2>产品推广创作</h2>
          <p>读取公开产品信息，整理卖点，生成脚本并衔接视频。</p>
          <div className="workflow-mini-steps">
            <span>产品资料</span>
            <ArrowRight size={14} />
            <span>广告脚本</span>
            <ArrowRight size={14} />
            <span>视频</span>
          </div>
          <strong>
            {busy ? "正在建立流程…" : "新建产品流程"}
            <Plus size={17} />
          </strong>
        </button>
      </div>
      <Notice>
        流程保存到当前账号的本地服务器草稿，包含步骤、表单和真实任务关联。每一步由你确认后提交；缺少模型服务时可先保存再继续。
      </Notice>
    </>
  );
}

function WorkflowEditor({
  draft,
  initial,
  onSaved,
}: {
  draft: Draft;
  initial: WorkflowState;
  onSaved: (draft: Draft) => void;
}) {
  const { tools } = useWorkspace();
  const {
    state,
    update,
    save,
    status,
    error: saveError,
    savedAt,
  } = useWorkflowDraft(draft, initial, onSaved);
  const { flow, step, images, url, product, firstJob, scriptJob, videoJob } =
    state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showJob, setShowJob] = useState<string | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, 0));
    return () => window.cancelAnimationFrame(frame);
  }, [step]);
  const imageResult = useQuery<Job | null>(
    firstJob ? `/jobs/${firstJob}` : null,
    null,
    firstJob ? 2500 : 0,
  );
  const scriptResult = useQuery<Job | null>(
    scriptJob ? `/jobs/${scriptJob}` : null,
    null,
    scriptJob ? 2500 : 0,
  );
  const videoResult = useQuery<Job | null>(
    videoJob ? `/jobs/${videoJob}` : null,
    null,
    videoJob ? 2500 : 0,
  );
  const actualImage =
    imageResult.data?.id === firstJob ? imageResult.data : null;
  const actualScript =
    scriptResult.data?.id === scriptJob ? scriptResult.data : null;
  const actualVideo =
    videoResult.data?.id === videoJob ? videoResult.data : null;
  useEffect(() => {
    for (const [stage, job] of [
      ["image", actualImage],
      ["script", actualScript],
      ["video", actualVideo],
    ] as const) {
      if (!job || job.status !== "succeeded") continue;
      const outputIds = job.outputs.map((asset) => asset.id);
      update((previous) => ({
        ...previous,
        outputs: { ...previous.outputs, [stage]: outputIds },
        ...(stage === "image" &&
        previous.imageSource === "pending-generated" &&
        previous.firstJob === job.id
          ? {
              images: job.outputs
                .filter((asset) => asset.kind === "image")
                .slice(0, 2)
                .map((asset) => asset.id),
              imageSource: "generated" as const,
            }
          : {}),
      }));
    }
  }, [actualImage, actualScript, actualVideo, update]);
  function form(stage: WorkflowStage, snapshot: WorkflowForm) {
    update((previous) => ({
      ...previous,
      forms: { ...previous.forms, [stage]: snapshot },
      ...(stage === "video" &&
      previous.flow === "game" &&
      Array.isArray(snapshot.input.sourceIds) &&
      JSON.stringify(snapshot.input.sourceIds) !==
        JSON.stringify(previous.images)
        ? { images: snapshot.input.sourceIds, imageSource: "manual" as const }
        : {}),
    }));
  }
  function submitted(stage: WorkflowStage, jobs: Job[]) {
    const job = jobs[0];
    if (!job) return;
    update((previous) => ({
      ...previous,
      [stage === "image"
        ? "firstJob"
        : stage === "script"
          ? "scriptJob"
          : "videoJob"]: job.id,
      outputs: {
        ...previous.outputs,
        [stage]: job.outputs.map((asset) => asset.id),
      },
      jobIds: { ...previous.jobIds, [stage]: jobs.map((item) => item.id) },
      ...(stage === "image" && previous.imageSource !== "manual"
        ? { images: [], imageSource: "pending-generated" as const }
        : {}),
    }));
    void save();
  }
  async function leave() {
    if (await save()) navigate("workflows");
  }
  async function next(nextStep: number) {
    update((previous) => ({ ...previous, step: nextStep }));
    await save();
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const info = await post<{
        title: string;
        description: string;
        price: string;
      }>("/product/inspect", { url });
      update((previous) => ({
        ...previous,
        product: {
          ...previous.product,
          productName: info.title,
          sellingPoints: info.description,
          price: info.price,
        },
      }));
    } catch (failure) {
      setError(`${message(failure)} 你可以继续手动填写产品资料。`);
    } finally {
      setBusy(false);
    }
  }
  function productField(key: string, value: ToolInput[string]) {
    update((previous) => ({
      ...previous,
      product: { ...previous.product, [key]: value },
    }));
  }
  const imageTool = tools.find((tool) => tool.id === "image-generate");
  const videoTool = tools.find((tool) => tool.id === "image-video");
  const scriptTool = tools.find((tool) => tool.id === "ad-script");
  const linkTool = tools.find((tool) => tool.id === "link-video");
  const steps =
    flow === "game"
      ? ["创意图像", "生成视频"]
      : ["产品资料", "广告脚本", "生成视频"];
  const canVisit = (number: number) =>
    number === 1 ||
    (flow === "game"
      ? images.length > 0
      : number === 2
        ? !!product.productName && !!product.sellingPoints
        : actualScript?.status === "succeeded" || !!state.forms.video);
  const records = [actualImage, actualScript, actualVideo].filter(
    (job): job is Job => !!job,
  );
  return (
    <>
      <button className="back-link" onClick={() => void leave()}>
        <ArrowLeft size={16} />
        全部工作流
      </button>
      <PageTitle
        eyebrow="ONE STEP AT A TIME"
        title={
          flow === "game"
            ? "从概念画面，到动态世界。"
            : "从产品亮点，到广告故事。"
        }
      />
      <section className="panel workflow-savebar">
        <label className="field">
          <span>流程名称</span>
          <input
            value={state.title}
            maxLength={250}
            onChange={(event) =>
              update((previous) => ({
                ...previous,
                title: event.target.value || workflowName(flow),
              }))
            }
          />
        </label>
        <div className="workflow-save-actions">
          <span className="small muted" role="status">
            {status === "saved"
              ? `已保存 · ${date(savedAt)}`
              : status === "error"
                ? "保存未完成"
                : "正在保存工作流…"}
          </span>
          <button
            className="button secondary small-button"
            disabled={status === "saving"}
            onClick={() => void save()}
          >
            <Save size={15} />
            保存工作流
          </button>
          <button className="text-button" onClick={() => void leave()}>
            <Plus size={15} />
            新建流程
          </button>
        </div>
      </section>
      {saveError && <ErrorPanel error={saveError} retry={() => void save()} />}
      <div className="workflow-stepper">
        {steps.map((label, index) => (
          <button
            key={label}
            className={
              step === index + 1
                ? "active"
                : step > index + 1
                  ? "completed"
                  : ""
            }
            disabled={!canVisit(index + 1)}
            onClick={() => void next(index + 1)}
          >
            <b>{step > index + 1 ? <Check size={16} /> : `0${index + 1}`}</b>
            {label}
          </button>
        ))}
      </div>
      {(imageResult.error || scriptResult.error || videoResult.error) && (
        <ErrorPanel
          error={imageResult.error || scriptResult.error || videoResult.error}
          retry={() => {
            imageResult.refresh();
            scriptResult.refresh();
            videoResult.refresh();
          }}
        />
      )}
      {flow === "game" ? (
        step === 1 ? (
          <>
            {imageTool && (
              <ToolEditor
                key={`${draft.id}:image`}
                tool={imageTool}
                compact
                initialSnapshot={state.forms.image}
                onSnapshotChange={(snapshot) => form("image", snapshot)}
                onSaveDraft={save}
                onSubmitted={(jobs) => submitted("image", jobs)}
              />
            )}
            <div className="panel workflow-next">
              <h2>选择用于下一步的画面</h2>
              <p>
                可以等待本流程的图像任务完成，也可以手动选择已有图片。手选图片不会被后来完成的任务覆盖。
              </p>
              <p className="small muted">
                {state.imageSource === "manual"
                  ? "来源：手动从素材库选择，并非本流程自动生成。"
                  : state.imageSource === "generated"
                    ? "来源：本流程首个图像任务的真实产物。"
                    : state.imageSource === "pending-generated"
                      ? "正在等待本流程的真实图像产物。"
                      : "尚未选择下一步画面。"}
              </p>
              <AssetField
                label="下一步参考图片"
                value={images}
                onChange={(ids) =>
                  update((previous) => ({
                    ...previous,
                    images: ids,
                    imageSource: "manual",
                  }))
                }
                accepts={["image"]}
                max={2}
              />
              {actualImage?.status === "succeeded" &&
                actualImage.outputs.some((asset) => asset.kind === "image") && (
                  <button
                    className="text-button"
                    onClick={() =>
                      update((previous) => ({
                        ...previous,
                        images: actualImage.outputs
                          .filter((asset) => asset.kind === "image")
                          .slice(0, 2)
                          .map((asset) => asset.id),
                        imageSource: "generated",
                      }))
                    }
                  >
                    改用本流程生成的图片
                  </button>
                )}
              <button
                className="button primary"
                disabled={!images.length}
                onClick={() => {
                  update((previous) => ({
                    ...previous,
                    forms: {
                      ...previous.forms,
                      video: previous.forms.video
                        ? {
                            ...previous.forms.video,
                            input: {
                              ...previous.forms.video.input,
                              sourceIds: images,
                            },
                          }
                        : undefined,
                    },
                  }));
                  void next(2);
                }}
              >
                继续到图生视频 <ArrowRight size={16} />
              </button>
            </div>
          </>
        ) : (
          <>
            <Notice>
              {state.imageSource === "manual"
                ? "本步参考来自手动选择的素材。"
                : "本步参考来自本流程的图像任务。"}
              可以在下面调整；点击生成后才会提交视频任务。
            </Notice>
            {videoTool && (
              <ToolEditor
                key={`${draft.id}:video`}
                tool={videoTool}
                compact
                initialInput={{ sourceIds: images }}
                initialSnapshot={state.forms.video}
                onSnapshotChange={(snapshot) => form("video", snapshot)}
                onSaveDraft={save}
                onSubmitted={(jobs) => submitted("video", jobs)}
              />
            )}
          </>
        )
      ) : step === 1 ? (
        <section className="panel product-flow">
          <h2>先了解这次的主角</h2>
          <p className="muted">
            解析公开产品页面，或直接填写产品资料。不会执行网页脚本或自动下载图片。
          </p>
          <form
            className="product-url"
            onSubmit={(event) => void inspect(event)}
          >
            <label className="search">
              <Link2 size={17} />
              <input
                required
                type="url"
                maxLength={4000}
                aria-label="产品页面链接"
                placeholder="粘贴公开产品页面链接"
                value={url}
                onChange={(event) =>
                  update((previous) => ({
                    ...previous,
                    url: event.target.value,
                  }))
                }
              />
            </label>
            <button className="button secondary" disabled={busy}>
              {busy ? "正在读取…" : "读取产品资料"}
            </button>
          </form>
          {error && <ErrorPanel error={error} />}
          <label className="field">
            <span>产品名称 *</span>
            <input
              value={String(product.productName ?? "")}
              maxLength={500}
              onChange={(event) =>
                productField("productName", event.target.value)
              }
            />
          </label>
          <label className="field">
            <span>核心卖点 *</span>
            <textarea
              rows={6}
              maxLength={2000}
              value={String(product.sellingPoints ?? "")}
              onChange={(event) =>
                productField("sellingPoints", event.target.value)
              }
            />
          </label>
          <div className="form-two">
            <label className="field">
              <span>价格</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={String(product.price ?? "")}
                onChange={(event) => productField("price", event.target.value)}
              />
            </label>
            <label className="field">
              <span>目标人群</span>
              <input
                maxLength={300}
                value={String(product.audience ?? "")}
                onChange={(event) =>
                  productField("audience", event.target.value)
                }
              />
            </label>
          </div>
          <button
            className="button primary"
            disabled={!product.productName || !product.sellingPoints}
            onClick={() => void next(2)}
          >
            继续到广告脚本 <ArrowRight size={16} />
          </button>
          {state.forms.script && (
            <p className="small muted">
              后续脚本表单已单独保存。修改产品资料后，请在下一步核对并调整脚本输入。
            </p>
          )}
        </section>
      ) : step === 2 ? (
        <>
          {scriptTool && (
            <ToolEditor
              key={`${draft.id}:script`}
              tool={scriptTool}
              compact
              initialInput={product}
              initialSnapshot={state.forms.script}
              onSnapshotChange={(snapshot) => form("script", snapshot)}
              onSaveDraft={save}
              onSubmitted={(jobs) => submitted("script", jobs)}
            />
          )}
          <div className="panel workflow-next">
            <h2>核对脚本，准备下一步</h2>
            {actualScript?.status === "succeeded" ? (
              <StructuredResult value={actualScript.result} />
            ) : (
              <p className="muted">
                先通过真实文本服务生成脚本，成功后可以继续。已提交的任务会在刷新后重新读取真实状态。
              </p>
            )}
            <button
              className="button primary"
              disabled={actualScript?.status !== "succeeded"}
              onClick={() => void next(3)}
            >
              继续到产品视频 <ArrowRight size={16} />
            </button>
          </div>
        </>
      ) : (
        <>
          <Notice>
            产品视频需要兼容的链接生视频工作流服务。请核对来自上步的脚本、卖点和链接后再提交；修改上步资料不会覆盖这里已编辑的内容。
          </Notice>
          {String(product.sellingPoints ?? "").length > 500 &&
            !state.forms.video && (
              <Notice>
                上步卖点超过本工具的 500 字限制，已完整带入，请精简后生成。
              </Notice>
            )}
          {scriptText(actualScript?.result).length > 10000 &&
            !state.forms.video && (
              <Notice>
                上步脚本超过本工具的 10000 字限制，已完整带入，请精简后生成。
              </Notice>
            )}
          {scriptJob &&
          scriptResult.loading &&
          !actualScript &&
          !state.forms.video ? (
            <Loading />
          ) : linkTool ? (
            <ToolEditor
              key={`${draft.id}:video`}
              tool={linkTool}
              compact
              initialInput={{
                url,
                sellingPoints: String(product.sellingPoints ?? ""),
                script: scriptText(actualScript?.result),
              }}
              initialSnapshot={state.forms.video}
              onSnapshotChange={(snapshot) => form("video", snapshot)}
              onSaveDraft={save}
              onSubmitted={(jobs) => submitted("video", jobs)}
            />
          ) : (
            <Empty title="产品视频工具尚未可用" />
          )}
        </>
      )}
      {records.length > 0 && (
        <section className="panel workflow-records">
          <h2>本流程关联的真实任务</h2>
          <p className="muted small">
            任务与产物引用随流程保存。打开任务可查看实时状态、结果与下载入口。
          </p>
          {records.map((job) => (
            <JobRow key={job.id} job={job} onClick={() => setShowJob(job.id)} />
          ))}
          <div className="actions wrap">
            {(["image", "script", "video"] as const).flatMap((stage) =>
              state.jobIds[stage].slice(1).map((id, index) => (
                <button
                  key={id}
                  className="text-button"
                  onClick={() => setShowJob(id)}
                >
                  查看同批次
                  {stage === "image"
                    ? "图像"
                    : stage === "script"
                      ? "脚本"
                      : "视频"}
                  任务 {index + 2}
                  <ArrowRight size={14} />
                </button>
              )),
            )}
          </div>
        </section>
      )}
      <JobPanel id={showJob} onClose={() => setShowJob(null)} />
    </>
  );
}

function scriptText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    for (const key of ["text", "script", "content"])
      if (typeof value[key] === "string") return value[key] as string;
    return JSON.stringify(value, null, 2);
  }
  return "";
}

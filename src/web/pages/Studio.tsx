import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clapperboard,
  FileText,
  Grid2X2,
  List,
  LoaderCircle,
  Save,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import type { Draft, Field, Job, Tool, ToolInput } from "../../shared/types";
import { requiredCapability, validateInput } from "../../shared/catalog";
import { api, message, navigate, post, useQuery } from "../api";
import { useWorkspace } from "../context";
import { SubtitlePreview } from "../components/SubtitlePreview";
import {
  ToolField as FieldControl,
  providerOptions,
  readableLimit,
} from "../components/ToolField";
import type { WorkflowForm } from "../workflow-state";
import {
  getProviderLimits,
  validateProviderLimits,
  type ProviderFieldLimit,
} from "../../shared/provider-limits";
import {
  AssetField,
  Availability,
  CopyButton,
  Empty,
  ErrorPanel,
  JobPanel,
  JobRow,
  Loading,
  MediaPreview,
  Notice,
  PageTitle,
  ToolIcon,
  statuses,
} from "../ui";

export function Studio({
  params,
  replication = false,
}: {
  params: URLSearchParams;
  replication?: boolean;
}) {
  const { tools } = useWorkspace();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const id = replication ? "replication" : params.get("tool");
  const selected = tools.find((tool) => tool.id === id);
  const categories = [
    "全部",
    ...new Set(
      tools
        .filter((tool) => tool.category !== "内部")
        .map((tool) => tool.category),
    ),
  ];
  if (id && !selected)
    return tools.length ? (
      <>
        <PageTitle
          title="工具暂不可用"
          description="当前服务尚未提供此工具。"
        />
        <button className="button secondary" onClick={() => navigate("studio")}>
          返回工具目录
        </button>
      </>
    ) : (
      <Loading />
    );
  if (selected)
    return (
      <ToolEditor
        key={`${selected.id}:${params.toString()}`}
        tool={selected}
        params={params}
      />
    );
  const matches = tools.filter(
    (tool) =>
      tool.category !== "内部" &&
      (category === "全部" || tool.category === category) &&
      `${tool.title}${tool.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        eyebrow="CREATE SOMETHING NEW"
        title="找到适合你的创作方式。"
        description="从一句想法到一段视频，让专业工具接住每一步灵感。"
      />
      <div className="studio-banner">
        <div>
          <span className="eyebrow">VIDEO STUDIO</span>
          <h2>一处工作室，多种表达。</h2>
          <p>文本、图片、首尾帧与多模态参考。把创意装进下一条视频。</p>
          <button
            className="button primary"
            onClick={() => navigate("studio", { tool: "video-studio" })}
          >
            进入视频工作室 <ArrowRight size={16} />
          </button>
        </div>
        <Clapperboard size={106} strokeWidth={0.7} />
      </div>
      <div className="toolbar">
        <div className="tabs scroll-tabs">
          {categories.map((item) => (
            <button
              className={category === item ? "active" : ""}
              onClick={() => setCategory(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={17} />
          <input
            aria-label="搜索工具"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索工具"
          />
        </label>
      </div>
      <div className="tool-grid">
        {matches.map((tool) => (
          <button
            className="tool-card"
            key={tool.id}
            onClick={() => navigate("studio", { tool: tool.id })}
          >
            <div className="row">
              <span className={`tool-icon category-${tool.output}`}>
                <ToolIcon name={tool.icon} />
              </span>
              <Availability tool={tool} />
            </div>
            <h3>{tool.title}</h3>
            <p>{tool.description}</p>
            <div className="tool-card-foot">
              <span>{tool.category}</span>
              <ArrowRight size={17} />
            </div>
          </button>
        ))}
      </div>
      {!matches.length && (
        <Empty title="没有找到相关工具" detail="换一个关键词或分类试试。" />
      )}
    </>
  );
}

function defaults(tool: Tool): ToolInput {
  return Object.fromEntries(
    tool.fields
      .filter((field) => field.default !== undefined)
      .map((field) => [field.key, field.default!]),
  );
}
export interface CreationPayload {
  toolId: string;
  title: string;
  projectId?: string;
  input: ToolInput;
  providerId?: string;
  idempotencyKey: string;
}
export function ToolEditor({
  tool,
  params,
  initialInput,
  compact = false,
  onSubmitted,
  initialSnapshot,
  onSnapshotChange,
  onSaveDraft,
  onSubmit,
  externalBusy = false,
}: {
  tool: Tool;
  params?: URLSearchParams;
  initialInput?: ToolInput;
  compact?: boolean;
  onSubmitted?: (jobs: Job[]) => void;
  initialSnapshot?: WorkflowForm;
  onSnapshotChange?: (snapshot: WorkflowForm) => void;
  onSaveDraft?: () => Promise<boolean>;
  onSubmit?: (payload: CreationPayload) => Promise<{ items: Job[] }>;
  externalBusy?: boolean;
}) {
  const { providers, projects, assets, refresh, notify, tools } =
    useWorkspace();
  const [input, setInput] = useState<ToolInput>(() => ({
    ...defaults(tool),
    ...cleanInput(tool, initialSnapshot?.input ?? initialInput ?? {}),
  }));
  const [project, setProject] = useState(
    initialSnapshot?.projectId ?? params?.get("project") ?? "",
  );
  const [provider, setProvider] = useState(initialSnapshot?.providerId ?? "");
  const [title, setTitle] = useState(initialSnapshot?.title ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState(params?.get("draft") ?? "");
  const [showJob, setShowJob] = useState<string | null>(null);
  const [layout, setLayout] = useState("list");
  const [optimization, setOptimization] = useState<string | null>(null);
  const [ocrIds, setOcrIds] = useState<string[]>([]);
  const idempotency = useRef<string | null>(null);
  const snapshotCallback = useRef(onSnapshotChange);
  snapshotCallback.current = onSnapshotChange;
  const [catalogNotice, setCatalogNotice] = useState("");
  const jobs = useQuery<{ items: Job[]; total: number }>(
    `/jobs?toolId=${tool.id}&limit=12`,
    { items: [], total: 0 },
    5000,
  );
  const optimized = useQuery<Job | null>(
    optimization ? `/jobs/${optimization}` : null,
    null,
    optimization ? 2000 : 0,
  );
  const capability = requiredCapability(tool.id, input);
  const compatible = providers.filter(
    (p) => p.configured && p.capabilities.includes(capability),
  );
  const chosenProvider = provider
    ? compatible.find((p) => p.id === provider)
    : compatible[0];
  const local = capability === "local";
  const executable = local || !!chosenProvider;
  const limits = chosenProvider
    ? getProviderLimits(chosenProvider, tool.id, input)
    : { fields: {}, warnings: [] };
  const limitFor = (field: Field): ProviderFieldLimit | undefined =>
    tool.id === "replication" &&
    field.key === "duration" &&
    input.durationMode === "follow"
      ? {
          ...limits.fields[field.key],
          disabled: true,
          reason: "使用参考真实时长（4–60秒）；超出范围请先裁切参考视频。",
        }
      : limits.fields[field.key];
  const selectedIds = tool.fields
    .filter((field) => field.type === "assets")
    .flatMap((field) =>
      Array.isArray(input[field.key]) ? (input[field.key] as string[]) : [],
    );
  let providerProblem = "";
  if (
    chosenProvider &&
    !(chosenProvider.kind === "openai" && capability === "transcription") &&
    selectedIds.every((id) => assets.some((asset) => asset.id === id))
  ) {
    try {
      validateProviderLimits(
        chosenProvider,
        tool.id,
        input,
        assets.filter((asset) => selectedIds.includes(asset.id)),
      );
    } catch (failure) {
      providerProblem = message(failure);
    }
  }
  if (
    chosenProvider?.kind === "openai" &&
    capability === "transcription" &&
    limits.fields.targetLanguage?.disabled &&
    input.targetLanguage &&
    input.targetLanguage !== "original" &&
    input.targetLanguage !== input.language
  )
    providerProblem =
      "跨语言字幕需要在同一服务中配置文本模型；可以改为保留原语。";
  useEffect(() => {
    if (!provider && chosenProvider) setProvider(chosenProvider.id);
  }, [provider, chosenProvider?.id]);
  useEffect(() => {
    snapshotCallback.current?.({
      input,
      projectId: project,
      providerId: chosenProvider?.id ?? provider,
      title,
    });
  }, [input, project, provider, chosenProvider?.id, title]);
  useEffect(() => {
    if (!chosenProvider) return;
    const invalid = ["voice", "avatar"].filter((key) => {
      if (!tool.fields.some((field) => field.key === key) || !input[key])
        return false;
      const choices = providerOptions(chosenProvider, key);
      return !choices.some((choice) => choice.value === input[key]);
    });
    if (invalid.length) {
      setInput((value) => ({
        ...value,
        ...Object.fromEntries(invalid.map((key) => [key, ""])),
      }));
      setCatalogNotice(
        "当前模型服务的角色或音色目录不同，请重新选择；未登记的 ID 需先在设置中录入。",
      );
      idempotency.current = null;
    }
  }, [chosenProvider, tool.id, input.voice, input.avatar]);
  useEffect(() => {
    let current = true;
    async function restore() {
      try {
        if (params?.get("draft")) {
          const data = await api<{ items: Draft[] }>("/drafts");
          const item = data.items.find((d) => d.id === params.get("draft"));
          if (item && current) {
            setInput({ ...defaults(tool), ...cleanInput(tool, item.input) });
            setTitle(item.title);
            setProject(item.projectId ?? "");
          }
        } else if (params?.get("job")) {
          const item = await api<Job>(`/jobs/${params.get("job")}`);
          if (current) {
            setInput({ ...defaults(tool), ...cleanInput(tool, item.input) });
            setTitle(`${item.title} · 新版本`);
            setProject(item.projectId ?? "");
          }
        } else if (current && params) {
          const draftInput: ToolInput = {};
          if (params.get("prompt")) draftInput.prompt = params.get("prompt")!;
          if (params.get("asset")) {
            const field =
              tool.fields.find(
                (f) => f.type === "assets" && f.accepts?.includes("video"),
              ) ?? tool.fields.find((f) => f.type === "assets");
            if (field) draftInput[field.key] = [params.get("asset")!];
          }
          if (params.get("image"))
            draftInput.sourceIds = [params.get("image")!];
          setInput((v) => ({ ...v, ...draftInput }));
        }
      } catch (e) {
        if (current) setError(message(e));
      }
    }
    void restore();
    return () => {
      current = false;
    };
  }, [tool.id]);
  useEffect(() => {
    const result = optimized.data;
    if (!result || !optimization) return;
    if (result.status === "succeeded") {
      const text = extractText(result.result);
      if (text) {
        setInput((v) => ({
          ...v,
          [tool.fields.some((f) => f.key === "prompt") ? "prompt" : "text"]:
            text,
        }));
        notify("已将优化结果填入创作描述");
      } else notify("优化已完成，可从任务详情查看结果");
      setOptimization(null);
      refresh();
    } else if (
      ["failed", "cancelled", "needs_review"].includes(result.status)
    ) {
      setError(result.error ?? "优化任务未完成，请查看任务记录。");
      setOptimization(null);
    }
  }, [optimized.data, optimization]);
  function update(key: string, value: ToolInput[string]) {
    setInput((v) => ({ ...v, [key]: value }));
    idempotency.current = null;
    setError("");
    if (["voice", "avatar"].includes(key)) setCatalogNotice("");
  }
  async function saveDraft() {
    setBusy(true);
    setError("");
    try {
      if (onSaveDraft) {
        if (await onSaveDraft())
          notify("工作流已保存，可在工作流或我的草稿中继续");
        return;
      }
      const item = await post<Draft>("/drafts", {
        id: savedId || undefined,
        title: title || `${tool.title}草稿`,
        toolId: tool.id,
        projectId: project || undefined,
        input,
      });
      setSavedId(item.id);
      notify("草稿已保存到本地，可在任务记录中继续编辑");
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || externalBusy) return;
    setError("");
    for (const field of tool.fields) {
      const value = input[field.key];
      if (
        field.required &&
        (value == null ||
          value === "" ||
          (Array.isArray(value) && !value.length))
      ) {
        setError(`请填写${field.label}`);
        return;
      }
      if (
        field.type === "assets" &&
        Array.isArray(value) &&
        field.min &&
        value.length < field.min
      ) {
        setError(`${field.label}至少需要 ${field.min} 个素材`);
        return;
      }
    }
    try {
      validateInput(tool.id, input);
      if (providerProblem) throw new Error(providerProblem);
    } catch (e) {
      setError(validationMessage(e));
      return;
    }
    if (!executable) {
      setError("此工具尚未配置可用的模型服务。输入已保留，你可以先保存草稿。");
      return;
    }
    setBusy(true);
    idempotency.current ??= crypto.randomUUID();
    try {
      const payload: CreationPayload = {
        toolId: tool.id,
        title: title || tool.title,
        projectId: project || undefined,
        input,
        providerId: local ? undefined : chosenProvider?.id,
        idempotencyKey: idempotency.current,
      };
      const result = onSubmit
        ? await onSubmit(payload)
        : await post<{ items: Job[] }>("/jobs", payload);
      jobs.refresh();
      refresh();
      onSubmitted?.(result.items);
      if (!onSubmit) setShowJob(result.items[0]?.id ?? null);
      notify(`已创建 ${result.items.length} 个真实任务`);
      idempotency.current = null;
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function optimize(ocr = false) {
    const utility = tools.find(
      (t) => t.id === (ocr ? "ocr-prompt" : "prompt-optimize"),
    );
    const providerForUtility = providers.find(
      (p) =>
        p.configured && p.capabilities.includes(utility?.capability ?? "chat"),
    );
    if (!utility || !providerForUtility) {
      setError("此操作需要对应的视觉或文本模型服务，请先前往设置配置。");
      return;
    }
    setError("");
    try {
      const response = await post<{ items: Job[] }>("/jobs", {
        toolId: utility.id,
        input: ocr
          ? { sourceIds: ocrIds }
          : { prompt: String(input.prompt ?? input.text ?? "") },
        providerId: providerForUtility.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setOptimization(response.items[0]?.id ?? null);
    } catch (e) {
      setError(message(e));
    }
  }
  const mainFields = tool.fields.filter((field) =>
    ["textarea", "assets"].includes(field.type),
  );
  const settingFields = tool.fields.filter(
    (field) => !mainFields.includes(field),
  );
  const selectedAssets = assets.filter((asset) =>
    Object.values(input).some(
      (value) => Array.isArray(value) && value.includes(asset.id),
    ),
  );
  return (
    <>
      {!compact && (
        <>
          <button className="back-link" onClick={() => navigate("studio")}>
            <ArrowLeft size={16} />
            全部创作工具
          </button>
          <PageTitle
            eyebrow={
              tool.id === "replication"
                ? "RECREATE WITH YOUR OWN STORY"
                : "CREATIVE STUDIO"
            }
            title={tool.title}
            description={tool.description}
            actions={<Availability tool={tool} />}
          />
          <div className="creation-steps">
            <span className="active">
              <b>01</b>输入与素材
            </span>
            <span>
              <b>02</b>生成设置
            </span>
            <span>
              <b>03</b>结果与导出
            </span>
          </div>
        </>
      )}
      <div className={`editor-layout ${compact ? "compact-editor" : ""}`}>
        <form className="panel editor-form" onSubmit={(e) => void submit(e)}>
          <div className="section-heading">
            <h2>你的创作内容</h2>
            <span className="small muted">
              {onSaveDraft ? "随工作流保存" : savedId ? "已保存草稿" : "未保存"}
            </span>
          </div>
          <div className="form-two">
            <label className="field">
              <span>
                创作名称 <small>选填</small>
              </span>
              <input
                value={title}
                maxLength={120}
                placeholder={`为这次${tool.title}起个名字`}
                onChange={(e) => {
                  setTitle(e.target.value);
                  idempotency.current = null;
                }}
              />
            </label>
            <label className="field">
              <span>所属项目</span>
              <select
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  idempotency.current = null;
                }}
              >
                <option value="">个人创作</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {tool.note && <Notice>{tool.note}</Notice>}
          {capability.startsWith("workflow:") && (
            <Notice>
              此功能需要能够执行相应生成任务的专用服务。目前项目提供连接接口，尚未内置这项生成服务；普通聊天
              API 无法替代。配置前请确认服务实际支持此功能。
            </Notice>
          )}
          {mainFields.map((field) => (
            <FieldControl
              field={field}
              value={input[field.key]}
              key={field.key}
              provider={chosenProvider}
              limit={limitFor(field)}
              onChange={(value) => update(field.key, value)}
            />
          ))}
          {tool.id === "tts" && (
            <details className="details">
              <summary>从图片提取旁白文案</summary>
              <AssetField
                label="文案参考图"
                value={ocrIds}
                onChange={setOcrIds}
                accepts={["image"]}
                max={1}
              />
              <p className="small muted">
                所选图片会发送至已配置的视觉服务提取描述，不会随配音文字一并发送。
              </p>
            </details>
          )}
          {tool.fields.some((f) => ["prompt", "text"].includes(f.key)) &&
            !["prompt-optimize", "ocr-prompt"].includes(tool.id) && (
              <div className="actions wrap prompt-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    !!optimization ||
                    !String(input.prompt ?? input.text ?? "").trim()
                  }
                  onClick={() => void optimize()}
                >
                  {optimization ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <WandSparkles size={15} />
                  )}
                  {optimization
                    ? "正在优化…"
                    : `AI 优化描述${providers.find((p) => p.configured && p.capabilities.includes("chat")) ? ` · ${providers.find((p) => p.configured && p.capabilities.includes("chat"))?.name}` : ""}`}
                </button>
                {tool.id === "tts" && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={!!optimization || !ocrIds.length}
                    onClick={() => void optimize(true)}
                  >
                    从已选图片提取文案
                  </button>
                )}
              </div>
            )}
          <div className="form-section-title">
            <span>生成设置</span>
            <span className="line" />
          </div>
          <div className="settings-grid">
            {settingFields.map((field) => (
              <FieldControl
                field={field}
                value={input[field.key]}
                key={field.key}
                provider={chosenProvider}
                limit={limitFor(field)}
                onChange={(value) => update(field.key, value)}
              />
            ))}
          </div>
          {tool.fields.some((f) => f.key === "subtitleStyle") &&
            input.subtitleStyle !== "none" && (
              <SubtitlePreview
                styleId={String(input.subtitleStyle ?? "bold")}
                text={String(
                  input.subtitleText || input.text || input.sellingPoints || "",
                )}
              />
            )}
          {!local && (
            <label className="field">
              <span>模型服务</span>
              <select
                value={chosenProvider?.id ?? ""}
                onChange={(e) => {
                  setProvider(e.target.value);
                  idempotency.current = null;
                }}
              >
                <option value="" disabled>
                  选择已配置服务
                </option>
                {compatible.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.models[capability] ?? item.model}
                  </option>
                ))}
              </select>
            </label>
          )}
          {provider && !chosenProvider && !local && (
            <Notice>
              此前选择的服务当前不可用或不支持这项能力，请重新选择可用服务。已保存的输入会保留。
            </Notice>
          )}
          {!executable ? (
            <Notice>
              尚未配置支持此能力的模型服务。可以继续编辑与保存草稿。
              <button
                type="button"
                className="text-button"
                onClick={() => navigate("settings")}
              >
                前往配置 <ArrowRight size={14} />
              </button>
            </Notice>
          ) : !local ? (
            <div className="disclosure">
              <Sparkles size={15} />
              <span>
                开始生成后，创作文字
                {selectedAssets.length
                  ? `与所选 ${selectedAssets.length} 份素材`
                  : ""}
                将发送至 <strong>{chosenProvider?.name}</strong>{" "}
                处理，费用由你的服务商账户结算。服务配置不等于真实推理已验证。
              </span>
            </div>
          ) : (
            <div className="disclosure">
              <Check size={15} />
              <span>
                在这台 Mac 上处理所选素材，生成真实文件并保存到素材库。
              </span>
            </div>
          )}
          {limits.warnings.length > 0 && (
            <div className="provider-scope">
              <p className="small muted">
                {limits.warnings.map(readableLimit).join(" ")}
              </p>
            </div>
          )}
          {providerProblem && (
            <Notice>
              {readableLimit(providerProblem)} 请调整以上参数或服务配置后生成。
            </Notice>
          )}
          {catalogNotice && <Notice>{catalogNotice}</Notice>}
          {error && <ErrorPanel error={error} />}
          <div className="editor-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void saveDraft()}
            >
              <Save size={16} />
              {onSaveDraft ? "保存工作流" : "保存草稿"}
            </button>
            <button
              className="button primary"
              disabled={
                busy || externalBusy || !executable || !!providerProblem
              }
            >
              {busy || externalBusy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Sparkles size={17} />
              )}
              {busy || externalBusy
                ? "正在提交…"
                : local
                  ? "开始处理"
                  : "开始生成"}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
        <aside className="editor-results">
          <section className="panel preview-panel">
            <div className="section-heading">
              <h2>素材预览</h2>
              <span className="small muted">
                {selectedAssets.length} 份素材
              </span>
            </div>
            {selectedAssets.length ? (
              <>
                <MediaPreview asset={selectedAssets[0]} />
                <div className="preview-file">
                  <span>{selectedAssets[0].name}</span>
                  <span>
                    {
                      {
                        image: "图片",
                        video: "视频",
                        audio: "音频",
                        subtitle: "字幕",
                        document: "文档",
                      }[selectedAssets[0].kind]
                    }
                  </span>
                </div>
                {selectedAssets.length > 1 && (
                  <div className="preview-thumbs">
                    {selectedAssets.slice(1, 5).map((a) => (
                      <div key={a.id}>
                        <MediaPreview asset={a} compact />
                        <span>{a.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <Empty
                icon={Clapperboard}
                title="给创意留一个位置"
                detail="添加素材后可在这里预览。提交后的真实结果会保存在任务记录。"
              />
            )}
          </section>
          <section className="panel">
            <div className="section-heading">
              <h2>{onSubmit ? "此工具的最近创作" : "最近创作"}</h2>
              <div className="segmented">
                <button
                  type="button"
                  aria-label="列表视图"
                  aria-pressed={layout === "list"}
                  className={layout === "list" ? "active" : ""}
                  onClick={() => setLayout("list")}
                >
                  <List size={16} />
                </button>
                <button
                  type="button"
                  aria-label="网格视图"
                  aria-pressed={layout === "grid"}
                  className={layout === "grid" ? "active" : ""}
                  onClick={() => setLayout("grid")}
                >
                  <Grid2X2 size={16} />
                </button>
              </div>
            </div>
            {jobs.error && (
              <ErrorPanel error={jobs.error} retry={jobs.refresh} />
            )}
            {jobs.data.items.length ? (
              layout === "list" ? (
                jobs.data.items
                  .slice(0, 6)
                  .map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      onClick={() => setShowJob(job.id)}
                    />
                  ))
              ) : (
                <div className="history-grid">
                  {jobs.data.items.map((job) => (
                    <button
                      key={job.id}
                      className="history-card"
                      onClick={() => setShowJob(job.id)}
                    >
                      {job.outputs[0] ? (
                        <MediaPreview asset={job.outputs[0]} compact />
                      ) : (
                        <div className="history-placeholder">
                          <FileText size={25} />
                        </div>
                      )}
                      <span>{job.title}</span>
                      <small>{statuses[job.status] ?? job.status}</small>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <Empty
                title="从第一份作品开始"
                detail="该工具的真实任务与产物将保存在这里。"
              />
            )}
          </section>
        </aside>
      </div>
      <JobPanel
        id={showJob}
        onClose={() => setShowJob(null)}
        reuse={(job) => {
          setInput({ ...defaults(tool), ...cleanInput(tool, job.input) });
          setTitle(`${job.title} · 新版本`);
          idempotency.current = null;
        }}
      />
    </>
  );
}
function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["text", "prompt", "content", "output"]) {
      const part = (value as Record<string, unknown>)[key];
      if (typeof part === "string") return part;
    }
  }
  return "";
}

function validationMessage(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: { message: string; path: string[] }[] })
      .issues;
    return issues
      .map(
        (issue) =>
          `${issue.path.length ? issue.path.join(".") + "：" : ""}${issue.message}`,
      )
      .join("；");
  }
  return message(error);
}

function cleanInput(tool: Tool, input: ToolInput): ToolInput {
  const keys = new Set(tool.fields.map((field) => field.key));
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => keys.has(key)),
  );
}

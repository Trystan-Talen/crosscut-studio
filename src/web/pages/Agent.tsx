import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Bot,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Conversation, Job } from "../../shared/types";
import {
  date,
  message,
  navigate,
  patch,
  post,
  useQuery,
  useRoute,
} from "../api";
import { useWorkspace } from "../context";
import {
  AgentCreation,
  agentModeKey,
  copyAgentForms,
  type AgentMode,
  type AgentHandoff,
} from "../components/AgentCreation";
import type { CreationPayload } from "./Studio";
import {
  CopyButton,
  Drawer,
  Empty,
  ErrorPanel,
  JobPanel,
  JobRow,
  Loading,
  Notice,
  PageTitle,
  Status,
} from "../ui";
const draftKey = (userId: string, conversationId: string | null = null) =>
  `crosscut-agent-draft:${userId}:${conversationId ?? "new"}`;
export function Agent() {
  const { providers, notify, user } = useWorkspace();
  const { params } = useRoute();
  const requestedId = params.get("conversation");
  const [id, setId] = useState<string | null>(requestedId);
  const [mode, setMode] = useState<AgentMode>(() =>
    readMode(user.id, requestedId),
  );
  const [handoff, setHandoff] = useState<AgentHandoff | null>(null);
  const [showJob, setShowJob] = useState<string | null>(null);
  const chatRequest = useRef<{
    key: string;
    conversationId: string;
    providerId: string;
    content: string;
  } | null>(null);
  const creationRequests = useRef(new Map<string, string>());
  const [trash, setTrash] = useState(false);
  const [text, setText] = useState(
    () => sessionStorage.getItem(draftKey(user.id)) ?? "",
  );
  const [provider, setProvider] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [rename, setRename] = useState<Conversation | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const list = useQuery<{ items: Conversation[] }>(
    "/conversations" + (trash ? "?trash=1" : ""),
    { items: [] },
  );
  const detail = useQuery<Conversation | null>(
    id ? `/conversations/${id}` : null,
    null,
    id ? 2500 : 0,
  );
  const task = useQuery<Job | null>(
    jobId ? `/jobs/${jobId}` : null,
    null,
    jobId ? 2500 : 0,
  );
  const compatible = providers.filter(
    (p) => p.configured && p.capabilities.includes("chat"),
  );
  const selected = compatible.find((p) => p.id === provider) ?? compatible[0];
  const conversation = detail.data?.id === id ? detail.data : null;
  const linkedJobs = conversation?.jobs ?? [];
  const pendingChat = linkedJobs.find(
    (job) =>
      job.toolId === "agent-chat" && ["queued", "running"].includes(job.status),
  );
  const latestPlan =
    [...(conversation?.messages ?? [])]
      .reverse()
      .find((item) => item.role === "assistant")?.content ?? "";
  useEffect(() => {
    if (requestedId !== id) {
      chatRequest.current = null;
      setId(requestedId);
      setJobId(null);
      setHandoff(null);
    }
  }, [requestedId]);
  function chooseConversation(nextId: string | null) {
    chatRequest.current = null;
    setId(nextId);
    setJobId(null);
    setHandoff(null);
    setError("");
    navigate("agent", nextId ? { conversation: nextId } : {});
  }
  function chooseMode(next: AgentMode) {
    setMode(next);
    setHandoff(null);
    setError("");
    sessionStorage.setItem(agentModeKey(user.id, id), next);
  }
  function usePlan(next: "video" | "replication", content: string) {
    if (busy) return;
    chooseMode(next);
    setHandoff({ mode: next, text: content, revision: Date.now() });
  }
  useEffect(() => {
    setText(sessionStorage.getItem(draftKey(user.id, id)) ?? "");
    setMode(readMode(user.id, id));
  }, [id, user.id]);
  useEffect(() => {
    if (
      task.data?.id === jobId &&
      task.data &&
      ["succeeded", "failed", "cancelled", "needs_review"].includes(
        task.data.status,
      )
    ) {
      if (task.data.error) setError(task.data.error);
      detail.refresh();
      list.refresh();
      setJobId(null);
    }
  }, [task.data]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [conversation?.messages?.length]);
  async function create(initialDraft?: string, preserveForms = false) {
    try {
      const created = await post<Conversation>("/conversations", {
        title: "新的创意",
      });
      if (initialDraft)
        sessionStorage.setItem(draftKey(user.id, created.id), initialDraft);
      if (preserveForms && !id) copyAgentForms(user.id, created.id);
      sessionStorage.setItem(agentModeKey(user.id, created.id), mode);
      setId(created.id);
      navigate("agent", { conversation: created.id });
      setTrash(false);
      list.refresh();
      return created.id;
    } catch (e) {
      setError(message(e));
      return null;
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || busy || jobId || pendingChat) return;
    if (!selected) {
      setError("请配置文本模型服务。输入已暂存，可以稍后继续。");
      return;
    }
    setBusy(true);
    setError("");
    const content = text;
    try {
      const conversationId = id ?? (await create(content, true));
      if (!conversationId) return;
      if (
        !chatRequest.current ||
        chatRequest.current.conversationId !== conversationId ||
        chatRequest.current.providerId !== selected.id ||
        chatRequest.current.content !== content
      )
        chatRequest.current = {
          key: crypto.randomUUID(),
          conversationId,
          providerId: selected.id,
          content,
        };
      const job = await post<Job>(`/conversations/${conversationId}/messages`, {
        content,
        providerId: selected.id,
        idempotencyKey: chatRequest.current.key,
      });
      chatRequest.current = null;
      setJobId(job.id);
      sessionStorage.removeItem(draftKey(user.id, id));
      sessionStorage.removeItem(draftKey(user.id, conversationId));
      setText("");
      detail.refresh();
      list.refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function submitCreation(
    payload: CreationPayload,
  ): Promise<{ items: Job[] }> {
    setBusy(true);
    setError("");
    try {
      const conversationId = id ?? (await create(text, true));
      if (!conversationId) throw new Error("对话尚未创建，请重试。");
      const fingerprint = `${conversationId}:${JSON.stringify({ ...payload, idempotencyKey: undefined, input: Object.fromEntries(Object.entries(payload.input).sort(([a], [b]) => a.localeCompare(b))) })}`;
      const key =
        creationRequests.current.get(fingerprint) ?? payload.idempotencyKey;
      creationRequests.current.set(fingerprint, key);
      const result = await post<{ items: Job[] }>(
        `/conversations/${conversationId}/creations`,
        { ...payload, idempotencyKey: key },
      );
      creationRequests.current.delete(fingerprint);
      detail.refresh();
      list.refresh();
      return result;
    } finally {
      setBusy(false);
    }
  }
  async function toggleDelete(item: Conversation) {
    try {
      await patch(`/conversations/${item.id}`, { deleted: !trash });
      if (id === item.id) chooseConversation(null);
      list.refresh();
      notify(trash ? "对话已恢复" : "对话已移入回收站");
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="A PARTNER FOR YOUR NEXT IDEA"
        title="把一个念头，聊成一份方案。"
        description="围绕产品、受众和创意方向展开讨论，保存可继续创作的脚本。"
      />
      <Notice>
        方案模式讨论创意；视频和产品复刻模式可由你明确提交生成，任务会关联到当前对话。带入方案后仍需核对素材与参数，不会自动规划或提交收费任务。
      </Notice>
      <div className="agent-layout">
        <aside className="panel conversation-list">
          <button
            className="button primary full"
            disabled={busy}
            onClick={() => {
              chatRequest.current = null;
              setHandoff(null);
              setBusy(true);
              void create().finally(() => setBusy(false));
            }}
          >
            <Plus size={16} />
            新对话
          </button>
          <div className="tabs">
            <button
              className={!trash ? "active" : ""}
              onClick={() => setTrash(false)}
            >
              对话
            </button>
            <button
              className={trash ? "active" : ""}
              onClick={() => setTrash(true)}
            >
              回收站
            </button>
          </div>
          {list.error && <ErrorPanel error={list.error} retry={list.refresh} />}
          {list.data.items.length ? (
            list.data.items.map((item) => (
              <div
                className={`conversation-item ${id === item.id ? "active" : ""}`}
                key={item.id}
              >
                <button
                  onClick={() => {
                    if (!trash) chooseConversation(item.id);
                  }}
                  disabled={trash || busy}
                >
                  <MessageSquare size={15} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{date(item.updatedAt)}</small>
                  </span>
                </button>
                <div className="conversation-actions">
                  {!trash && (
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`重命名${item.title}`}
                      onClick={() => setRename(item)}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`${trash ? "恢复" : "移入回收站"}${item.title}`}
                    onClick={() => void toggleDelete(item)}
                  >
                    {trash ? <RotateCcw size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="muted small">
              {trash ? "回收站是空的" : "新的灵感，从第一句开始。"}
            </p>
          )}
        </aside>
        <div className="agent-workspace">
          <div className="tabs agent-mode-tabs" aria-label="创意模式">
            {(["plan", "video", "replication"] as const).map((item) => (
              <button
                key={item}
                disabled={busy}
                className={mode === item ? "active" : ""}
                aria-pressed={mode === item}
                onClick={() => chooseMode(item)}
              >
                {item === "plan"
                  ? "方案讨论"
                  : item === "video"
                    ? "视频创作"
                    : "产品复刻"}
              </button>
            ))}
          </div>
          {mode !== "plan" && error && <ErrorPanel error={error} />}
          {mode === "plan" ? (
            <section className="panel chat-panel">
              <div className="chat-top">
                <div>
                  <Bot size={20} />
                  <strong>{conversation?.title ?? "你的创意伙伴"}</strong>
                </div>
                <select
                  aria-label="对话模型服务"
                  value={selected?.id ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    chatRequest.current = null;
                  }}
                >
                  <option value="" disabled>
                    未配置文本模型
                  </option>
                  {compatible.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="chat-messages">
                {detail.error && (
                  <ErrorPanel error={detail.error} retry={detail.refresh} />
                )}
                {detail.loading && id && !conversation ? (
                  <Loading />
                ) : conversation?.messages?.length ? (
                  conversation.messages!.map((item) => (
                    <article
                      key={item.id}
                      className={`chat-message ${item.role}`}
                    >
                      <span className="message-avatar">
                        {item.role === "assistant" ? (
                          <Sparkles size={16} />
                        ) : (
                          "我"
                        )}
                      </span>
                      <div>
                        <div className="message-body">{item.content}</div>
                        {item.role === "assistant" && (
                          <div className="actions wrap">
                            <CopyButton text={item.content} label="复制方案" />
                            <button
                              className="text-button"
                              onClick={() => usePlan("video", item.content)}
                            >
                              用于视频创作 <ArrowRight size={14} />
                            </button>
                            <button
                              className="text-button"
                              onClick={() =>
                                usePlan("replication", item.content)
                              }
                            >
                              用于产品复刻 <ArrowRight size={14} />
                            </button>
                          </div>
                        )}
                        {item.jobId && (
                          <button
                            className="text-button"
                            onClick={() => setShowJob(item.jobId!)}
                          >
                            查看关联任务 <ArrowRight size={14} />
                          </button>
                        )}
                        <small>{date(item.createdAt)}</small>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="chat-welcome">
                    <span className="chat-welcome-icon">
                      <Sparkles size={30} strokeWidth={1.3} />
                    </span>
                    <h2>
                      下一条好广告，
                      <br />
                      可以从一句话开始。
                    </h2>
                    <p>
                      告诉我你的产品、目标受众或参考风格，
                      <br />
                      一起整理创意方向与镜头脚本。
                    </p>
                    <div className="suggestion-grid">
                      {[
                        "为一款旅行收纳袋设计 15 秒短视频脚本",
                        "如何用产品特写表达护肤品的轻盈质地？",
                        "帮我梳理一个“痛点—产品—转化”的广告结构",
                      ].map((item) => (
                        <button
                          key={item}
                          onClick={() => {
                            if (busy) return;
                            chatRequest.current = null;
                            setText(item);
                            sessionStorage.setItem(draftKey(user.id, id), item);
                          }}
                        >
                          {item}
                          <ArrowRight size={15} />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(jobId || pendingChat) && (
                  <div className="chat-pending">
                    <Bot size={17} />
                    <span>模型正在处理真实请求</span>
                    {(task.data || pendingChat) && (
                      <Status status={(task.data || pendingChat)!.status} />
                    )}
                  </div>
                )}
                <div ref={bottom} />
              </div>
              <form className="chat-composer" onSubmit={(e) => void send(e)}>
                {error && <ErrorPanel error={error} />}
                {!selected && (
                  <Notice>
                    尚未配置文本模型。你可以先写下想法。
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => navigate("settings")}
                    >
                      配置模型服务
                    </button>
                  </Notice>
                )}
                <textarea
                  aria-label="发送给创意助手的内容"
                  placeholder="描述你的产品，或聊聊还不成形的灵感…"
                  rows={3}
                  value={text}
                  disabled={busy}
                  maxLength={10000}
                  onChange={(e) => {
                    chatRequest.current = null;
                    setText(e.target.value);
                    sessionStorage.setItem(
                      draftKey(user.id, id),
                      e.target.value,
                    );
                  }}
                />
                <div className="row">
                  <small className="muted">
                    {selected
                      ? `发送至 ${selected.name} · 不自动调用视频生成`
                      : "输入暂存在当前浏览器会话"}
                  </small>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !!jobId ||
                      !!pendingChat ||
                      !text.trim() ||
                      !selected
                    }
                  >
                    <Send size={16} />
                    {busy ? "发送中…" : "发送"}
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <AgentCreation
              key={`${user.id}:${id ?? "new"}:${mode}`}
              mode={mode}
              conversationId={id}
              latestPlan={latestPlan}
              handoff={handoff}
              onHandoffConsumed={() => setHandoff(null)}
              submitting={busy}
              submit={submitCreation}
              onSubmitted={(jobs) => {
                setShowJob(jobs[0]?.id ?? null);
                detail.refresh();
                list.refresh();
              }}
            />
          )}
          {!!linkedJobs.length && (
            <section className="panel agent-linked-jobs">
              <h2>当前对话的真实任务</h2>
              <p className="small muted">
                状态和产物来自已关联的任务，刷新后可继续查看。
              </p>
              {linkedJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onClick={() => setShowJob(job.id)}
                />
              ))}
            </section>
          )}
        </div>
      </div>
      <JobPanel id={showJob} onClose={() => setShowJob(null)} />
      <Drawer
        open={!!rename}
        title="重命名对话"
        onClose={() => setRename(null)}
      >
        {rename && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const title = String(new FormData(e.currentTarget).get("title"));
              void patch(`/conversations/${rename.id}`, { title })
                .then(() => {
                  setRename(null);
                  list.refresh();
                  detail.refresh();
                })
                .catch((e) => setError(message(e)));
            }}
          >
            <label className="field">
              <span>对话名称</span>
              <input
                name="title"
                required
                maxLength={100}
                defaultValue={rename.title}
              />
            </label>
            <button className="button primary">保存名称</button>
          </form>
        )}
      </Drawer>
    </>
  );
}

function readMode(userId: string, conversationId: string | null): AgentMode {
  const saved = sessionStorage.getItem(agentModeKey(userId, conversationId));
  return saved === "video" || saved === "replication" ? saved : "plan";
}

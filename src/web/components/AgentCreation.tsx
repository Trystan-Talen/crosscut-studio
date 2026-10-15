import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import type { Job, ToolInput } from "../../shared/types";
import type { WorkflowForm } from "../workflow-state";
import { useWorkspace } from "../context";
import { Empty, ErrorPanel, Notice } from "../ui";
import { ToolEditor, type CreationPayload } from "../pages/Studio";

export type AgentMode = "plan" | "video" | "replication";
export type AgentHandoff = {
  mode: Exclude<AgentMode, "plan">;
  text: string;
  revision: number;
};
export const agentModeKey = (userId: string, conversationId: string | null) =>
  `crosscut-agent-mode:${userId}:${conversationId ?? "new"}`;
const formKey = (userId: string, conversationId: string | null, mode: string) =>
  `crosscut-agent-form:${userId}:${conversationId ?? "new"}:${mode}`;
export function copyAgentForms(userId: string, conversationId: string) {
  for (const mode of ["video", "replication"]) {
    const content = sessionStorage.getItem(formKey(userId, null, mode));
    if (content)
      sessionStorage.setItem(formKey(userId, conversationId, mode), content);
  }
}
function readForm(key: string): WorkflowForm | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as Partial<WorkflowForm> | null;
    if (!value || typeof value.input !== "object" || !value.input)
      return undefined;
    const input: ToolInput = {};
    for (const [name, field] of Object.entries(value.input))
      if (
        typeof field === "string" ||
        typeof field === "number" ||
        typeof field === "boolean" ||
        (Array.isArray(field) &&
          field.every((item) => typeof item === "string"))
      )
        input[name] = field;
    return {
      input,
      title: typeof value.title === "string" ? value.title : "",
      providerId: typeof value.providerId === "string" ? value.providerId : "",
      projectId: typeof value.projectId === "string" ? value.projectId : "",
    };
  } catch {
    return undefined;
  }
}
export function AgentCreation({
  mode,
  conversationId,
  latestPlan,
  handoff,
  onHandoffConsumed,
  submitting,
  submit,
  onSubmitted,
}: {
  mode: Exclude<AgentMode, "plan">;
  conversationId: string | null;
  latestPlan: string;
  handoff: AgentHandoff | null;
  onHandoffConsumed: () => void;
  submitting: boolean;
  submit: (payload: CreationPayload) => Promise<{ items: Job[] }>;
  onSubmitted: (jobs: Job[]) => void;
}) {
  const { tools, user } = useWorkspace();
  const key = formKey(user.id, conversationId, mode);
  const [snapshot, setSnapshot] = useState<WorkflowForm | undefined>(() =>
    readForm(key),
  );
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [imported, setImported] = useState(false);
  const tool = tools.find(
    (item) => item.id === (mode === "video" ? "video-studio" : "replication"),
  );
  function remember(value: WorkflowForm) {
    setSnapshot(value);
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      setError(
        "当前浏览器无法暂存表单。请使用“保存草稿”持久保存，避免刷新后丢失输入。",
      );
    }
  }
  function applyPlan(text: string) {
    if (!text) return;
    remember({
      input: {
        ...snapshot?.input,
        [mode === "video" ? "prompt" : "direction"]: text,
      },
      title: snapshot?.title ?? "",
      providerId: snapshot?.providerId ?? "",
      projectId: snapshot?.projectId ?? "",
    });
    setImported(true);
    setRevision((value) => value + 1);
  }
  useEffect(() => {
    if (handoff?.mode === mode) {
      applyPlan(handoff.text);
      onHandoffConsumed();
    }
  }, [handoff?.revision]);
  return (
    <>
      <section className="panel agent-creation-intro">
        <div>
          <span className="eyebrow">
            {mode === "video" ? "VIDEO CREATION" : "PRODUCT RECREATION"}
          </span>
          <h2>
            {mode === "video"
              ? "把方案，变成视频。"
              : "用自己的产品，重新演绎。"}
          </h2>
          <p className="muted">
            填写素材和参数后，点击生成才会提交至选定服务。真实任务与产物会关联到当前对话。
          </p>
        </div>
        {latestPlan && (
          <button
            className="button secondary small-button"
            disabled={submitting}
            onClick={() => applyPlan(latestPlan)}
          >
            <Sparkles size={15} />
            带入最新助手方案 <ArrowRight size={15} />
          </button>
        )}
      </section>
      {imported && (
        <Notice>
          已完整带入助手方案。请根据本工具的字数限制精简，并核对素材、服务和生成设置后再提交。
        </Notice>
      )}
      {error && <ErrorPanel error={error} />}
      {tool ? (
        <ToolEditor
          key={`${key}:${revision}`}
          tool={tool}
          compact
          initialSnapshot={snapshot}
          onSnapshotChange={remember}
          onSubmit={submit}
          externalBusy={submitting}
          onSubmitted={onSubmitted}
        />
      ) : (
        <Empty title="当前工具暂不可用" />
      )}
      <p className="small muted">
        表单暂存于当前账号的浏览器会话；“保存草稿”会持久保存到任务记录。恢复对话可查看已提交的关联任务。
      </p>
    </>
  );
}

import { z } from "zod";
import type { Draft, ToolInput } from "../shared/types";

const inputSchema = z.record(
  z.string().max(100),
  z.union([
    z.string().max(30000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(300)).max(100),
  ]),
);
const formSchema = z
  .object({
    input: inputSchema,
    title: z.string().max(120),
    projectId: z.string(),
    providerId: z.string(),
  })
  .strict();
const ids = z.array(z.string().uuid()).max(100);
const stateSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string(),
    flow: z.enum(["game", "commerce"]),
    title: z.string().min(1).max(250),
    step: z.number().int().min(1).max(3),
    images: ids.max(2),
    imageSource: z.enum(["none", "pending-generated", "generated", "manual"]),
    firstJob: z.string().uuid().nullable(),
    scriptJob: z.string().uuid().nullable(),
    videoJob: z.string().uuid().nullable(),
    outputs: z.object({ image: ids, script: ids, video: ids }).strict(),
    jobIds: z
      .object({ image: ids, script: ids, video: ids })
      .strict()
      .default({ image: [], script: [], video: [] }),
    url: z.string().max(4000),
    product: inputSchema,
    forms: z
      .object({
        image: formSchema.optional(),
        script: formSchema.optional(),
        video: formSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .refine((state) => state.flow !== "game" || state.step <= 2);

export type WorkflowState = z.infer<typeof stateSchema>;
export type WorkflowForm = z.infer<typeof formSchema>;
export type WorkflowKind = WorkflowState["flow"];
export type WorkflowStage = keyof WorkflowState["forms"];
export const workflowName = (flow: WorkflowKind) =>
  flow === "game" ? "游戏概念视频" : "产品推广创作";
export const isWorkflowDraft = (draft: Pick<Draft, "toolId">) =>
  ["workflow-game", "workflow-commerce"].includes(draft.toolId);

export function newWorkflow(
  flow: WorkflowKind,
  ownerId: string,
): WorkflowState {
  return {
    version: 1,
    ownerId,
    flow,
    title: workflowName(flow),
    step: 1,
    images: [],
    imageSource: "none",
    firstJob: null,
    scriptJob: null,
    videoJob: null,
    outputs: { image: [], script: [], video: [] },
    jobIds: { image: [], script: [], video: [] },
    url: "",
    product: {},
    forms: {},
  };
}

function encode(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length > 30000)
    throw new Error(
      "此步骤的内容超过草稿容量，请缩短文案后重新保存。现有已保存版本不会被覆盖。",
    );
  return text;
}

// The existing draft API accepts flat values. Each versioned section is encoded
// separately, so a long script does not reduce the other stages' storage limits.
export function workflowInput(state: WorkflowState): ToolInput {
  const parsed = stateSchema.parse(state);
  const { product, forms, ...core } = parsed;
  const input: ToolInput = {
    workflowVersion: 1,
    state: encode(core),
    product: encode(product),
  };
  for (const stage of ["image", "script", "video"] as const)
    if (forms[stage]) input[`${stage}Form`] = encode(forms[stage]);
  return input;
}

export function restoreWorkflow(draft: Draft, ownerId: string): WorkflowState {
  if (!isWorkflowDraft(draft) || draft.input.workflowVersion !== 1)
    throw new Error("这份工作流草稿的版本暂不支持，请保留原草稿并新建流程。");
  const parse = (key: string, fallback: unknown) => {
    const text = draft.input[key];
    return typeof text === "string" ? (JSON.parse(text) as unknown) : fallback;
  };
  try {
    const core = parse("state", {});
    const state = stateSchema.parse({
      ...(core && typeof core === "object" ? core : {}),
      product: parse("product", {}),
      forms: {
        image: parse("imageForm", undefined),
        script: parse("scriptForm", undefined),
        video: parse("videoForm", undefined),
      },
    });
    if (state.ownerId !== ownerId || draft.toolId !== `workflow-${state.flow}`)
      throw new Error("工作流归属不匹配");
    return state;
  } catch {
    throw new Error(
      "无法读取当前账号的这份工作流草稿。原记录仍保留，请检查账号或新建流程。",
    );
  }
}

import { describe, expect, it } from "vitest";
import type { Draft } from "../src/shared/types";
import {
  newWorkflow,
  restoreWorkflow,
  workflowInput,
  isWorkflowDraft,
} from "../src/web/workflow-state";
import { openaiBuiltInVoices } from "../src/shared/provider-voices";

const owner = "owner-one";
const imageId = "66c75f8c-df65-4f2c-8043-b57f49d897bb";
const jobId = "741c5a41-a7c6-41ab-a41d-3b018a9516a1";
const draftOf = (state = newWorkflow("game", owner)): Draft => ({
  id: "9a5b4c9f-2e0a-49f4-8eba-834da7e70294",
  title: state.title,
  toolId: `workflow-${state.flow}`,
  projectId: null,
  input: workflowInput(state),
  updatedAt: "2026-10-14T12:00:00.000Z",
});

describe("versioned workflow drafts", () => {
  it("restores the current step, manual image provenance, provider/project and real task/output references", () => {
    const state = newWorkflow("game", owner);
    state.step = 2;
    state.images = [imageId];
    state.imageSource = "manual";
    state.firstJob = jobId;
    state.videoJob = jobId;
    state.outputs.image = [imageId];
    state.jobIds.image = [jobId];
    state.jobIds.video = [jobId];
    state.forms.image = {
      input: { prompt: "第一步创意" },
      title: "场景图",
      providerId: "image-provider",
      projectId: "project-one",
    };
    state.forms.video = {
      input: {
        prompt: "保持构图，推进镜头",
        sourceIds: [imageId],
        ratio: "9:16",
      },
      title: "产品动效",
      providerId: "video-provider",
      projectId: "project-one",
    };
    expect(restoreWorkflow(draftOf(state), owner)).toEqual(state);
  });
  it("retains product details and independently edited script/video forms without truncating or merging them", () => {
    const state = newWorkflow("commerce", owner);
    state.step = 3;
    state.url = "https://example.com/product";
    state.product = {
      productName: "旅行袋",
      sellingPoints: "轻便好收纳",
      price: "29.99",
      audience: "旅人",
    };
    state.scriptJob = jobId;
    state.forms.script = {
      input: { productName: "单独编辑的脚本产品名", sellingPoints: "脚本卖点" },
      title: "广告脚本",
      projectId: "",
      providerId: "text-provider",
    };
    state.forms.video = {
      input: { script: "用户核对后的脚本".repeat(500), url: state.url },
      title: "广告",
      projectId: "",
      providerId: "workflow-provider",
    };
    expect(restoreWorkflow(draftOf(state), owner)).toEqual(state);
    for (const value of Object.values(draftOf(state).input))
      expect(["number", "string"]).toContain(typeof value);
  });
  it("rejects another user's serialized workflow even if a caller passes a draft", () => {
    expect(() => restoreWorkflow(draftOf(), "owner-two")).toThrow("当前账号");
  });
  it("rejects invalid schema versions, malformed JSON and mismatched flow types without replacing data", () => {
    const draft = draftOf();
    expect(() =>
      restoreWorkflow(
        { ...draft, input: { ...draft.input, workflowVersion: 2 } },
        owner,
      ),
    ).toThrow("版本");
    expect(() =>
      restoreWorkflow(
        { ...draft, input: { ...draft.input, state: "broken" } },
        owner,
      ),
    ).toThrow("原记录仍保留");
    expect(() =>
      restoreWorkflow({ ...draft, toolId: "workflow-commerce" }, owner),
    ).toThrow("原记录仍保留");
    expect(isWorkflowDraft({ toolId: "image-generate" })).toBe(false);
  });
  it("rejects a section exceeding the draft API limit instead of silently truncating it", () => {
    const state = newWorkflow("commerce", owner);
    state.forms.video = {
      input: { script: "a".repeat(20000), prompt: "b".repeat(11000) },
      title: "广告",
      providerId: "",
      projectId: "",
    };
    expect(() => workflowInput(state)).toThrow("超过草稿容量");
  });
  it("does not serialize undeclared properties such as credentials or a nonexistent game stage", () => {
    const state = newWorkflow("game", owner);
    expect(() =>
      workflowInput({ ...state, secret: "not-a-real-key" } as typeof state),
    ).toThrow();
    expect(() => workflowInput({ ...state, step: 3 })).toThrow();
  });
});

describe("shared OpenAI voice model compatibility", () => {
  it("shows legacy-compatible built-ins and excludes newer-only voices for tts-1", () => {
    expect(openaiBuiltInVoices("tts-1")).toHaveLength(9);
    expect(openaiBuiltInVoices("tts-1-hd")).not.toContain("marin");
    expect(openaiBuiltInVoices("gpt-4o-mini-tts")).toHaveLength(13);
    expect(openaiBuiltInVoices("gpt-4o-mini-tts")).toContain("cedar");
  });
});

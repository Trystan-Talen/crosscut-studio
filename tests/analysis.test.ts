import { describe, expect, it } from "vitest";
import {
  ANALYSIS_LIMITS,
  analysisInstruction,
  parseAnalysisResult,
  timelineV2Schema,
  type AnalysisTimelineV2,
  type AnalysisMechanismV2,
} from "../src/shared/analysis.js";

// Synthetic contract fixtures validate structure, not real model interpretation.
function timeline(): AnalysisTimelineV2 {
  return {
    schemaVersion: 2,
    summary: "测试视频包含商品特写和使用画面。",
    stages: [
      {
        title: "商品展示",
        start: 0,
        end: 2,
        purpose: "可能用于建立商品识别。",
        content: "收纳袋出现在桌面上。",
        shots: [
          {
            start: 0,
            end: 1,
            description: "桌上的收纳袋特写。",
            shotSize: "特写",
            angle: "俯视",
            action: null,
            onScreenText: "TRAVEL",
            textTranslation: "旅行",
          },
          {
            start: 1,
            end: 2,
            description: "收纳袋的内部空间。",
            shotSize: "近景",
            angle: null,
            action: null,
            onScreenText: "",
            textTranslation: "",
          },
        ],
      },
      {
        title: "使用场景",
        start: 2,
        end: 6,
        purpose: null,
        content: "手持收纳袋的抽样画面。",
        shots: [
          {
            start: 2,
            end: 6,
            description: "画面中出现手和收纳袋。",
            shotSize: null,
            angle: null,
            action: null,
            onScreenText: null,
            textTranslation: null,
          },
        ],
      },
    ],
    limitations: ["这是结构测试数据；仅有抽样画面时无法确认连续动作及声音。"],
  };
}

function mechanism(): AnalysisMechanismV2 {
  return {
    schemaVersion: 2,
    summary: "测试建议围绕商品细节展示展开。",
    strengths: ["商品主体可辨认。"],
    weaknesses: [],
    priorityActions: ["建议增加可验证的尺寸参照。"],
    mechanisms: [
      {
        name: "细节展示",
        summary: "用内部空间画面说明结构。",
        goals: ["吸引", "留存"],
        evidence: [{ start: 1, end: 2, description: "可见收纳袋内部。" }],
        principle: "对产品结构的可视说明可能减少理解成本。",
        problem: null,
        action: "建议加入用户已有的尺寸信息。",
        expectedBenefit: "可能帮助观众理解尺寸，属于建议，未经投放验证。",
      },
    ],
    limitations: ["无法从画面测定留存或转化。"],
  };
}

describe("versioned analysis results", () => {
  it("preserves detailed v2 fields, explicit unknowns and known absent screen text", () => {
    const result = parseAnalysisResult("analysis-timeline", timeline(), 6);
    expect(result).toEqual(timeline());
    expect(parseAnalysisResult("video-understand", timeline(), 6)).toEqual(
      result,
    );
    expect(
      timelineV2Schema.parse(timeline()).stages[0].shots[1].onScreenText,
    ).toBe("");
  });

  it("retains legacy shapes without fabricating detailed facts or version metadata", () => {
    const oldTimeline = {
      summary: "旧分镜",
      timeline: [{ start: 0, end: 6, description: "画面描述" }],
    };
    const oldMechanism = {
      summary: "旧机制",
      mechanisms: [{ name: "展示", evidence: "商品特写", suggestion: "" }],
    };
    expect(parseAnalysisResult("analysis-timeline", oldTimeline, 6)).toEqual(
      oldTimeline,
    );
    expect(
      parseAnalysisResult("analysis-mechanism", oldMechanism, null),
    ).toEqual(oldMechanism);
    expect(
      parseAnalysisResult(
        "analysis-timeline",
        { ...oldTimeline, schemaVersion: 1 },
        6,
      ),
    ).toEqual({ ...oldTimeline, schemaVersion: 1 });
    expect(
      parseAnalysisResult("analysis-prompt", { prompt: "旧提示词" }, null),
    ).toEqual({ prompt: "旧提示词", limitations: [] });
  });

  it("does not accept unsupported versions, mismatched sections or undeclared facts", () => {
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        { ...timeline(), schemaVersion: 3 },
        6,
      ),
    ).toThrow();
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        { ...timeline(), schemaVersion: 1 },
        6,
      ),
    ).toThrow();
    expect(() =>
      parseAnalysisResult("analysis-mechanism", timeline(), 6),
    ).toThrow();
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        { ...timeline(), verifiedConversionRate: 99 },
        6,
      ),
    ).toThrow();
    expect(() => parseAnalysisResult("agent-chat", timeline(), 6)).toThrow(
      /不支持/,
    );
    expect(() =>
      parseAnalysisResult("analysis-timeline", JSON.stringify(timeline()), 6),
    ).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -1, "1"])(
    "rejects nonfinite, negative or coerced time %s",
    (invalid) => {
      const value = timeline();
      Object.assign(value.stages[0].shots[0], { start: invalid });
      expect(() =>
        parseAnalysisResult("analysis-timeline", value, 6),
      ).toThrow();
    },
  );

  it("rejects zero and backwards spans in legacy, stage, shot and evidence results", () => {
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        {
          summary: "旧数据",
          timeline: [{ start: 1, end: 1, description: "零时长" }],
        },
        6,
      ),
    ).toThrow();
    const stage = timeline();
    stage.stages[0].end = 0;
    expect(() => parseAnalysisResult("analysis-timeline", stage, 6)).toThrow();
    const shot = timeline();
    shot.stages[0].shots[0].end = 0;
    expect(() => parseAnalysisResult("analysis-timeline", shot, 6)).toThrow();
    const value = mechanism();
    value.mechanisms[0].evidence[0].end = 0.5;
    expect(() => parseAnalysisResult("analysis-mechanism", value, 6)).toThrow();
  });

  it("requires valid probed duration for timed results and rejects even small overruns", () => {
    expect(() =>
      parseAnalysisResult("analysis-timeline", timeline(), null),
    ).toThrow(/真实视频时长/);
    expect(() =>
      parseAnalysisResult("analysis-mechanism", mechanism(), null),
    ).toThrow(/真实视频时长/);
    expect(() =>
      parseAnalysisResult("analysis-timeline", timeline(), 6 - 1e-9),
    ).toThrow(/实际时长/);
    for (const duration of [NaN, Infinity, -Infinity, 0, -1])
      expect(() =>
        parseAnalysisResult("analysis-timeline", timeline(), duration),
      ).toThrow(/有限正数/);
    expect(() =>
      parseAnalysisResult("analysis-mechanism", mechanism(), 1.9),
    ).toThrow(/实际时长/);
  });

  it("rejects out-of-order or overlapping stages and shots without silently sorting them", () => {
    const stages = timeline();
    stages.stages.reverse();
    expect(() => parseAnalysisResult("analysis-timeline", stages, 6)).toThrow();
    const overlap = timeline();
    overlap.stages[1].start = 1.5;
    expect(() =>
      parseAnalysisResult("analysis-timeline", overlap, 6),
    ).toThrow();
    const shots = timeline();
    shots.stages[0].shots[1].start = 0.5;
    expect(() => parseAnalysisResult("analysis-timeline", shots, 6)).toThrow();
  });

  it("keeps shots inside their parent while allowing unobserved gaps", () => {
    const outside = timeline();
    outside.stages[0].shots[1].end = 2.1;
    expect(() =>
      parseAnalysisResult("analysis-timeline", outside, 6),
    ).toThrow();
    const before = timeline();
    before.stages[1].shots[0].start = 1.9;
    expect(() => parseAnalysisResult("analysis-timeline", before, 6)).toThrow();
    const gap = timeline();
    gap.stages[0].shots[0].end = 0.8;
    gap.stages[1].start = 3;
    gap.stages[1].shots[0].start = 3;
    expect(parseAnalysisResult("analysis-timeline", gap, 6)).toEqual(gap);
  });

  it("validates bounded evidence per mechanism but allows two mechanisms to cite one scene", () => {
    const value = mechanism();
    value.mechanisms.push({ ...value.mechanisms[0], name: "清晰主体" });
    expect(parseAnalysisResult("analysis-mechanism", value, 6)).toEqual(value);
    value.mechanisms[0].evidence.push({
      start: 1.5,
      end: 3,
      description: "同机制重叠证据",
    });
    expect(() => parseAnalysisResult("analysis-mechanism", value, 6)).toThrow();
    const noEvidence = mechanism();
    noEvidence.mechanisms[0].evidence = [];
    expect(() =>
      parseAnalysisResult("analysis-mechanism", noEvidence, 6),
    ).toThrow();
  });

  it("requires an explanation when there is insufficient evidence for any mechanism", () => {
    const value = mechanism();
    value.mechanisms = [];
    value.strengths = [];
    value.priorityActions = [];
    value.limitations = ["画面过暗，无法支持机制判断。"];
    expect(parseAnalysisResult("analysis-mechanism", value, 6)).toEqual(value);
    value.limitations = [];
    expect(() => parseAnalysisResult("analysis-mechanism", value, 6)).toThrow();
  });

  it("bounds free text, goals and collections rather than accepting arbitrary model payloads", () => {
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        { ...timeline(), summary: " " },
        6,
      ),
    ).toThrow();
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        { ...timeline(), summary: "字".repeat(ANALYSIS_LIMITS.summary + 1) },
        6,
      ),
    ).toThrow();
    expect(() =>
      parseAnalysisResult(
        "analysis-timeline",
        { ...timeline(), stages: [] },
        6,
      ),
    ).toThrow();
    const goals = mechanism();
    goals.mechanisms[0].goals = ["吸引", "吸引"];
    expect(() => parseAnalysisResult("analysis-mechanism", goals, 6)).toThrow();
    const excessive = mechanism();
    excessive.strengths = Array(ANALYSIS_LIMITS.bullets + 1).fill("结构清晰");
    expect(() =>
      parseAnalysisResult("analysis-mechanism", excessive, 6),
    ).toThrow();
  });

  it("enforces aggregate shot and evidence budgets beyond per-parent limits", () => {
    const shot = timeline().stages[0].shots[0];
    const stages = Array.from({ length: 7 }, (_, stageIndex) => ({
      title: `阶段${stageIndex}`,
      start: stageIndex * 40,
      end: (stageIndex + 1) * 40,
      purpose: null,
      content: null,
      shots: Array.from({ length: 40 }, (_, index) => ({
        ...shot,
        start: stageIndex * 40 + index,
        end: stageIndex * 40 + index + 1,
      })),
    }));
    expect(() =>
      parseAnalysisResult("analysis-timeline", { ...timeline(), stages }, 280),
    ).toThrow(/镜头总数/);
    const value = mechanism();
    value.mechanisms = Array.from({ length: 9 }, (_, index) => ({
      ...value.mechanisms[0],
      name: `机制${index}`,
      evidence: Array.from({ length: 16 }, (_, time) => ({
        start: time,
        end: time + 1,
        description: "测试画面证据",
      })),
    }));
    expect(() => parseAnalysisResult("analysis-mechanism", value, 16)).toThrow(
      /证据总数/,
    );
  });

  it("keeps image prompts usable without fabricated video time and bounds the prompt", () => {
    const value = {
      schemaVersion: 2,
      prompt: "生成目标：根据产品图创作。",
      limitations: ["单图无法证明声音或动作。"],
    };
    expect(parseAnalysisResult("ocr-prompt", value, null)).toEqual(value);
    expect(() =>
      parseAnalysisResult(
        "analysis-prompt",
        { prompt: "x".repeat(ANALYSIS_LIMITS.prompt + 1) },
        null,
      ),
    ).toThrow();
    expect(() =>
      parseAnalysisResult(
        "analysis-prompt",
        { prompt: "有效", limitations: [""] },
        null,
      ),
    ).toThrow();
  });

  it("instructs v2 evidence, unknowns and speculative benefits without inventing audio", () => {
    const timelineInstruction = analysisInstruction("analysis-timeline", 6);
    expect(timelineInstruction).toContain('"schemaVersion":2');
    expect(timelineInstruction).toContain("实际视频时长：6 秒");
    expect(timelineInstruction).toContain("无法判断时填 null");
    expect(timelineInstruction).toContain("不得编造声音事实");
    const mechanismInstruction = analysisInstruction("analysis-mechanism", 6);
    expect(mechanismInstruction).toContain("不是已有投放结果、保证或转化承诺");
    expect(mechanismInstruction).toContain("真实时间段证据");
    const promptInstruction = analysisInstruction("ocr-prompt", null);
    for (const part of [
      "生成目标",
      "锚点",
      "逐镜头计划",
      "跨镜头连续性",
      "约束",
    ])
      expect(promptInstruction).toContain(part);
    expect(promptInstruction).toContain("实际视频时长：未知");
    expect(promptInstruction).toContain("明确标注新增建议");
    expect(() => analysisInstruction("analysis-timeline", NaN)).toThrow();
  });
});

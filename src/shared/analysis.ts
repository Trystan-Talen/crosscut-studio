import { z } from "zod";

export const ANALYSIS_LIMITS = {
  summary: 4000,
  shortText: 1000,
  detail: 4000,
  prompt: 24000,
  stages: 24,
  shotsPerStage: 40,
  totalShots: 240,
  mechanisms: 24,
  evidencePerMechanism: 16,
  totalEvidence: 128,
  bullets: 24,
} as const;

export const ANALYSIS_GOALS = ["吸引", "留存", "转化", "互动"] as const;
const shortText = z.string().trim().min(1).max(ANALYSIS_LIMITS.shortText);
const detail = z.string().trim().min(1).max(ANALYSIS_LIMITS.detail);
const summary = z.string().trim().min(1).max(ANALYSIS_LIMITS.summary);
const limitations = z.array(shortText).max(ANALYSIS_LIMITS.bullets).default([]);
const timeFields = {
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
};
type Interval = { start: number; end: number };
type Path = (string | number)[];

function validInterval(value: Interval, ctx: z.RefinementCtx) {
  if (value.start >= value.end)
    ctx.addIssue({
      code: "custom",
      path: ["end"],
      message: "时间段必须满足 start < end。",
    });
}

function orderedIntervals(rows: Interval[], ctx: z.RefinementCtx, path: Path) {
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].start < rows[index - 1].end)
      ctx.addIssue({
        code: "custom",
        path: [...path, index, "start"],
        message: "同一序列的时间段必须按时间排列且不能重叠。",
      });
  }
}

const legacyShotSchema = z
  .object({ ...timeFields, description: detail })
  .strict()
  .superRefine(validInterval);

/** Existing persisted results have no schemaVersion. Their shape stays intact. */
export const timelineV1Schema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    summary,
    timeline: z.array(legacyShotSchema).min(1).max(ANALYSIS_LIMITS.totalShots),
  })
  .strict()
  .superRefine((value, ctx) =>
    orderedIntervals(value.timeline, ctx, ["timeline"]),
  );

export const analysisShotSchema = z
  .object({
    ...timeFields,
    description: detail,
    shotSize: shortText.nullable(),
    angle: shortText.nullable(),
    action: detail.nullable(),
    // Empty text means visibly absent; null means unreadable or not established.
    onScreenText: z.string().trim().max(ANALYSIS_LIMITS.detail).nullable(),
    textTranslation: z.string().trim().max(ANALYSIS_LIMITS.detail).nullable(),
  })
  .strict()
  .superRefine(validInterval);

export const analysisStageSchema = z
  .object({
    title: shortText,
    ...timeFields,
    purpose: detail.nullable(),
    content: detail.nullable(),
    shots: z
      .array(analysisShotSchema)
      .min(1)
      .max(ANALYSIS_LIMITS.shotsPerStage),
  })
  .strict()
  .superRefine((value, ctx) => {
    validInterval(value, ctx);
    orderedIntervals(value.shots, ctx, ["shots"]);
    value.shots.forEach((shot, index) => {
      if (shot.start < value.start || shot.end > value.end)
        ctx.addIssue({
          code: "custom",
          path: ["shots", index],
          message: "镜头时间必须位于所属阶段内。",
        });
    });
  });

export const timelineV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    summary,
    stages: z.array(analysisStageSchema).min(1).max(ANALYSIS_LIMITS.stages),
    limitations,
  })
  .strict()
  .superRefine((value, ctx) => {
    orderedIntervals(value.stages, ctx, ["stages"]);
    if (
      value.stages.reduce((count, stage) => count + stage.shots.length, 0) >
      ANALYSIS_LIMITS.totalShots
    )
      ctx.addIssue({
        code: "custom",
        path: ["stages"],
        message: `镜头总数不能超过 ${ANALYSIS_LIMITS.totalShots}。`,
      });
  });

export const mechanismV1Schema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    summary,
    mechanisms: z
      .array(
        z
          .object({
            name: shortText,
            evidence: detail,
            suggestion: z.string().trim().max(ANALYSIS_LIMITS.detail),
          })
          .strict(),
      )
      .min(1)
      .max(ANALYSIS_LIMITS.mechanisms),
  })
  .strict();

const evidenceSchema = z
  .object({ ...timeFields, description: detail })
  .strict()
  .superRefine(validInterval);

export const analysisMechanismSchema = z
  .object({
    name: shortText,
    summary: detail,
    goals: z
      .array(z.enum(ANALYSIS_GOALS))
      .max(ANALYSIS_GOALS.length)
      .refine(
        (goals) => new Set(goals).size === goals.length,
        "目标不能重复。",
      ),
    evidence: z
      .array(evidenceSchema)
      .min(1)
      .max(ANALYSIS_LIMITS.evidencePerMechanism),
    principle: detail.nullable(),
    problem: detail.nullable(),
    action: detail.nullable(),
    expectedBenefit: detail.nullable(),
  })
  .strict()
  .superRefine((value, ctx) =>
    orderedIntervals(value.evidence, ctx, ["evidence"]),
  );

export const mechanismV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    summary,
    strengths: z.array(detail).max(ANALYSIS_LIMITS.bullets),
    weaknesses: z.array(detail).max(ANALYSIS_LIMITS.bullets),
    priorityActions: z.array(detail).max(ANALYSIS_LIMITS.bullets),
    // Insufficient visual evidence may legitimately produce no mechanisms.
    mechanisms: z
      .array(analysisMechanismSchema)
      .max(ANALYSIS_LIMITS.mechanisms),
    limitations,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.mechanisms.reduce(
        (count, mechanism) => count + mechanism.evidence.length,
        0,
      ) > ANALYSIS_LIMITS.totalEvidence
    )
      ctx.addIssue({
        code: "custom",
        path: ["mechanisms"],
        message: `证据总数不能超过 ${ANALYSIS_LIMITS.totalEvidence}。`,
      });
    if (!value.mechanisms.length && !value.limitations.length)
      ctx.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "无可判断机制时必须说明观察限制。",
      });
  });

export const promptSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    prompt: z.string().trim().min(1).max(ANALYSIS_LIMITS.prompt),
    limitations,
  })
  .strict();

export const timelineSchema = z.union([timelineV2Schema, timelineV1Schema]);
export const mechanismSchema = z.union([mechanismV2Schema, mechanismV1Schema]);
export type AnalysisShot = z.infer<typeof analysisShotSchema>;
export type AnalysisStage = z.infer<typeof analysisStageSchema>;
export type AnalysisMechanism = z.infer<typeof analysisMechanismSchema>;
export type AnalysisTimelineV1 = z.infer<typeof timelineV1Schema>;
export type AnalysisTimelineV2 = z.infer<typeof timelineV2Schema>;
export type AnalysisTimeline = z.infer<typeof timelineSchema>;
export type AnalysisMechanismV1 = z.infer<typeof mechanismV1Schema>;
export type AnalysisMechanismV2 = z.infer<typeof mechanismV2Schema>;
export type AnalysisMechanisms = z.infer<typeof mechanismSchema>;
export type AnalysisPrompt = z.infer<typeof promptSchema>;
export type AnalysisResult =
  | AnalysisTimeline
  | AnalysisMechanisms
  | AnalysisPrompt;
type AnalysisSection = "timeline" | "mechanism" | "prompt";

function sectionFor(toolId: string): AnalysisSection {
  switch (toolId) {
    case "analysis-timeline":
    case "video-understand":
      return "timeline";
    case "analysis-mechanism":
      return "mechanism";
    case "analysis-prompt":
    case "ocr-prompt":
      return "prompt";
    default:
      throw new RangeError(`不支持的分析工具：${toolId}`);
  }
}

function validateDuration(duration: number | null) {
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0))
    throw new RangeError("视频时长必须是有限正数，未知时使用 null。");
}

/** Parse decoded provider JSON; timed results require the actual probed duration. */
export function parseAnalysisResult(
  toolId: string,
  raw: unknown,
  duration: number | null,
): AnalysisResult {
  validateDuration(duration);
  const section = sectionFor(toolId);
  const schema = {
    timeline: timelineSchema,
    mechanism: mechanismSchema,
    prompt: promptSchema,
  }[section];
  return schema
    .superRefine((value, ctx) => {
      const intervals: { value: Interval; path: Path }[] = [];
      if ("timeline" in value)
        value.timeline.forEach((item, index) =>
          intervals.push({ value: item, path: ["timeline", index] }),
        );
      else if ("stages" in value)
        value.stages.forEach((item, index) => {
          intervals.push({ value: item, path: ["stages", index] });
          item.shots.forEach((shot, shotIndex) =>
            intervals.push({
              value: shot,
              path: ["stages", index, "shots", shotIndex],
            }),
          );
        });
      else if ("mechanisms" in value && value.schemaVersion === 2)
        value.mechanisms.forEach((mechanism, index) =>
          mechanism.evidence.forEach((item, evidenceIndex) =>
            intervals.push({
              value: item,
              path: ["mechanisms", index, "evidence", evidenceIndex],
            }),
          ),
        );
      for (const interval of intervals) {
        if (duration === null || interval.value.end > duration)
          ctx.addIssue({
            code: "custom",
            path: [...interval.path, "end"],
            message:
              duration === null
                ? "没有真实视频时长，无法验证时间码。"
                : "时间码不能超过视频实际时长。",
          });
      }
    })
    .parse(raw);
}

export const ANALYSIS_OBSERVATION_INSTRUCTION =
  "只根据附带的真实抽样画面分析。抽样帧不代表完整连续视频，不能证明音轨、台词、背景音乐、真实剪辑节奏或未观察事件；没有音频/转写证据时不得编造声音事实。不要虚构点击、转化、留存或商品效果数据。画面事实与解释/创作建议分开；无法判断的可空字段填 null（表示未知），并在 limitations 说明原因。onScreenText 空字符串只表示可确认未见文字，null 表示不可辨认；textTranslation 同理。所有输出使用指定语言；只输出一个 JSON 对象，不使用 Markdown 代码围栏或添加未声明字段。";

const timeInstruction =
  "时间为有限非负秒数，满足 0 <= start < end <= 实际视频时长；同一序列按时间排列且不重叠，可留空档，不必凑满全片。阶段内所有镜头必须位于该阶段起止时间内。抽样无法精确断定镜头边界时说明估计限制，不伪称精确检测。";

/** Version 2 is requested for new calls; the parser also accepts stored v1 shapes. */
export function analysisInstruction(
  toolId: string,
  duration: number | null,
): string {
  validateDuration(duration);
  const section = sectionFor(toolId);
  const common = `${ANALYSIS_OBSERVATION_INSTRUCTION} 实际视频时长：${duration === null ? "未知" : `${duration} 秒`}。概要最长 ${ANALYSIS_LIMITS.summary} 字符，单项短文本最长 ${ANALYSIS_LIMITS.shortText} 字符，详情最长 ${ANALYSIS_LIMITS.detail} 字符，limitations 最多 ${ANALYSIS_LIMITS.bullets} 项。`;
  if (section === "prompt")
    return `${common} 返回 {"schemaVersion":2,"prompt":"完整生成提示词","limitations":["观察限制"]}。prompt 最长 ${ANALYSIS_LIMITS.prompt} 字符，按生成目标、人物/商品/环境锚点、逐镜头计划、跨镜头连续性、约束五部分组织，可用清晰小标题。生成目标与新镜头计划明确为创作建议，不声称原片已经具有这些内容；逐镜头写画面、动作、构图和必要的连续性，不臆造原片台词或音乐。若建议新增声音，明确标注新增建议。锚点仅引用可见信息或用户明确提供事实，无法判断的身份、品牌、功效不补造。`;
  if (section === "mechanism")
    return `${common} ${timeInstruction} 返回 {"schemaVersion":2,"summary":"概要","strengths":["有画面依据的优势"],"weaknesses":["有依据的局限"],"priorityActions":["优先改进建议"],"mechanisms":[{"name":"机制名称","summary":"机制概要","goals":["吸引"],"evidence":[{"start":0,"end":1,"description":"具体可见画面证据"}],"principle":null,"problem":null,"action":null,"expectedBenefit":null}],"limitations":["观察限制"]}。strengths/weaknesses/priorityActions 各最多 ${ANALYSIS_LIMITS.bullets} 项，没有依据时用空数组。mechanisms 最多 ${ANALYSIS_LIMITS.mechanisms} 项；goals 仅可选 ${ANALYSIS_GOALS.join("、")}，允许空数组但不得重复。每机制必须有 1–${ANALYSIS_LIMITS.evidencePerMechanism} 条真实时间段证据，总证据最多 ${ANALYSIS_LIMITS.totalEvidence} 条；不同机制可引用相同片段。principle/problem/action/expectedBenefit 无法判断时填 null；expectedBenefit 只能表述建议可能带来的改善，明确是推测，不是已有投放结果、保证或转化承诺。无法支持任何机制时 mechanisms 返回空数组，并在 limitations 说明理由。`;
  return `${common} ${timeInstruction} 返回 {"schemaVersion":2,"summary":"视频概述","stages":[{"title":"阶段名称","start":0,"end":1,"purpose":null,"content":"可见阶段内容","shots":[{"start":0,"end":1,"description":"可见画面","shotSize":null,"angle":null,"action":null,"onScreenText":null,"textTranslation":null}]}],"limitations":["观察限制"]}。stages 为 1–${ANALYSIS_LIMITS.stages} 项，每阶段 shots 为 1–${ANALYSIS_LIMITS.shotsPerStage} 项，总镜头最多 ${ANALYSIS_LIMITS.totalShots} 项。purpose 是根据证据推测的阶段目的，content 是可见内容；两者无法判断时填 null。shotSize/angle/action 为景别/视角/动作，无法从抽样判断时填 null。onScreenText 只抄录确实可读的屏幕文字，textTranslation 为其中文释义，不能填入猜测的音轨台词。`;
}

import { z } from "zod";
import { subtitleStyleOptions } from "./subtitle-styles.js";
import type { Field, Tool, ToolInput } from "./types.js";

const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
const text = (
  key: string,
  label: string,
  maxLength = 2000,
  required = true,
): Field => ({ key, label, type: "textarea", maxLength, required });
const single = (
  key: string,
  label: string,
  maxLength = 200,
  required = true,
): Field => ({ key, label, type: "text", maxLength, required });
const select = (
  key: string,
  label: string,
  values: string[],
  value = values[0],
): Field => ({
  key,
  label,
  type: "select",
  options: options(values),
  default: value,
});
const number = (
  key: string,
  label: string,
  min: number,
  max: number,
  value: number,
): Field => ({ key, label, type: "number", min, max, default: value });
const check = (key: string, label: string, value = false): Field => ({
  key,
  label,
  type: "boolean",
  default: value,
});
const assets = (
  key: string,
  label: string,
  kinds: Field["accepts"],
  min = 1,
  max = 1,
  mb = 100,
  seconds?: number,
): Field => ({
  key,
  label,
  type: "assets",
  accepts: kinds,
  required: min > 0,
  min,
  max,
  maxBytes: mb * 1024 * 1024,
  maxDuration: seconds,
  default: [],
  help: `${min ? `至少 ${min} 个，` : ""}最多 ${max} 个；单个 ≤ ${mb} MB${seconds ? `，时长 ≤ ${seconds} 秒` : ""}`,
});
const languages = [
  "英语",
  "中文",
  "日语",
  "韩语",
  "西班牙语",
  "法语",
  "德语",
  "葡萄牙语",
  "印尼语",
  "意大利语",
  "泰语",
  "越南语",
  "阿拉伯语",
  "土耳其语",
  "马来语",
  "俄语",
  "波兰语",
  "荷兰语",
  "菲律宾语",
  "印地语",
  "瑞典语",
  "罗马尼亚语",
];
const lang = () => select("language", "目标语言", languages, "英语");
const ratio = () =>
  select("ratio", "画面比例", [
    "9:16",
    "16:9",
    "1:1",
    "4:3",
    "3:4",
    "2:3",
    "3:2",
    "21:9",
    "auto",
  ]);
const resolution = () =>
  select("resolution", "分辨率", ["480p", "720p", "1080p"], "720p");
const count = (max = 4) => number("count", "生成数量", 1, max, 1);
const videoSettings = (): Field[] => [
  ratio(),
  resolution(),
  number("duration", "时长（秒）", 4, 30, 5),
  select("format", "输出格式", ["mp4", "mov"]),
  check("audio", "原生音频", true),
  count(),
];
const avatar = () => single("avatar", "角色 ID", 300);
const voice = () => single("voice", "音色 ID", 300);
const product = (): Field[] => [
  single("productName", "产品名称", 500),
  text("sellingPoints", "核心卖点", 2000),
  single("audience", "目标人群", 300, false),
  single("scene", "使用场景", 500, false),
];
const subtitleStyle = (allowNone = false): Field => ({
  key: "subtitleStyle",
  label: "字幕风格",
  type: "select",
  default: allowNone ? "none" : "bold",
  options: [
    ...(allowNone ? [{ value: "none", label: "无字幕" }] : []),
    ...subtitleStyleOptions,
  ],
  help: "原创静态字幕预设；字体显示效果随系统字体略有差异。",
});
const tool = (
  id: string,
  title: string,
  description: string,
  category: string,
  icon: string,
  capability: string,
  output: Tool["output"],
  fields: Field[],
  note?: string,
): Tool => ({
  id,
  title,
  description,
  category,
  icon,
  capability,
  output,
  fields,
  note,
});

export const TOOLS: Tool[] = [
  tool(
    "video-studio",
    "视频工作室",
    "从多模态参考或首尾帧开始创作。",
    "视频",
    "Clapperboard",
    "video.task",
    "video",
    [
      select("mode", "创作模式", ["text", "reference", "first-last"], "text"),
      assets("sourceIds", "参考图片 / 首尾帧", ["image"], 0, 10, 5),
      assets("videoIds", "参考视频", ["video"], 0, 3, 50, 60),
      assets("audioIds", "参考音频", ["audio"], 0, 3, 10, 60),
      text("prompt", "创意描述", 2500),
      ...videoSettings(),
    ],
    "服务商及模型能力决定素材、时长与分辨率组合；不支持的组合会明确拒绝。",
  ),
  tool(
    "image-video",
    "图生视频",
    "让产品图拥有镜头和动作。",
    "视频",
    "ImagePlay",
    "video.task",
    "video",
    [
      assets("sourceIds", "首帧 / 尾帧图片", ["image"], 1, 2, 5),
      text("prompt", "创意描述", 2500),
      ...videoSettings(),
    ],
  ),
  tool(
    "text-video",
    "文生视频",
    "把创意描述转为视频。",
    "视频",
    "Video",
    "video.task",
    "video",
    [
      text("prompt", "创意描述", 2500),
      text("negativePrompt", "避免出现的内容", 1000, false),
      ...videoSettings(),
    ],
  ),
  tool(
    "image-generate",
    "AI 生图",
    "生成产品视觉，或基于参考图编辑。",
    "图像",
    "Image",
    "image.generate",
    "image",
    [
      select("mode", "创作模式", ["generate", "edit"]),
      text("prompt", "图像指令", 3000),
      assets("sourceIds", "参考图片", ["image"], 0, 10, 5),
      ratio(),
      select("quality", "生成质量", ["auto", "low", "medium", "high"], "auto"),
      count(3),
    ],
  ),
  tool(
    "link-video",
    "链接生视频",
    "解析产品信息，连接脚本与推广视频。",
    "视频",
    "Link",
    "workflow:link-video",
    "video",
    [
      single("url", "产品链接", 1000),
      text("script", "已确认的广告脚本", 10000, false),
      text("sellingPoints", "重点产品优势", 500, false),
      lang(),
      select("style", "口播风格", [
        "发现新产品",
        "产品卖点",
        "品牌故事",
        "使用教程",
        "解决痛点",
        "行动号召",
        "生活方式",
      ]),
      select("template", "视频模板", [
        "产品卡片",
        "数字人气泡",
        "全屏展示",
        "左右排列",
        "上下排列",
        "Vlog",
      ]),
      single("avatar", "角色 ID", 300, false),
      subtitleStyle(),
      number("duration", "时长（秒）", 15, 60, 30),
      ratio(),
    ],
    "产品信息可先在工作流中解析并手动修正。自动合成需要声明 link-video 能力的工作流服务。",
  ),
  tool(
    "text-avatar",
    "文本生数字人",
    "用口播脚本创建人物讲解视频。",
    "数字人",
    "UserRound",
    "avatar.text",
    "video",
    [
      text("text", "口播文字", 1000),
      lang(),
      avatar(),
      voice(),
      subtitleStyle(true),
      ratio(),
    ],
  ),
  tool(
    "custom-avatar",
    "自定义数字人",
    "将自有形象与口播音频组合。",
    "数字人",
    "UserRoundPen",
    "avatar.photo",
    "video",
    [
      assets("sourceIds", "人物图片", ["image"], 1, 1, 5),
      assets("audioIds", "口播音频", ["audio"], 1, 1, 25, 60),
      text("prompt", "画面描述", 2000, false),
      select("quality", "模式", ["standard", "professional"]),
      ratio(),
    ],
  ),
  tool(
    "product-avatar",
    "手持商品数字人",
    "生成与产品互动的人物口播。",
    "数字人",
    "ShoppingBag",
    "workflow:product-avatar",
    "video",
    [
      assets("sourceIds", "商品图片", ["image"], 1, 1, 5),
      avatar(),
      assets("audioIds", "口播音频", ["audio"], 1, 1, 25, 60),
      text("prompt", "动作与画面描述", 2000, false),
      select("quality", "模式", ["standard", "professional"]),
      ratio(),
    ],
    "商品与人物一致性需要专用工作流能力，普通数字人接口不能替代。",
  ),
  tool(
    "voice-clone",
    "音色克隆",
    "用已获授权的声音生成配音。",
    "音频",
    "AudioLines",
    "voice.clone",
    "audio",
    [
      assets("sourceIds", "参考音频 / 视频", ["audio", "video"], 1, 1, 10),
      text("text", "配音文本", 2000),
      lang(),
      check("denoise", "去除背景杂音"),
      check("consent", "我拥有该声音的使用授权"),
    ],
    "仅提交有权使用的声音；服务商可能要求额外身份验证。",
  ),
  tool(
    "tiktok-avatar",
    "TikTok 风格数字人",
    "适配短视频口播的角色、节奏与声音。",
    "数字人",
    "UserRoundCheck",
    "avatar.text",
    "video",
    [
      text("text", "口播文案", 3000),
      lang(),
      avatar(),
      voice(),
      number("volume", "音量（%）", 10, 100, 100),
      number("speed", "语速", 0.7, 1.2, 1.1),
      ratio(),
    ],
  ),
  tool(
    "video-translate",
    "视频翻译",
    "翻译口播，配置字幕与口型同步。",
    "音频",
    "Languages",
    "video.translate",
    "video",
    [
      assets("sourceIds", "原始视频", ["video"], 1, 1, 100, 120),
      lang(),
      single("voice", "音色 ID（可选）", 300, false),
      check("subtitles", "显示字幕", true),
      check("lipSync", "口型同步", true),
    ],
    "字幕、原音色和替换音色能力取决于已配置服务，不支持的选项不会被静默忽略。",
  ),
  tool(
    "tts",
    "AI 配音",
    "把旁白文字转成真实音频。",
    "音频",
    "Mic",
    "speech",
    "audio",
    [
      text("text", "旁白文字", 2000),
      voice(),
      number("speed", "语速", 0.25, 4, 1),
      lang(),
    ],
    "配音按输入原文朗读；选择目标语言不会自动翻译。请先准备该语言的文案，音色与模型需支持该语言。",
  ),
  tool(
    "remix",
    "批量混剪",
    "本地组合镜头，批量导出广告素材。",
    "后期",
    "Scissors",
    "local",
    "video",
    [
      assets("sourceIds", "视频素材", ["video"], 6, 100, 100, 120),
      single("productName", "产品名称", 500),
      text("description", "产品描述", 500),
      text("sellingPoints", "产品卖点", 1000),
      lang(),
      {
        ...select(
          "duration",
          "视频时长",
          ["recommended", "15", "30"],
          "recommended",
        ),
        options: [
          { value: "recommended", label: "推荐时长（30 秒）" },
          { value: "15", label: "15 秒" },
          { value: "30", label: "30 秒" },
        ],
        help: "本产品的推荐规则固定为 30 秒；不根据素材推断最佳投放时长。",
      },
      ratio(),
      resolution(),
      count(100),
      check("subtitles", "显示卖点字幕", true),
      subtitleStyle(),
    ],
    "本地 FFmpeg 真实混剪。字幕使用你填写的原文；选择目标语言不会自动翻译文字。每次最多100条，顺序排队。",
  ),
  tool(
    "subtitle-remove",
    "字幕擦除",
    "选择字幕区域遮挡，或接入智能修复。",
    "后期",
    "Eraser",
    "local",
    "video",
    [
      assets("sourceIds", "原始视频", ["video"], 1, 1, 50),
      select("mode", "处理方式", ["cover", "crop", "inpaint"], "cover"),
      select(
        "resolution",
        "输出分辨率",
        ["480p", "720p", "1080p", "auto"],
        "auto",
      ),
      number("regionY", "字幕区域顶部（画面%）", 0, 95, 80),
      number("regionHeight", "字幕区域高度（画面%）", 1, 100, 20),
    ],
    "本地遮挡/裁切会改变画面，自适应输出短边最多1080像素；无痕智能修复需专用服务。",
  ),
  tool(
    "video-understand",
    "视频理解",
    "从真实视频帧提取结构与创意。",
    "洞察",
    "ScanEye",
    "video.analysis",
    "analysis",
    [
      assets("sourceIds", "原始视频", ["video"], 1, 1, 50, 90),
      select("industry", "分析场景", ["通用", "电商", "游戏"]),
      lang(),
    ],
  ),
  tool(
    "ad-script",
    "广告脚本",
    "将产品信息组织成分镜和口播。",
    "洞察",
    "FileText",
    "chat",
    "document",
    [
      ...product(),
      single("price", "商品价格", 30, false),
      select(
        "currency",
        "价格币种",
        ["USD", "CNY", "EUR", "GBP", "JPY", "KRW", "AUD", "CAD"],
        "USD",
      ),
      lang(),
      select("creativeOrientation", "创作取向", ["TikTok", "通用"], "TikTok"),
      select("style", "脚本风格", [
        "行业秘密",
        "打破常识",
        "痛点提问",
        "故事叙述",
        "直接卖货",
        "传达益处",
        "科普教育",
      ]),
      number("duration", "目标时长（秒）", 5, 120, 30),
    ],
  ),
  tool(
    "audio-avatar",
    "音频生数字人",
    "选择角色，用音频驱动口播。",
    "数字人",
    "ContactRound",
    "avatar.audio",
    "video",
    [assets("sourceIds", "原始音频", ["audio"], 1, 1, 5), avatar(), ratio()],
  ),
  tool(
    "subtitles",
    "AI 字幕",
    "识别音视频并输出带时间码的字幕。",
    "音频",
    "Captions",
    "transcription",
    "subtitle",
    [
      assets("sourceIds", "音视频素材", ["video", "audio"], 1, 1, 100, 600),
      select("language", "识别语言", ["自动", ...languages], "自动"),
      {
        key: "targetLanguage",
        label: "字幕翻译语言",
        type: "select",
        default: "original",
        options: [
          { value: "original", label: "保留原语" },
          ...options(languages),
        ],
        help: "翻译需同一服务同时配置转写和文字模型；保留原始时间码。",
      },
    ],
    "先获得真实时间戳，再按所选语言翻译字幕文字；翻译需额外文字模型，仅保留原语时不调用翻译。",
  ),
  tool(
    "replication",
    "爆款复刻",
    "参考镜头结构，创作你的产品广告。",
    "视频",
    "CopyPlus",
    "workflow:replication",
    "video",
    [
      assets("sourceIds", "参考视频", ["video"], 1, 1, 50),
      assets("imageIds", "产品图片", ["image"], 0, 5, 5),
      ...product(),
      text("direction", "自定义优化方向", 600, false),
      lang(),
      select("region", "目标地区", [
        "美国",
        "中国",
        "日本",
        "韩国",
        "东南亚",
        "欧洲",
        "拉美",
        "中东",
      ]),
      select("subtitleMode", "字幕策略", ["follow", "on", "off"], "follow"),
      ratio(),
      resolution(),
      {
        key: "durationMode",
        label: "时长策略",
        type: "select",
        default: "custom",
        options: [
          { value: "custom", label: "自定义时长" },
          { value: "follow", label: "跟随参考视频" },
        ],
        help: "跟随模式使用参考视频的真实探测时长；当前支持4–60秒，超限需先裁切。",
      },
      number("duration", "时长（秒）", 4, 60, 15),
      check("audio", "原生音频", true),
    ],
  ),
  tool(
    "transcode",
    "转码与适配",
    "调整画幅、分辨率和输出格式。",
    "后期",
    "MonitorPlay",
    "local",
    "video",
    [
      assets("sourceIds", "视频", ["video"], 1, 1, 250),
      ratio(),
      resolution(),
      select("format", "输出格式", ["mp4", "mov"]),
      number("volume", "音量（%）", 0, 200, 100),
    ],
  ),
  tool(
    "trim",
    "视频裁切",
    "按时间范围截取需要的片段。",
    "后期",
    "Crop",
    "local",
    "video",
    [
      assets("sourceIds", "视频", ["video"], 1, 1, 250),
      number("start", "开始时间（秒）", 0, 36000, 0),
      number("end", "结束时间（秒）", 0.1, 36000, 5),
      ratio(),
      resolution(),
    ],
  ),
  tool(
    "slideshow",
    "产品图成片",
    "本地将产品图组合为可下载视频。",
    "后期",
    "GalleryVerticalEnd",
    "local",
    "video",
    [
      assets("sourceIds", "产品图片", ["image"], 1, 30, 10),
      number("duration", "总时长（秒）", 3, 120, 15),
      ratio(),
      resolution(),
      text("subtitleText", "字幕文案", 2000, false),
      subtitleStyle(),
    ],
  ),
  tool(
    "subtitle-burn",
    "字幕编辑与烧录",
    "将编辑后的字幕写入真实视频。",
    "后期",
    "Subtitles",
    "local",
    "video",
    [
      assets("sourceIds", "原始视频", ["video"], 1, 1, 250),
      assets("subtitleIds", "SRT 字幕文件", ["subtitle"], 0, 1, 2),
      text("subtitleText", "SRT内容或全片字幕", 20000, false),
      select(
        "resolution",
        "输出分辨率",
        ["480p", "720p", "1080p", "auto"],
        "auto",
      ),
      subtitleStyle(),
    ],
    "自适应输出尽量保留源尺寸，短边上限1080像素。",
  ),
  tool(
    "scene-detect",
    "技术分镜检测",
    "本地检测镜头变化与媒体参数。",
    "洞察",
    "Split",
    "local",
    "analysis",
    [assets("sourceIds", "视频", ["video"], 1, 1, 100, 180)],
    "基于真实画面变化的技术检测，不包含语义、转化效果或商业结论。",
  ),
  tool(
    "prompt-optimize",
    "提示词优化",
    "保留意图，补足镜头和动作描述。",
    "洞察",
    "WandSparkles",
    "chat",
    "document",
    [text("prompt", "原始提示词", 5000), lang()],
  ),
  tool(
    "ocr-prompt",
    "图片提取描述",
    "观察产品图，提取可编辑创作描述。",
    "洞察",
    "ScanText",
    "video.analysis",
    "document",
    [assets("sourceIds", "参考图片", ["image"], 1, 1, 5), lang()],
  ),
  tool(
    "agent-chat",
    "创意对话",
    "讨论产品、脚本与创作方案。",
    "内部",
    "MessagesSquare",
    "chat",
    "document",
    [text("text", "消息", 10000)],
  ),
  ...["timeline", "mechanism", "prompt"].map((section) =>
    tool(
      `analysis-${section}`,
      {
        timeline: "分镜时间轴",
        mechanism: "创意机制诊断",
        prompt: "反推提示词",
      }[section] ?? section,
      "从实际视频内容生成分析。",
      "内部",
      "ScanEye",
      "video.analysis",
      "analysis",
      [assets("sourceIds", "原始视频", ["video"], 1, 1, 50, 90)],
    ),
  ),
];

export function findTool(id: string): Tool {
  const value = TOOLS.find((t) => t.id === id);
  if (!value) throw new Error("未知工具");
  return value;
}
export function requiredCapability(toolId: string, input: ToolInput): string {
  if (
    toolId === "image-generate" &&
    (input.mode === "edit" ||
      (Array.isArray(input.sourceIds) && input.sourceIds.length > 0))
  )
    return "image.edit";
  if (toolId === "subtitle-remove" && input.mode === "inpaint")
    return "workflow:subtitle-remove";
  return findTool(toolId).capability;
}
export function defaultsFor(tool: Tool): ToolInput {
  return Object.fromEntries(
    tool.fields
      .filter((f) => f.default !== undefined)
      .map((f) => [f.key, structuredClone(f.default!)]),
  );
}
export function validateInput(toolId: string, raw: unknown): ToolInput {
  const tool = findTool(toolId);
  const shape: Record<string, z.ZodType> = {};
  for (const f of tool.fields) {
    let schema: z.ZodType;
    if (f.type === "boolean") schema = z.boolean();
    else if (f.type === "number")
      schema = z
        .number()
        .finite()
        .min(f.min ?? -Infinity)
        .max(f.max ?? Infinity);
    else if (f.type === "assets")
      schema = z
        .array(z.string().uuid())
        .min(f.min ?? 0)
        .max(f.max ?? 100)
        .refine((a) => new Set(a).size === a.length, "不可重复选择同一素材");
    else if (f.type === "select")
      schema = z.enum(
        (f.options ?? []).map((o) => o.value) as [string, ...string[]],
      );
    else
      schema = z
        .string()
        .trim()
        .min(f.required ? 1 : 0, `${f.label}不能为空`)
        .max(f.maxLength ?? 2000);
    shape[f.key] =
      f.default !== undefined
        ? schema.default(f.default)
        : f.required
          ? schema
          : schema.optional();
  }
  const input = z.object(shape).strict().parse(raw) as ToolInput;
  if (toolId === "voice-clone" && input.consent !== true)
    throw new Error("使用声音克隆前必须确认拥有使用授权");
  if (toolId === "trim" && Number(input.end) <= Number(input.start))
    throw new Error("结束时间必须晚于开始时间");
  if (
    toolId === "ad-script" &&
    input.price &&
    !/^\d+(\.\d{1,4})?$/.test(String(input.price))
  )
    throw new Error("商品价格必须是非负数字");
  if (
    toolId === "subtitle-burn" &&
    !input.subtitleText &&
    !(input.subtitleIds as string[] | undefined)?.length
  )
    throw new Error("请提供SRT文件或字幕文本");
  if (
    toolId === "image-generate" &&
    input.mode === "edit" &&
    !(input.sourceIds as string[] | undefined)?.length
  )
    throw new Error("图像编辑需要参考图片");
  if (
    toolId === "video-studio" &&
    input.mode === "first-last" &&
    !(input.sourceIds as string[] | undefined)?.length
  )
    throw new Error("首尾帧模式至少需要首帧图片");
  return input;
}
export function selectedAssetIds(input: ToolInput): string[] {
  return [
    ...new Set(
      Object.entries(input)
        .filter(([key, value]) => key.endsWith("Ids") && Array.isArray(value))
        .flatMap(([, value]) => value as string[]),
    ),
  ];
}

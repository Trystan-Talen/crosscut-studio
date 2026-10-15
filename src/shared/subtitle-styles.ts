/** Original static subtitle designs. No preset promises word-tracking or animation. */
export interface SubtitleRenderStyle {
  color: string;
  background: string;
  backgroundOpacity: number;
  fontFamily: string;
  weight: 400 | 500 | 600 | 700 | 800 | 900;
  italic: boolean;
  sizeRatio: number;
  position: "top" | "center" | "bottom";
  align: "left" | "center" | "right";
  paddingRatio: number;
  radiusRatio: number;
  borderColor: string;
  borderRatio: number;
  outlineColor: string;
  outlineRatio: number;
  shadowColor: string;
  shadowRatio: number;
}
export interface SubtitleStyle {
  id: string;
  label: string;
  render: SubtitleRenderStyle;
  cssPreview: Record<string, string | number>;
}
const base: SubtitleRenderStyle = {
  color: "#FFFFFF",
  background: "#000000",
  backgroundOpacity: 0.74,
  fontFamily: "Arial Unicode MS",
  weight: 700,
  italic: false,
  sizeRatio: 0.04,
  position: "bottom",
  align: "center",
  paddingRatio: 0.35,
  radiusRatio: 0.12,
  borderColor: "#FFFFFF",
  borderRatio: 0,
  outlineColor: "#000000",
  outlineRatio: 0,
  shadowColor: "#000000",
  shadowRatio: 0,
};
function rgba(color: string, opacity: number): string {
  const channels = [1, 3, 5].map((start) =>
    Number.parseInt(color.slice(start, start + 2), 16),
  );
  return `rgba(${channels.join(",")},${opacity})`;
}
function preset(
  id: string,
  label: string,
  changes: Partial<SubtitleRenderStyle>,
): SubtitleStyle {
  const render = { ...base, ...changes };
  const outline = render.outlineRatio;
  const shadows = outline
    ? [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ].map(
        ([x, y]) =>
          `${x! * outline}em ${y! * outline}em 0 ${render.outlineColor}`,
      )
    : [];
  if (render.shadowRatio)
    shadows.push(
      `${render.shadowRatio}em ${render.shadowRatio}em ${render.shadowRatio * 1.4}em ${render.shadowColor}`,
    );
  return {
    id,
    label,
    render,
    cssPreview: {
      color: render.color,
      backgroundColor: rgba(render.background, render.backgroundOpacity),
      fontFamily: `"${render.fontFamily}", sans-serif`,
      fontWeight: render.weight,
      fontStyle: render.italic ? "italic" : "normal",
      fontSize: `${render.sizeRatio / base.sizeRatio}em`,
      textAlign: render.align,
      padding: `${render.paddingRatio}em`,
      borderRadius: `${render.radiusRatio}em`,
      border: render.borderRatio
        ? `${render.borderRatio}em solid ${render.borderColor}`
        : "none",
      textShadow: shadows.join(",") || "none",
      lineHeight: 1.25,
    },
  };
}

export const SUBTITLE_STYLES: readonly SubtitleStyle[] = [
  preset("minimal", "轻简白字", {
    weight: 400,
    sizeRatio: 0.028,
    backgroundOpacity: 0.35,
  }),
  preset("bold", "经典醒目", {}),
  preset("contrast", "高对比黄字", {
    color: "#FFE66D",
    backgroundOpacity: 0.95,
  }),
  preset("paper-ink", "纸白墨字", {
    color: "#17211D",
    background: "#FAF6E9",
    backgroundOpacity: 0.98,
    weight: 600,
  }),
  preset("signal-red", "红色信号", {
    background: "#BC2538",
    backgroundOpacity: 0.96,
    weight: 800,
    radiusRatio: 0.05,
  }),
  preset("ocean-blue", "海蓝字幕", {
    background: "#1255A0",
    backgroundOpacity: 0.94,
    weight: 600,
    radiusRatio: 0.3,
  }),
  preset("mint-label", "薄荷标签", {
    color: "#123F35",
    background: "#BDEED9",
    backgroundOpacity: 1,
    weight: 700,
    radiusRatio: 0.5,
  }),
  preset("violet-band", "紫色横带", {
    background: "#513782",
    backgroundOpacity: 0.94,
    sizeRatio: 0.038,
    radiusRatio: 0,
  }),
  preset("amber-tag", "琥珀短签", {
    color: "#442904",
    background: "#F5C451",
    backgroundOpacity: 1,
    paddingRatio: 0.5,
    radiusRatio: 0.2,
  }),
  preset("rose-caption", "柔玫瑰", {
    color: "#592036",
    background: "#FFDCE5",
    backgroundOpacity: 0.96,
    weight: 500,
    italic: true,
  }),
  preset("slate-compact", "石墨小字", {
    color: "#E4EDF4",
    background: "#26323E",
    backgroundOpacity: 0.9,
    sizeRatio: 0.03,
    weight: 400,
    paddingRatio: 0.25,
  }),
  preset("glass-dark", "暗色玻璃", {
    background: "#152128",
    backgroundOpacity: 0.45,
    borderColor: "#B6CBCB",
    borderRatio: 0.04,
    radiusRatio: 0.45,
    weight: 500,
  }),
  preset("glass-light", "亮色玻璃", {
    color: "#203C39",
    background: "#FFFFFF",
    backgroundOpacity: 0.78,
    borderColor: "#FFFFFF",
    borderRatio: 0.07,
    radiusRatio: 0.45,
  }),
  preset("headline-top", "顶部大标题", {
    position: "top",
    sizeRatio: 0.055,
    weight: 900,
    backgroundOpacity: 0.92,
    radiusRatio: 0,
  }),
  preset("editorial-top", "编辑手记", {
    position: "top",
    color: "#352E25",
    background: "#F4EDD9",
    backgroundOpacity: 0.96,
    fontFamily: "Georgia",
    weight: 400,
    italic: true,
    sizeRatio: 0.045,
  }),
  preset("quiet-serif", "安静衬线", {
    fontFamily: "Georgia",
    italic: true,
    weight: 400,
    sizeRatio: 0.034,
    backgroundOpacity: 0.55,
  }),
  preset("neon-lime", "青柠边框", {
    color: "#D1FF64",
    background: "#172317",
    backgroundOpacity: 0.95,
    borderColor: "#D1FF64",
    borderRatio: 0.07,
    radiusRatio: 0.18,
  }),
  preset("electric-blue", "电光蓝框", {
    color: "#91E8FF",
    background: "#0E213A",
    backgroundOpacity: 0.93,
    borderColor: "#38A8E2",
    borderRatio: 0.1,
    weight: 800,
  }),
  preset("outline-white", "纯白描边", {
    backgroundOpacity: 0,
    outlineRatio: 0.07,
    sizeRatio: 0.043,
    weight: 800,
  }),
  preset("outline-yellow", "金黄描边", {
    color: "#FFDF4B",
    backgroundOpacity: 0,
    outlineRatio: 0.09,
    outlineColor: "#302013",
    weight: 900,
    sizeRatio: 0.047,
  }),
  preset("shadow-white", "白字投影", {
    backgroundOpacity: 0,
    shadowRatio: 0.1,
    sizeRatio: 0.043,
    weight: 700,
  }),
  preset("shadow-coral", "珊瑚投影", {
    color: "#FF947F",
    backgroundOpacity: 0,
    shadowColor: "#321527",
    shadowRatio: 0.12,
    weight: 800,
    sizeRatio: 0.046,
  }),
  preset("box-white", "白色线框", {
    color: "#151B20",
    background: "#FFFFFF",
    backgroundOpacity: 1,
    borderColor: "#151B20",
    borderRatio: 0.07,
    radiusRatio: 0,
    paddingRatio: 0.48,
  }),
  preset("box-dark", "黑色线框", {
    background: "#151B20",
    backgroundOpacity: 1,
    borderColor: "#FFFFFF",
    borderRatio: 0.055,
    radiusRatio: 0,
    paddingRatio: 0.48,
  }),
  preset("left-note", "左侧旁注", {
    align: "left",
    background: "#174252",
    backgroundOpacity: 0.9,
    sizeRatio: 0.035,
    weight: 500,
    radiusRatio: 0,
  }),
  preset("right-note", "右侧旁注", {
    align: "right",
    background: "#5E2B55",
    backgroundOpacity: 0.9,
    sizeRatio: 0.035,
    weight: 500,
    radiusRatio: 0,
  }),
  preset("center-title", "居中主标题", {
    position: "center",
    sizeRatio: 0.064,
    weight: 900,
    backgroundOpacity: 0.85,
    paddingRatio: 0.5,
    radiusRatio: 0,
  }),
  preset("center-lime", "居中青柠", {
    position: "center",
    color: "#1E2D12",
    background: "#D1F38E",
    backgroundOpacity: 1,
    sizeRatio: 0.058,
    weight: 800,
    radiusRatio: 0.4,
  }),
  preset("top-badge", "顶部圆角签", {
    position: "top",
    background: "#1D6456",
    backgroundOpacity: 0.96,
    sizeRatio: 0.032,
    weight: 600,
    radiusRatio: 0.9,
    paddingRatio: 0.6,
  }),
  preset("news-band", "资讯下栏", {
    align: "left",
    background: "#0C2547",
    backgroundOpacity: 1,
    borderColor: "#50B5ED",
    borderRatio: 0.09,
    radiusRatio: 0,
    sizeRatio: 0.038,
  }),
  preset("serif-paper", "书页衬线", {
    fontFamily: "Georgia",
    color: "#302D29",
    background: "#EDE7DB",
    backgroundOpacity: 0.97,
    weight: 400,
    sizeRatio: 0.038,
    borderColor: "#988E7C",
    borderRatio: 0.04,
    radiusRatio: 0,
  }),
  preset("mono-label", "等宽标记", {
    fontFamily: "Menlo",
    color: "#C2F1DD",
    background: "#1A312B",
    backgroundOpacity: 0.96,
    weight: 500,
    sizeRatio: 0.031,
    radiusRatio: 0,
    paddingRatio: 0.5,
  }),
  preset("punch-red", "红字强调", {
    color: "#B92130",
    background: "#FFF4EB",
    backgroundOpacity: 0.98,
    sizeRatio: 0.052,
    weight: 900,
    borderColor: "#B92130",
    borderRatio: 0.08,
    radiusRatio: 0.1,
  }),
];

export const subtitleStyleOptions = SUBTITLE_STYLES.map(({ id, label }) => ({
  value: id,
  label,
}));
export function getSubtitleStyle(id: string): SubtitleStyle | undefined {
  return SUBTITLE_STYLES.find((style) => style.id === id);
}

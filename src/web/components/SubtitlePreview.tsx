import type { CSSProperties } from "react";
import { getSubtitleStyle } from "../../shared/subtitle-styles";

export function SubtitlePreview({
  styleId,
  text,
}: {
  styleId: string;
  text?: string;
}) {
  if (styleId === "none") return null;
  const preset = getSubtitleStyle(styleId);
  if (!preset) return null;
  const lines = (text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(
      (line) =>
        line.trim() && !/^\d+$/.test(line.trim()) && !line.includes("-->"),
    )
    .slice(0, 2)
    .join("\n")
    .slice(0, 80);
  const positions = { top: "flex-start", center: "center", bottom: "flex-end" };
  const alignment = { left: "flex-start", center: "center", right: "flex-end" };
  return (
    <figure className="subtitle-preview">
      <div
        className="subtitle-preview-frame"
        style={{
          justifyContent: positions[preset.render.position],
          alignItems: alignment[preset.render.align],
        }}
      >
        <span style={preset.cssPreview as CSSProperties}>
          {lines || "每一帧，都有新的可能"}
        </span>
      </div>
      <figcaption>
        <strong>{preset.label}</strong>
        <span>静态样式预览 · 最终字号和换行随成片尺寸调整</span>
      </figcaption>
    </figure>
  );
}

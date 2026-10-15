import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolField, providerOptions } from "../src/web/components/ToolField";
import type { Field, ProviderPublic } from "../src/shared/types";

const provider: ProviderPublic = {
  id: "p",
  name: "我的声音服务",
  kind: "elevenlabs",
  baseUrl: "https://example.com",
  model: "eleven_multilingual_v2",
  models: {},
  capabilities: ["speech"],
  configured: true,
  status: "configured_unverified",
  voices: [{ id: "owned-voice", name: "已登记声音" }],
  avatars: [],
  updatedAt: "2026-10-14",
};
const change = () => {};

describe("provider-aware input controls", () => {
  it("limits voice options to the chosen provider and requires registration when empty", () => {
    expect(
      providerOptions(provider, "voice").map((item) => item.value),
    ).toEqual(["owned-voice"]);
    const html = renderToStaticMarkup(
      <ToolField
        field={{ key: "voice", label: "声音", type: "text", required: true }}
        provider={{ ...provider, voices: [] }}
        value=""
        onChange={change}
      />,
    );
    expect(html).toContain("请先在设置中登记此服务的目录");
    expect(html).toContain("disabled");
    expect(html).not.toContain("<input");
  });
  it("keeps an invalid saved ratio visible while offering only allowed replacements", () => {
    const field: Field = {
      key: "ratio",
      label: "画幅",
      type: "select",
      options: [
        { value: "2:3", label: "2:3" },
        { value: "9:16", label: "9:16" },
      ],
    };
    const html = renderToStaticMarkup(
      <ToolField
        field={field}
        value="2:3"
        limit={{ choices: ["9:16"] }}
        onChange={change}
      />,
    );
    expect(html).toContain('value="2:3" disabled="" selected=""');
    expect(html).toContain('value="9:16"');
    expect(html).toContain("已保留原值");
  });
  it("preserves out-of-range speed and shows an explicit correction for a fixed-speed profile", () => {
    const html = renderToStaticMarkup(
      <ToolField
        field={{
          key: "speed",
          label: "语速",
          type: "number",
          min: 0.25,
          max: 4,
          default: 1,
        }}
        value={1.2}
        limit={{ min: 1, max: 1, disabled: true }}
        onChange={change}
      />,
    );
    expect(html).toContain('value="1.2"');
    expect(html).toContain('min="1" max="1"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("使用允许的默认值");
  });
  it("does not silently discard reference assets when a mode stops accepting them", () => {
    const html = renderToStaticMarkup(
      <ToolField
        field={{
          key: "videoIds",
          label: "参考视频",
          type: "assets",
          accepts: ["video"],
        }}
        value={["asset-one", "asset-two"]}
        limit={{
          visible: false,
          disabled: true,
          max: 0,
          reason: "此模式暂不支持视频参考",
        }}
        onChange={change}
      />,
    );
    expect(html).toContain("2 份素材");
    expect(html).toContain("清除此项已保存内容");
    expect(html).not.toContain("asset-one");
  });
  it("uses native numeric bounds without changing the user's duration", () => {
    const html = renderToStaticMarkup(
      <ToolField
        field={{
          key: "duration",
          label: "时长",
          type: "number",
          min: 4,
          max: 60,
        }}
        value={20}
        limit={{ min: 4, max: 15, integer: true }}
        onChange={change}
      />,
    );
    expect(html).toContain('max="15" step="1"');
    expect(html).toContain('value="20"');
    expect(html).toContain("已保留原值");
  });
});

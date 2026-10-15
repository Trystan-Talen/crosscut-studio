import { describe, expect, it } from "vitest";
import { directoryView } from "../src/web/components/ProviderDirectoryField";

const items = [
  {
    value: "en-female-a",
    label: "Claire",
    language: "English",
    gender: "female",
    scene: "室内",
  },
  {
    value: "zh-male-b",
    label: "林先生",
    language: "中文",
    gender: "male",
    scene: "工作室",
  },
  {
    value: "zh-female-c",
    label: "小林",
    language: "中文",
    gender: "female",
    scene: "室内",
  },
];
const empty = { search: "", language: "", gender: "", scene: "" };

describe("provider directory filtering", () => {
  it("searches names and IDs case-insensitively", () => {
    expect(
      directoryView(items, { ...empty, search: "CLAIRE" }, "").matches.map(
        (item) => item.value,
      ),
    ).toEqual(["en-female-a"]);
    expect(
      directoryView(items, { ...empty, search: "  ZH-MALE  " }, "").matches.map(
        (item) => item.value,
      ),
    ).toEqual(["zh-male-b"]);
  });
  it("combines voice language and gender filters", () => {
    expect(
      directoryView(
        items,
        { ...empty, language: "中文", gender: "female" },
        "",
      ).matches.map((item) => item.value),
    ).toEqual(["zh-female-c"]);
  });
  it("combines avatar scene and gender filters without inventing metadata", () => {
    expect(
      directoryView(items, { ...empty, scene: "室内", gender: "female" }, "")
        .matches,
    ).toHaveLength(2);
    expect(
      directoryView(
        [{ value: "unlabeled", label: "未标注角色" }],
        { ...empty, scene: "室内" },
        "",
      ).matches,
    ).toHaveLength(0);
  });
  it("keeps the current selection separate when it no longer matches the filters", () => {
    const result = directoryView(
      items,
      { ...empty, language: "中文" },
      "en-female-a",
    );
    expect(result.matches.map((item) => item.value)).not.toContain(
      "en-female-a",
    );
    expect(result.preserved?.value).toBe("en-female-a");
    expect(
      directoryView(items, empty, "en-female-a").preserved,
    ).toBeUndefined();
  });
  it("does not manufacture an unknown or different provider's selection", () => {
    expect(
      directoryView(items, empty, "other-provider-voice").preserved,
    ).toBeUndefined();
    expect(directoryView([], empty, "en-female-a").matches).toHaveLength(0);
  });
});

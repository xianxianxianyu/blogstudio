import { describe, expect, it } from "vitest";
import { outlineOf } from "./outline";

describe("大纲", () => {
  it("从正文现算，带层级与行号", () => {
    const outline = outlineOf("# 一\n\n正文\n\n## 一之一\n\n# 二");

    expect(outline.map((one) => [one.level, one.title, one.line])).toEqual([
      [1, "一", 1],
      [2, "一之一", 5],
      [1, "二", 7],
    ]);
  });

  it("**一节管到下一个同级或更高级的标题**——有子节的章，内容在子节里", () => {
    const outline = outlineOf("# 一\n\n## 一之一\n\n正文\n\n# 二");

    expect(outline[0].until).toBe(7);
    expect(outline[1].until).toBe(7);
  });

  it("最后一节管到文末", () => {
    expect(outlineOf("# 一\n\n正文").at(-1)?.until).toBe(4);
  });

  it("**代码块里的 `#` 不是标题**——一段 shell 脚本能凭空长出十个章节", () => {
    const markdown = "# 真标题\n\n```sh\n# 这是注释\n# 这也是\n```\n\n正文";

    expect(outlineOf(markdown).map((one) => one.title)).toEqual(["真标题"]);
  });

  it("按出现顺序编号——点大纲跳过去时按这个数", () => {
    expect(outlineOf("# 一\n## 二\n### 三").map((one) => one.index)).toEqual([0, 1, 2]);
  });

  it("没有标题就是空的", () => {
    expect(outlineOf("光有正文，一个标题都没有")).toEqual([]);
  });
});

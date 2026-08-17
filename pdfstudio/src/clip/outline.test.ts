import { describe, expect, it } from "vitest";
import { groupClipsBySection, type Section } from "./outline";
import type { Clip } from "./clip";
import type { Screenshot } from "../recognizer/recognizer";

const PIXELS: Screenshot = { mime: "image/png", bytes: new Uint8Array([1]), width: 4, height: 4 };

/** 摘录只需要页码与页内位置，其余字段撑起类型即可。 */
function clip(id: string, page: number, top: number): Clip {
  return {
    id,
    state: "ready",
    region: { page, rect: { x: 54, y: top - 12, width: 232, height: 12 }, pixels: PIXELS },
    content: null,
    sourceText: null,
    translation: null,
    note: null,
    label: "dot",
    important: false,
    tagId: null,
    lastViewedAt: 0,
  };
}

/**
 * 照 Attention 的真实目录造（`.scratch/probe-outline.mts` 量的）：**p.2 上挤了三项**，
 * 这正是「只按页码归组」会翻车的地方。
 */
const ATTENTION: Section[] = [
  { title: "Introduction", page: 2, y: 720, level: 0, path: [] },
  { title: "Background", page: 2, y: 436.994, level: 0, path: [] },
  { title: "Model Architecture", page: 2, y: 157.59, level: 0, path: [] },
  { title: "Encoder and Decoder Stacks", page: 3, y: 315.594, level: 1, path: ["Model Architecture"] },
  { title: "Attention", page: 3, y: 117.119, level: 1, path: ["Model Architecture"] },
];

const titles = (groups: { section: Section | null }[]) =>
  groups.map((group) => group.section?.title ?? "（目录之前）");

describe("按目录组织摘录", () => {
  it("同一页上的三个小节按页内位置分开——只按页码会全堆到一处", () => {
    const groups = groupClipsBySection(
      [clip("a", 2, 700), clip("b", 2, 300), clip("c", 2, 100)],
      ATTENTION,
    );

    expect(titles(groups)).toEqual(["Introduction", "Background", "Model Architecture"]);
    expect(groups.map((group) => group.clips.map((c) => c.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("紧贴标题下面的摘录归给那个标题，不是上一节", () => {
    // y 比标题小 = 在标题下面（PDF 原点在左下）。差一点点也算下面。
    const groups = groupClipsBySection([clip("a", 2, 436.9)], ATTENTION);

    expect(titles(groups)).toEqual(["Background"]);
  });

  it("目录第一项之前的摘录单独一组，排在最前", () => {
    // 标题页与摘要——Attention 的第一个目录项在 p.2。
    const groups = groupClipsBySection([clip("intro", 2, 300), clip("abs", 1, 500)], ATTENTION);

    expect(titles(groups)).toEqual(["（目录之前）", "Background"]);
    expect(groups[0].clips.map((c) => c.id)).toEqual(["abs"]);
  });

  it("空的小节不出现——22 项目录配 3 条摘录不该画出 19 个空标题", () => {
    const groups = groupClipsBySection([clip("a", 3, 100)], ATTENTION);

    expect(titles(groups)).toEqual(["Attention"]);
  });

  it("没有目录时就是一个组、按页排——加这个功能之前的样子", () => {
    const groups = groupClipsBySection([clip("b", 5, 300), clip("a", 2, 300)], []);

    expect(titles(groups)).toEqual(["（目录之前）"]);
    expect(groups[0].clips.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("一条摘录都没有时不产出空组", () => {
    expect(groupClipsBySection([], ATTENTION)).toEqual([]);
    expect(groupClipsBySection([], [])).toEqual([]);
  });

  it("组内按页、再按页内位置从上到下排", () => {
    const groups = groupClipsBySection(
      [clip("low", 4, 100), clip("high", 4, 700), clip("next", 5, 700)],
      [{ title: "Attention", page: 3, y: 117, level: 1, path: [] }],
    );

    expect(groups[0].clips.map((c) => c.id)).toEqual(["high", "low", "next"]);
  });

  it("dest 解不开的目录项退化成按页归组，而不是整个功能失效", () => {
    // y 为 null 当成「这一页的最上面」：同页的摘录仍归它，不会掉回上一节。
    const groups = groupClipsBySection(
      [clip("a", 4, 700), clip("b", 4, 100)],
      [
        { title: "前一节", page: 3, y: 200, level: 0, path: [] },
        { title: "解不开的一节", page: 4, y: null, level: 0, path: [] },
      ],
    );

    expect(titles(groups)).toEqual(["解不开的一节"]);
    expect(groups[0].clips).toHaveLength(2);
  });

  it("目录本身乱序传进来也照样排对", () => {
    // pdf.js 给的是树，拍平之后未必按页有序；顺序错了归属就全错，而且不报错。
    const groups = groupClipsBySection([clip("a", 2, 300)], [...ATTENTION].reverse());

    expect(titles(groups)).toEqual(["Background"]);
  });
});

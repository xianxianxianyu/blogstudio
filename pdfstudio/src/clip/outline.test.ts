import { describe, expect, it } from "vitest";
import { addSection, bookmark, groupClipsBySection, shiftSections, type ClipGroup, type Section } from "./outline";
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
    anchorStatus: "anchored",
    tagId: null,
    title: null,
    lastViewedAt: 0,
  };
}

/**
 * 照 Attention 的真实目录造（`.scratch/probe-outline.mts` 量的）：**p.2 上挤了三项**，
 * 这正是「只按页码归组」会翻车的地方。
 */
const ATTENTION: Section[] = [
  { title: "Introduction", page: 2, y: 720, level: 0 },
  { title: "Background", page: 2, y: 436.994, level: 0 },
  { title: "Model Architecture", page: 2, y: 157.59, level: 0 },
  { title: "Encoder and Decoder Stacks", page: 3, y: 315.594, level: 1 },
  { title: "Attention", page: 3, y: 117.119, level: 1 },
];

const titles = (groups: { section: Section | null }[]) =>
  groups.map((group) => group.section?.title ?? "（目录之前）");

/**
 * 某条摘录落在哪一节。
 *
 * 归属的测试就该直接问归属。此前它们是拿「完整标题列表」间接断言的，那同时钉住了
 * 「哪些小节会显示」——两件事绑在一条断言里，ADR-0018 改了后者就把前者全打挂了。
 */
const owner = (groups: ClipGroup[], clipId: string): string | undefined =>
  groups.find((group) => group.clips.some((clip) => clip.id === clipId))?.section?.title ??
  (groups.some((group) => group.section === null && group.clips.some((c) => c.id === clipId))
    ? "（目录之前）"
    : undefined);

describe("按目录组织摘录", () => {
  it("同一页上的三个小节按页内位置分开——只按页码会全堆到一处", () => {
    const groups = groupClipsBySection(
      [clip("a", 2, 700), clip("b", 2, 300), clip("c", 2, 100)],
      ATTENTION,
    );

    expect(owner(groups, "a")).toBe("Introduction");
    expect(owner(groups, "b")).toBe("Background");
    expect(owner(groups, "c")).toBe("Model Architecture");
  });

  it("紧贴标题下面的摘录归给那个标题，不是上一节", () => {
    // y 比标题小 = 在标题下面（PDF 原点在左下）。差一点点也算下面。
    const groups = groupClipsBySection([clip("a", 2, 436.9)], ATTENTION);

    expect(owner(groups, "a")).toBe("Background");
  });

  it("跨在标题上的摘录归给**上一节**——按上沿判，不按下沿", () => {
    // Background 的标题在 y=436.994。这条摘录从 430 拉到 445，横跨标题：
    // 上沿在标题**之上**，所以它的主体是 Introduction 的内容。
    const straddling: Clip = {
      ...clip("straddle", 2, 0),
      region: { page: 2, rect: { x: 54, y: 430, width: 232, height: 15 }, pixels: PIXELS },
    };
    const groups = groupClipsBySection([straddling], ATTENTION);

    expect(owner(groups, "straddle")).toBe("Introduction");
  });

  it("目录第一项之前的摘录单独一组，排在最前", () => {
    // 标题页与摘要——Attention 的第一个目录项在 p.2。
    const groups = groupClipsBySection([clip("intro", 2, 300), clip("abs", 1, 500)], ATTENTION);

    expect(owner(groups, "abs")).toBe("（目录之前）");
    expect(owner(groups, "intro")).toBe("Background");
    // 「（目录之前）」排在最前，不是夹在小节中间。
    expect(titles(groups)[0]).toBe("（目录之前）");
  });

  // ── ADR-0018：目录是导航结构，空小节靠折叠而不是隐藏 ───────────────────
  //
  // 这三条此前反着写（「空的小节不出现」）。那条推理对 15 页的论文成立，对 654 页的
  // 书是灾难性的：早期一条摘录都没有，于是**整本书没有目录**。

  it("空的小节照样出现——藏掉它，读者就不知道第 12 章存在", () => {
    const groups = groupClipsBySection([clip("a", 2, 700)], ATTENTION);

    // 一条摘录，但整份目录都在。
    expect(titles(groups)).toEqual(titles(groupClipsBySection([], ATTENTION)));
    expect(titles(groups)).toContain("Introduction");
    expect(titles(groups)).toContain("Background");
  });

  it("同级的旁支也要出现——它们是这本书的结构，不是某条摘录的上下文", () => {
    const groups = groupClipsBySection([clip("a", 3, 100)], ATTENTION);

    // 此前 Encoder and Decoder Stacks 作为「旁支」被特意排除，现在它就是目录的一部分。
    expect(titles(groups)).toContain("Encoder and Decoder Stacks");
    expect(titles(groups)).toContain("Model Architecture");
    expect(titles(groups)).toContain("Attention");
  });

  it("小节的先后仍然按目录本身的顺序，不按哪个有摘录", () => {
    const groups = groupClipsBySection([clip("a", 3, 100)], ATTENTION);
    const order = titles(groups).filter((t) => t !== "（目录之前）");

    expect(order).toEqual(ATTENTION.map((s) => s.title));
  });

  it("没有目录时就是一个组、按页排——加这个功能之前的样子", () => {
    const groups = groupClipsBySection([clip("b", 5, 300), clip("a", 2, 300)], []);

    expect(titles(groups)).toEqual(["（目录之前）"]);
    expect(groups[0].clips.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("**一条摘录都没有时也要给出整份目录**——刚生成完目录正是这个状态", () => {
    const groups = groupClipsBySection([], ATTENTION);

    expect(titles(groups).filter((t) => t !== "（目录之前）")).toEqual(
      ATTENTION.map((s) => s.title),
    );
    expect(groups.every((g) => g.clips.length === 0)).toBe(true);
  });

  it("既没目录也没摘录才是真的空", () => {
    expect(groupClipsBySection([], [])).toEqual([]);
  });

  it("「目录之前」那一组没摘录时不出现——它不是小节，是个收容所", () => {
    // 空小节要显示，是因为它是这本书的结构；「（目录之前）」不是书的结构，
    // 它只是摘录落在第一个小节之前时的去处。没有那样的摘录就不该有这一行。
    const groups = groupClipsBySection([clip("a", 2, 700)], ATTENTION);

    expect(titles(groups)).not.toContain("（目录之前）");
  });

  it("组内按页、再按页内位置从上到下排", () => {
    const groups = groupClipsBySection(
      [clip("low", 4, 100), clip("high", 4, 700), clip("next", 5, 700)],
      [{ title: "Attention", page: 3, y: 117, level: 1 }],
    );

    expect(groups[0].clips.map((c) => c.id)).toEqual(["high", "low", "next"]);
  });

  it("dest 解不开的目录项退化成按页归组，而不是整个功能失效", () => {
    // y 为 null 当成「这一页的最上面」：同页的摘录仍归它，不会掉回上一节。
    const groups = groupClipsBySection(
      [clip("a", 4, 700), clip("b", 4, 100)],
      [
        { title: "前一节", page: 3, y: 200, level: 0 },
        { title: "解不开的一节", page: 4, y: null, level: 0 },
      ],
    );

    expect(owner(groups, "a")).toBe("解不开的一节");
    expect(owner(groups, "b")).toBe("解不开的一节");
  });

  it("目录本身乱序传进来也照样排对", () => {
    // pdf.js 给的是树，拍平之后未必按页有序；顺序错了归属就全错，而且不报错。
    const groups = groupClipsBySection([clip("a", 2, 300)], [...ATTENTION].reverse());

    expect(owner(groups, "a")).toBe("Background");
  });
});

describe("整体挪页", () => {
  const book: Section[] = [
    { title: "第1章", page: 18, y: null, level: 0 },
    { title: "1.1", page: 18, y: null, level: 1 },
    { title: "第2章", page: 39, y: null, level: 0 },
  ];

  it("每一条都挪，相对关系不变", () => {
    expect(shiftSections(book, -1).map((s) => s.page)).toEqual([17, 17, 38]);
  });

  it("**挪到第 1 页之前就不挪**——整份目录一起卡住，而不是前几条挤在第 1 页", () => {
    // 「第1章」挪到 0 是不合法的。一条越界就整份不动：局部截断会把相对关系毁掉，
    // 而相对关系正是这份目录唯一还可信的东西。
    expect(shiftSections(book, -20)).toBe(book);
  });

  it("刚好挪到第 0 页也不行——页码从 1 起", () => {
    expect(shiftSections(book, -18)).toBe(book);
    // 差一点就是合法的：挪到第 1 页可以。
    expect(shiftSections(book, -17).map((s) => s.page)).toEqual([1, 1, 22]);
  });

  it("挪 0 页原样返回", () => {
    expect(shiftSections(book, 0)).toBe(book);
  });

  it("标题、层级、路径一个都不动——挪的只是页码", () => {
    const moved = shiftSections(book, 3);
    expect(moved.map(({ title, level }) => ({ title, level }))).toEqual(
      book.map(({ title, level }) => ({ title, level })),
    );
  });
});

describe("手动加一条", () => {
  const at = (title: string, page: number, level: number): Section => ({ title, page, y: null, level });

  it("插在指定那条后面，页码和层级都跟着它——加的是**同级的下一条**", () => {
    const list = [at("第1章", 10, 0), at("1.1 简介", 10, 1), at("第3章", 60, 0)];
    const next = addSection(list, 1);

    expect(next).toHaveLength(4);
    expect(next[2]).toEqual({ title: "", page: 10, y: null, level: 1 });
  });

  it("**新条目没有标题**——空标题就是「还没成形」，界面据此直接进编辑态", () => {
    expect(addSection([at("第1章", 10, 0)], 0)[1].title).toBe("");
  });

  it("插在最前面：页码取第一条的，层级归零", () => {
    const next = addSection([at("1.1 简介", 20, 1)], -1);

    expect(next[0]).toEqual({ title: "", page: 20, y: null, level: 0 });
    expect(next[1].title).toBe("1.1 简介");
  });

  it("空目录里加第一条，落在第 1 页", () => {
    expect(addSection([], -1)).toEqual([{ title: "", page: 1, y: null, level: 0 }]);
  });

  it("别的条目一个都不动", () => {
    const list = [at("第1章", 10, 0), at("第3章", 60, 0)];
    const next = addSection(list, 0);

    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[1]);
  });

  it("y 是 null——手加的条目只知道页码，不知道页内位置", () => {
    // 有 y 的话归组会拿它跟摘录的上沿比，而那个数字是编的。
    expect(addSection([at("第1章", 10, 0)], 0)[1].y).toBeNull();
  });
});

describe("在某一页加书签", () => {
  const at = (title: string, page: number, level: number): Section => ({ title, page, y: null, level });
  const book = [at("第1章", 10, 0), at("1.1 简介", 10, 1), at("1.2 例子", 20, 1), at("第2章", 40, 0)];

  it("按页码插到正确的位置", () => {
    const next = bookmark(book, 30, "1.3 趋势");

    expect(next.map((s) => s.title)).toEqual(["第1章", "1.1 简介", "1.2 例子", "1.3 趋势", "第2章"]);
  });

  it("**层级跟着它所在的那一节**——在 1.2 底下加，加出来的就是 1.2 的同级", () => {
    expect(bookmark(book, 30, "1.3")[3].level).toBe(1);
  });

  it("加在所有条目之前就是顶层——那儿没有上文可继承", () => {
    expect(bookmark(book, 3, "前言")[0]).toEqual({ title: "前言", page: 3, y: null, level: 0 });
  });

  it("同页已有条目时排在它们后面——右键那一下发生在读者已经看过的内容之后", () => {
    const next = bookmark(book, 10, "1.0 导读");

    expect(next.map((s) => s.title)).toEqual(["第1章", "1.1 简介", "1.0 导读", "1.2 例子", "第2章"]);
  });

  it("页码比所有条目都大就追加到末尾——在书的最后加「附录」是常事", () => {
    const next = bookmark(book, 100, "附录");

    expect(next[next.length - 1]).toMatchObject({ title: "附录", page: 100 });
    expect(next).toHaveLength(book.length + 1);
  });

  it("没给标题就留空，界面据此进编辑态", () => {
    expect(bookmark(book, 30, "")[3].title).toBe("");
  });

  it("标题去掉首尾空白，也去掉换行——划过去的选区常常带着", () => {
    expect(bookmark(book, 30, "  第3章\n 网络 ")[3].title).toBe("第3章 网络");
  });

  it("空目录里加第一条", () => {
    expect(bookmark([], 5, "开头")).toEqual([{ title: "开头", page: 5, y: null, level: 0 }]);
  });

  it("y 是 null——右键只知道页码，不知道页内位置", () => {
    expect(bookmark(book, 30, "x")[3].y).toBeNull();
  });
});

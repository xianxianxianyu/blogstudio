import type { Clip } from "./clip";

/**
 * 目录是摘录的**上一级管理形式**：有目录就按目录归组，没有就退回按页排。
 *
 * 归属是**算出来的，不落盘**。目录来自 PDF、摘录来自读者，两者各自变化；把归属存进
 * `Clip` 的话，换一版 PDF 或者摘录挪了位置，存下来的那个小节名就成了骗人的旧数据。
 */

/** 拍平后的一个目录项。 */
export interface Section {
  title: string;
  page: number;
  /**
   * 页内位置，PDF 坐标（原点左下，越大越靠上）。`null` 表示 dest 解不开，只知道页码。
   *
   * **这个字段不是可选的装饰**：实测 Attention 的 p.2 有三个目录项、p.5 也有三个，
   * 只按页码归组会把整页的摘录堆到错的小节去。
   */
  y: number | null;
  /** 层级，0 是顶层。 */
  level: number;
}

/**
 * 在第 `index` 条后面插一条空的。`-1` = 插在最前面。
 *
 * **手加的条目是必需的**：模型漏掉一条时，规则能发现的只有「带编号的漏条」——漏掉
 * 一个「练习」、或者标题认错，任何规则都看不出来。所以最终的出口必须是读者自己能加。
 *
 * 新条目**没有标题**：空标题就是「还没成形」，界面据此直接进编辑态，而失焦时仍为空
 * 就撤销。编一个「新条目」当占位符的话，读者一旦忘了改，目录里就永远躺着一行谎话。
 */
export function addSection(sections: Section[], index: number): Section[] {
  const anchor = sections[index] as Section | undefined;
  const draft: Section = {
    title: "",
    // 跟着锚点走：同一节里加一条，多半是同页同级的兄弟。插在最前面时取第一条的页码。
    page: anchor?.page ?? sections[0]?.page ?? 1,
    // y 只有从 PDF 自带目录解出来时才有。手加的只知道页码，编一个 y 会让归组拿它
    // 跟摘录的上沿去比——那个比较的依据是假的。
    y: null,
    level: anchor?.level ?? 0,
  };
  return [...sections.slice(0, index + 1), draft, ...sections.slice(index + 1)];
}

export interface ClipGroup {
  /** `null` 表示「目录第一项之前」——标题页、摘要那一段。 */
  section: Section | null;
  clips: Clip[];
}

/** 摘录的**上沿**：紧贴在标题下面的摘录应该归给那个标题。 */
const topOf = (clip: Clip) => clip.region.rect.y + clip.region.rect.height;

/**
 * 谁在前面。页小的在前；同页则 y 大的在前（原点在左下，y 越大越靠上）。
 *
 * y 为 null 的目录项（dest 解不开）当成「这一页的最上面」，于是它退化成按页归组，
 * 而不是让整个功能失效。
 */
function precedes(section: Section, page: number, y: number): boolean {
  if (section.page !== page) return section.page < page;
  return section.y === null || section.y >= y;
}

export function groupClipsBySection(clips: Clip[], sections: Section[]): ClipGroup[] {
  const ordered = [...sections].sort(
    (a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity),
  );

  const byPosition = (a: Clip, b: Clip) =>
    a.region.page - b.region.page || topOf(b) - topOf(a);

  // 没有目录：一个组，按页排。就是加这个功能之前的样子。
  if (ordered.length === 0) {
    return clips.length === 0 ? [] : [{ section: null, clips: [...clips].sort(byPosition) }];
  }

  const owner = (clip: Clip): Section | null => {
    let found: Section | null = null;
    for (const section of ordered) {
      if (!precedes(section, clip.region.page, topOf(clip))) break;
      found = section;
    }
    return found;
  };

  // 「目录之前」那一组排在最前——标题页和摘要总是先读到。
  const groups: ClipGroup[] = [{ section: null, clips: [] }];
  for (const section of ordered) groups.push({ section, clips: [] });

  for (const clip of clips) {
    const section = owner(clip);
    groups.find((group) => group.section === section)!.clips.push(clip);
  }

  // **空的小节照样出现**（ADR-0018）。此前这里只留有摘录的组（加祖先），理由是
  // 「22 项目录配 3 条摘录，画出 19 个空标题只会让这一栏没法看」。那条推理对 15 页的
  // 论文成立，对 654 页的书是反的：早期一条摘录都没有，于是**整本书没有目录**——
  // 而几百页的书里目录是唯一的导航手段，恰恰是这个功能存在的理由。
  //
  // 密度问题交给折叠，不交给隐藏：**隐藏丢掉的是存在性**（你不知道第 12 章在那儿），
  // 折叠丢掉的只是细节。
  //
  // 唯一还会被滤掉的是「（目录之前）」那一组——它不是书的结构，只是摘录落在第一个
  // 小节之前时的收容所，没有那样的摘录就不该占一行。
  return groups
    .filter((group) => group.section !== null || group.clips.length > 0)
    .map((group) => ({ ...group, clips: group.clips.sort(byPosition) }));
}

/**
 * 整份目录一起挪 N 页。
 *
 * **为什么必须有**：印刷页码与物理页码的偏移只在生成那一刻用一次，之后就烤进每一条的
 * `page` 里了。而「事后才发现差一页」恰恰是最常见的情况——填偏移时要么看错、要么
 * 那本书的前言页数刚好差一。没有这个动作，读者只剩两条路：重跑一遍几分钟的识别，
 * 或者手改三百条。
 *
 * **一条越界就整份不动**，不做局部截断。截断会把相对关系毁掉，而在一份「三项全对率
 * 只有一半」的目录里，相对关系是它唯一还可信的东西。
 */
export function shiftSections(sections: Section[], delta: number): Section[] {
  if (delta === 0) return sections;
  if (sections.some((section) => section.page + delta < 1)) return sections;
  return sections.map((section) => ({ ...section, page: section.page + delta }));
}

/**
 * 在指定的**物理页**加一条书签。
 *
 * 与 `addSection` 的区别是**谁决定页码**：那个跟着锚点走（在目录里点「加一条」），
 * 这个页码是给定的——读者正站在那一页上右键。**站在那一页上，页码就是对的**，
 * 不用猜、也不用事后翻回来核对，而那正是「在目录里加一条」最别扭的地方。
 *
 * 层级继承**它所在的那一节**：在 1.2 底下加，加出来的就是 1.2 的同级。这是个猜测，
 * 但它是廉价且可改的猜测（`←` `→` 一点就变），而且比一律顶层更常对。
 */
export function bookmark(sections: Section[], page: number, title: string): Section[] {
  // 排在同页已有条目的**后面**：右键这一下发生在读者已经看过的内容之后。
  let index = sections.findIndex((section) => section.page > page);
  if (index === -1) index = sections.length;

  const before = sections[index - 1] as Section | undefined;
  const draft: Section = {
    // 选区常常带着换行和缩进（PDF 的文本层按行给），压成一个空格再收边。
    title: title.replace(/\s+/g, " ").trim(),
    page,
    // 右键只知道页码，不知道页内位置。编一个 y 会让归组拿这个假数字跟摘录的上沿去比。
    y: null,
    level: before?.level ?? 0,
  };
  return [...sections.slice(0, index), draft, ...sections.slice(index)];
}

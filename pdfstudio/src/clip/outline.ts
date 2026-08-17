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
  /** 祖先标题，从顶层到父级。给界面显示路径用。 */
  path: string[];
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

  // 空的小节不出现：22 项目录配 3 条摘录，画出 19 个空标题只会让这一栏没法看。
  return groups
    .filter((group) => group.clips.length > 0)
    .map((group) => ({ ...group, clips: group.clips.sort(byPosition) }));
}

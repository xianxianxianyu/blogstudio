/**
 * 稿子的大纲：正文里的标题结构。
 *
 * 它就是这篇文章的骨架，也是 `docs/workflow.md` 里那个 **TOC**——只不过不再是一份单独的
 * 数据（§2.2 的 `toc: [...]`），而是**从正文现算的**。理由与出处的记号住在正文里是同一条
 * （`docs/adr/0002` 决策 1）：稿子可以拿别的编辑器改，任何与正文分开存的结构都会失配，
 * 而且失配时不报错。
 *
 * 与 PDF Studio 的 `Section` 不是一回事，别复用：那边是「书的第几页有什么」，靠识别猜出来、
 * 允许手工修正；这边是「我这篇分几节」，从自己的正文数出来，永远准。
 */

export interface Heading {
  /** `#` 的个数，1–6。 */
  level: number;
  title: string;
  /** 第几行，1 起。 */
  line: number;
  /**
   * 这一节管到哪一行（不含）。下一个**同级或更高级**的标题为界——有子节的章，
   * 内容在子节里，所以它不能在第一个子标题处就结束。
   */
  until: number;
  /** 它是正文里第几个标题，0 起。**点大纲跳过去时按这个数**，见 `DraftPane`。 */
  index: number;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(\S.*?)\s*$/;

export function outlineOf(markdown: string): Heading[] {
  const lines = markdown.split("\n");
  const found: Omit<Heading, "until">[] = [];

  let fenced = false;
  lines.forEach((raw, index) => {
    // 代码块里的 `#` 是注释不是标题。不看这一眼的话，一段 shell 脚本能凭空长出十个章节。
    if (/^\s{0,3}(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = HEADING.exec(raw);
    if (match) {
      found.push({ level: match[1].length, title: match[2], line: index + 1, index: found.length });
    }
  });

  return found.map((heading, at) => ({
    ...heading,
    until: found.slice(at + 1).find((other) => other.level <= heading.level)?.line ?? lines.length + 1,
  }));
}

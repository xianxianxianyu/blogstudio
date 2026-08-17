import type { Line } from "../pdf/lines";
import type { Section } from "../clip/outline";

/**
 * 从书自己印的**目录页**解析出目录。
 *
 * 为什么是目录页而不是扫全文标题：INEX/ICDAR 三轮竞赛的判决一致——目录页派第一名
 * F 43.6%，唯一一支按字号扫全文的 3.8–8.8%，**差五倍**（见
 * `docs/research-large-book-outline.md`）。GROBID 的维护者也说字号聚类做层级
 * 「不可靠，所以移除了」。而 5 万本数字化图书里约 80% 有印刷目录页。
 *
 * **准确率要写进设计**：born-digital 英文书上标题 83% / 页号 73% / 层级 71%、
 * 三项全对只有 **57%**。中文侧一条公开数据都没有。所以这里产出的目录必须标成
 * 「自动识别」且逐条可改——**这份解析是播种，不是定稿**。
 */

export interface TocEntry {
  title: string;
  /** 目录上印的页码，不是物理页码。两者的差由 `inferOffset` 推。 */
  printedPage: number;
  /** 层级，0 是顶层。 */
  level: number;
}

/**
 * 一行目录长什么样：标题、可有可无的点线引导符、行尾的页码。
 *
 * **页码前必须有空白或引导符**。少了这条，`第 2 章 IPv6` 会被解析成
 * 标题「第 2 章 IPv」+ 页码 6——这是这类解析最经典的一种错法。
 */
const TOC_LINE = /^(.*?)[\s.·・…‥⋯_\-—]{1,}(\d{1,4})\s*$/;

/** 引导符与两端空白，标题里不该留着。 */
const TRAILING_LEADERS = /[\s.·・…‥⋯_\-—]+$/;

function entryOf(line: Line): { title: string; printedPage: number } | null {
  const match = TOC_LINE.exec(line.text.trim());
  if (!match) return null;

  const title = match[1].replace(TRAILING_LEADERS, "").trim();
  // 纯数字或空标题不是条目——页眉页脚、孤零零的页码会长这样。
  if (title === "" || /^[\d.\s]+$/.test(title)) return null;

  return { title, printedPage: Number(match[2]) };
}

/** 判定一页是不是目录页所需的最少条目数。太少的话正文里一段带页码的表格也会被认成目录。 */
const MIN_ENTRIES = 5;

/** 目录页上「像条目的行」应占的比例。 */
const MIN_ENTRY_RATIO = 0.5;

/** 明写的目录标题。有它基本就板上钉钉，但**不能只认它**——很多书的目录页没有这两个字。 */
const TOC_HEADING = /^(目\s*录|目\s*次|contents|table of contents)$/i;

/**
 * 这一页看起来是不是目录页。
 *
 * 两个信号：**大部分行以页码结尾**，以及明写的「目录」标题。前者是主判据——后者
 * 靠不住，续页往往不重复标题。
 */
export function looksLikeToc(lines: Line[]): boolean {
  const meaningful = lines.filter((line) => line.text.trim() !== "");
  if (meaningful.length === 0) return false;

  const entries = meaningful.filter((line) => entryOf(line) !== null);
  if (entries.length < MIN_ENTRIES) return false;

  const titled = meaningful.some((line) => TOC_HEADING.test(line.text.trim()));
  // 有「目录」二字时放宽比例：那一页往往还印着书名、页眉之类。
  return entries.length / meaningful.length >= (titled ? 0.3 : MIN_ENTRY_RATIO);
}

/** 缩进分档的容差，单位是点。同一层的行左边界不会正好相等。 */
const INDENT_TOLERANCE = 4;

/**
 * 层级从**缩进**来，不从编号来。
 *
 * 编号形式在中文书里五花八门（`第三章` / `3.1` / `一、` / `（二）`），而缩进是排版
 * 事实、跨语言一致。编号只在**完全没有缩进**时兜底——有些书的目录一列到底。
 */
function levelsByIndent(entries: { line: Line }[]): number[] {
  const buckets: number[] = [];
  for (const { line } of entries) {
    if (!buckets.some((x) => Math.abs(x - line.x0) < INDENT_TOLERANCE)) buckets.push(line.x0);
  }
  buckets.sort((a, b) => a - b);

  return entries.map(({ line }) =>
    buckets.findIndex((x) => Math.abs(x - line.x0) < INDENT_TOLERANCE),
  );
}

/** `3.1.2` → 2；`第三章` → 0。没有可识别的编号返回 null。 */
function levelByNumbering(title: string): number | null {
  const dotted = /^(\d+(?:\.\d+)*)\s/.exec(title);
  if (dotted) return dotted[1].split(".").length - 1;
  if (/^(第\s*[〇一二三四五六七八九十百零\d]+\s*[章篇部])/.test(title)) return 0;
  if (/^(第\s*[〇一二三四五六七八九十百零\d]+\s*[节節])/.test(title)) return 1;
  return null;
}

/**
 * 把若干页目录页的行解析成条目。
 *
 * 顺序即阅读顺序——行本身已经由 `inReadingOrder` 排过（双栏目录确实存在）。
 */
export function parseToc(pages: Line[][]): TocEntry[] {
  const found = pages
    .flat()
    .map((line) => ({ line, entry: entryOf(line) }))
    .filter((item): item is { line: Line; entry: { title: string; printedPage: number } } =>
      item.entry !== null,
    );

  const indented = levelsByIndent(found);
  // 全在同一档 = 这本书的目录没有缩进，只能靠编号。
  const flat = new Set(indented).size <= 1;

  return found.map(({ entry }, index) => ({
    ...entry,
    level: flat ? (levelByNumbering(entry.title) ?? 0) : indented[index],
  }));
}

export interface OffsetEvidence {
  title: string;
  printedPage: number;
  /** 在正文里真正找到它的物理页。 */
  actualPage: number;
}

export interface Offset {
  /** 物理页 = 印刷页 + offset。 */
  offset: number;
  evidence: OffsetEvidence[];
}

/** 至少要这么多条互相印证，才算推出了偏移。一条对上可能是巧合。 */
const MIN_AGREEING = 3;

/**
 * 推断印刷页码与物理页码的偏移。
 *
 * **不让读者填这个数**：目录上写着「第三章 …… 87」，去正文里找「第三章」发现它在物理
 * 第 95 页，偏移就是 8。拿几条互相印证，一致才算数——而且这几条可以直接摆给读者看，
 * 「请确认」比「请填写」可靠得多。
 *
 * `findTitle` 由调用方给（它要翻文本层，这一层不做 I/O）。返回 null 表示没找到。
 */
export function inferOffset(
  entries: TocEntry[],
  findTitle: (title: string) => number | null,
): Offset | null {
  const votes = new Map<number, OffsetEvidence[]>();

  for (const entry of entries) {
    const actualPage = findTitle(entry.title);
    if (actualPage === null) continue;
    const offset = actualPage - entry.printedPage;
    // 目录页在正文前面，所以偏移不可能是负的；负数说明找错了地方（多半撞上了目录页自己）。
    if (offset < 0) continue;
    votes.set(offset, [...(votes.get(offset) ?? []), { title: entry.title, printedPage: entry.printedPage, actualPage }]);
  }

  const best = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!best || best[1].length < MIN_AGREEING) return null;

  return { offset: best[0], evidence: best[1].slice(0, 3) };
}

/**
 * 目录条目 → 摘录栏用的 `Section`。
 *
 * `path`（祖先标题）在这里由 `level` 现算：解析出来的只有层级，而分组要靠 path 补出
 * 没有摘录的祖先标题。层级跳级（0 → 2）时按实际栈深归一，否则 path 会缺一层。
 */
export function toSections(entries: TocEntry[], offset: number): Section[] {
  const stack: string[] = [];
  return entries.map((entry) => {
    const level = Math.min(entry.level, stack.length);
    stack.length = level;
    const section: Section = {
      title: entry.title,
      page: entry.printedPage + offset,
      y: null,
      level,
      path: [...stack],
    };
    stack.push(entry.title);
    return section;
  });
}

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

/**
 * 标题里残留的「引导符 + 页码」。至少三个引导符才算——真正的点线引导符是长长一串，
 * 而 `3.4.4` `802.11` 这种编号里的点是单个的，不会误伤。
 */
const RUN_ON = /[\s.·・…‥⋯_\-—]{3,}\d/;

/** 引导符与两端空白，标题里不该留着。 */
const TRAILING_LEADERS = /[\s.·・…‥⋯_\-—]+$/;

function entryOf(line: Line): { title: string; printedPage: number } | null {
  const match = TOC_LINE.exec(line.text.trim());
  if (!match) return null;

  const title = match[1].replace(TRAILING_LEADERS, "").trim();
  // 纯数字或空标题不是条目——页眉页脚、孤零零的页码会长这样。
  if (title === "" || /^[\d.\s]+$/.test(title)) return null;
  // **标题里还留着一组「引导符 + 页码」= 这一行揉进了好几条。** 分辨率不够时模型会
  // 把相邻几行合成一行、并顺着上一行的编号往下编（实测：`1.7.1 系统模型 ..... 22.1
  // 简介 ..... 22.2 物理模型 ..... 23`，实际是四条，其中还有一条是「第2章」）。
  // 照单全收的话，产出是一个编号连贯、页码递增、完全错误的目录，而且看不出来——
  // **缺一条是看得见的空档，编一条是看不见的错误**，所以宁可丢掉。
  if (RUN_ON.test(title)) return null;

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
/**
 * 把折行的条目拼回去。
 *
 * 印刷目录里长条目会折成两行，而**页码印在第二行**：
 *
 *     4.4.1  IP 组播——组播通信的
 *            实现 ……………… 98
 *
 * `entryOf` 只认「以页码结尾」的行，于是带真标题和编号的第一行被整条丢掉，剩下一个
 * 两个字的尾巴（`实现`）。而尾巴没有编号 ⟹ 层级判成 0 ⟹ 它又会把**下一条**的层级
 * 在 `toSections` 里夹坏。审 395 条真实目录：18 条尾巴 + 8 条被带歪 = 26 处，占 6.6%，
 * 是这份目录里最大的一类错误。
 *
 * **判据是互补性**，这也是它不会误伤的原因：折行的两半各缺对方那一半。
 *
 *   前一行：有编号、没页码      后一行：有页码、没编号
 *
 * 于是页眉和书名（`目录` / `Distributed Systems…`）不合前半条件——它们没编号；
 * 而 `前言` 后面跟着的 `第1章 … 1` 不合后半条件——它有编号。两类假阳性都挡住了。
 */
function mergeWrapped(lines: Line[]): Line[] {
  const merged: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    const tail = next && entryOf(next);

    if (
      next &&
      tail &&
      entryOf(head) === null &&
      levelByNumbering(head.text.trim()) !== null &&
      levelByNumbering(tail.title) === null
    ) {
      // 拼出来的行**沿用上半截的 x0**：层级来自缩进时，续行缩得更深，用下半截会多出
      // 一个不存在的档位，把整份目录的层级判定带偏。
      merged.push({ ...head, text: `${head.text.trim()}${next.text.trim()}` });
      i++;
      continue;
    }
    merged.push(head);
  }
  return merged;
}

export function parseToc(pages: Line[][]): TocEntry[] {
  const found = pages
    .flatMap((page) => mergeWrapped(page))
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
  // **不夹层级。** 这里原先维护一个祖先栈，顺手做 `Math.min(entry.level, stack.length)`
  // ——那个栈只为了填 `Section.path`（一个只被写、从来没被读的字段），而那次夹取正是
  // 把 `4.4.2` 从 L2 夹成 L1 的原因：前面一条折行碎片被判成 L0，栈就只剩一层。
  // 层级跳级由渲染那边负责（`outline-rows.ts` 有测试钉着），不在这里悄悄改数据。
  return entries.map((entry) => ({
    title: entry.title,
    page: entry.printedPage + offset,
    y: null,
    level: entry.level,
  }));
}

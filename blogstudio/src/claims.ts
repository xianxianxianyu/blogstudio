/**
 * 断言与它的出处（`docs/workflow.md` §1.5）。
 *
 * > 不存在既无 provenance 又未标记 authored 的断言。
 *
 * **出处的记号住在正文里，不在旁边的一张表里。**
 *
 * §2.2 设计的是 `blocks[] + provenance` 的结构化模型，那要求每一块有稳定的身份。而稿子
 * 在磁盘上是一份可以拿别的编辑器改的 markdown（ADR-0004 决策 3），块的身份只能靠位置或
 * 内容哈希锚定——改一个字就失配，而且失配的时候不会报错，只会悄悄把出处安到别的段落上。
 *
 * 所以出处就写在段落里：`[ctx:xxx]` 引一条材料，`[authored]` 表示这是我自己的观点。
 * 它和写作搭子在对话里用的是**同一个记号**，人手打、agent 写、外面的编辑器里看，
 * 三处都是同一个东西。见 `blogstudio/docs/adr/0002`。
 */

export type Provenance =
  /** 引了材料，列的是 context 的 id。 */
  | { kind: "cited"; ids: string[] }
  /** 我自己的观点，没有出处，也不该有。 */
  | { kind: "authored" }
  /** 还没表态——这是**唯一**要被检查拦下来的一种。 */
  | { kind: "none" };

export interface Claim {
  /** 段落起止行，1 起。报告要能指到地方。 */
  line: number;
  endLine: number;
  text: string;
  provenance: Provenance;
}

export const AUTHORED = "[authored]";

const CITE = /\[ctx:([^\]\s]+)\]/g;
const AUTHORED_MARK = /\[authored\]/;

/** 这一行是不是标题。 */
const isHeading = (line: string): boolean => /^\s{0,3}#{1,6}\s+\S/.test(line);

/** 围栏代码块的边界（``` 或 ~~~）。 */
const isFence = (line: string): boolean => /^\s{0,3}(```|~~~)/.test(line);

/**
 * 只由 HTML 标签和空白拼成的块**不算断言**。
 *
 * 编辑器把空段落序列化成 `<br />`（Crepe 就是这么干的），于是一篇只有两个标题、
 * 中间空着的稿子，会被报出五条「这一段既没有出处」——指着五个 `<br />`。那不是断言，
 * 那是排版；报出来的每一条都得人手动消掉，而消不掉，因为它根本不是一句话。
 */
const isBlank = (text: string): boolean => text.replace(/<[^>]*>/g, "").trim() === "";

/** 不承载断言的行：分隔线、表格、图片独占一行、引用块。 */
const isFurniture = (line: string): boolean =>
  /^\s{0,3}([-*_]\s*){3,}$/.test(line) || /^\s{0,3}\|/.test(line) || /^\s{0,3}>/.test(line);

interface Block {
  line: number;
  endLine: number;
  lines: string[];
}

/**
 * 把正文切成「需要出处的块」。
 *
 * **单位是段落与列表项**，不是句子——一句一句要出处，写出来会像论文的参考文献表，
 * 而人真正在做的判断是「这一段站得住吗」。
 *
 * 不算断言的：标题（它是结构不是主张）、代码块、表格、分隔线、**引用块**。
 * 引用块是那个可争议的：它显然在引别人的话，本该有出处；但引文后面几乎总跟着一段
 * 解释，而那一段会被算进来——两段都要标，就成了重复劳动。所以引文跟着它的解释走。
 */
export function blocksOf(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let current: Block | null = null;
  let fenced = false;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (isFence(raw)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (raw.trim() === "" || isHeading(raw) || isFurniture(raw)) {
      flush();
      return;
    }
    // 列表项各算一条：一项通常就是一句话，粒度正好；而整个列表算一条的话，
    // 五条论据只要有一条带了出处，剩下四条就免检了。
    if (/^\s*([-*+]|\d+[.)])\s+/.test(raw)) flush();

    if (current) {
      current.lines.push(raw);
      current.endLine = line;
    } else {
      current = { line, endLine: line, lines: [raw] };
    }
  });
  flush();

  return blocks;
}

function provenanceOf(text: string): Provenance {
  const ids = [...text.matchAll(CITE)].map((match) => match[1]);
  // 两个记号都在也不算冲突：一段话既引了材料、又下了自己的判断，是常态。
  // 有出处就按有出处算——那是更强的一种。
  if (ids.length > 0) return { kind: "cited", ids };
  return AUTHORED_MARK.test(text) ? { kind: "authored" } : { kind: "none" };
}

export function claimsOf(markdown: string): Claim[] {
  return blocksOf(markdown)
    .map((block) => {
      const text = block.lines.join("\n");
      return { line: block.line, endLine: block.endLine, text, provenance: provenanceOf(text) };
    })
    .filter((claim) => !isBlank(claim.text));
}

/**
 * 把某一段标成「我自己的观点」——在它最后一行的末尾添一个 `[authored]`。
 *
 * 已经有出处或已经标过的**原样返回**：这个动作要能重复点而不叠加记号。
 *
 * 添在末尾而不是开头：读的时候，先看见主张、再看见它的来路，与引用的读法一致。
 */
export function markAuthored(markdown: string, line: number): string {
  const claim = claimsOf(markdown).find((one) => one.line === line);
  if (!claim || claim.provenance.kind !== "none") return markdown;

  const lines = markdown.split("\n");
  const at = claim.endLine - 1;
  lines[at] = `${lines[at].trimEnd()} ${AUTHORED}`;
  return lines.join("\n");
}

/** 正文里引到的全部 context id，去重。 */
export function citedIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(CITE)].map((match) => match[1]))];
}

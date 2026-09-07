/**
 * 稿子（Draft）——Blog Studio 这一侧的那个东西。
 *
 * **一篇稿子就是一份 markdown**，没有块数组、没有 revision 树。`docs/workflow.md` §2.2
 * 设计的是 `blocks[] + provenance + revision` 那一套，那是给 Loop（agent 自己改、改动要
 * 能审）准备的；现在还没有 Loop，只有人在编辑器里写。**先让人写得下去**，等 agent 真的
 * 开始动文本，再把块和 provenance 加进来——反过来（先建模、再实现编辑）会让第一天就得
 * 维护一套没人读的结构。
 *
 * **标题是派生的，不是字段。** 正文第一行的标题就是稿子的名字。存成字段就有两处真相，
 * 而文件是允许手改的（ADR-0011 的形状），手改了正文标题、列表里还是旧名字这种事必然发生。
 */

export interface Draft {
  id: string;
  /** 正文。它就是磁盘上那个 `.md` 文件里 frontmatter 之后的全部内容。 */
  markdown: string;
  createdAt: number;
  updatedAt: number;
}

/** 列表里一行要的东西。正文可能几万字，列稿子时不该整篇拿在手上。 */
export interface DraftSummary {
  id: string;
  title: string;
  /** 标题之后的第一句，给列表当副标题。 */
  excerpt: string;
  updatedAt: number;
}

export const UNTITLED = "未命名";

/** 一行 markdown 剥掉行首的记号（`#`、`-`、`>`、`1.`）与首尾空白。 */
const bare = (line: string): string =>
  line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "").trim();

const cut = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * 稿子的名字：**第一个标题行**；没有标题就拿第一行有字的当名字；整篇空的才是「未命名」。
 *
 * 退回「第一行」而不是直接给未命名，是因为写的人经常先敲一行字再回头补 `#`——那一行
 * 已经足以在列表里认出这篇是什么了。
 */
export function titleOf(markdown: string): string {
  const lines = markdown.split("\n");
  const heading = lines.find((line) => /^\s*#{1,6}\s+\S/.test(line));
  if (heading !== undefined) return cut(bare(heading), 60);

  const first = lines.map(bare).find((line) => line !== "");
  return first === undefined ? UNTITLED : cut(first, 60);
}

/** 标题之后的第一句话。没有就是空串——列表那一行自己会收掉。 */
export function excerptOf(markdown: string): string {
  const lines = markdown.split("\n");
  const from = lines.findIndex((line) => /^\s*#{1,6}\s+\S/.test(line));
  const rest = lines.slice(from + 1).map(bare);
  return cut(rest.find((line) => line !== "") ?? "", 90);
}

export const summarize = (draft: Draft): DraftSummary => ({
  id: draft.id,
  title: titleOf(draft.markdown),
  excerpt: excerptOf(draft.markdown),
  updatedAt: draft.updatedAt,
});

/**
 * 新起一篇：**空的**。
 *
 * 不预填 `# 未命名`：那行字第一件事就是被删掉，而在删掉之前它是一个假的标题——列表里
 * 一排「未命名」，看不出哪篇是哪篇。空稿子在编辑器里显示的是提示语（placeholder），
 * 它比一行占位的正文更接近「这里还什么都没有」。
 */
export const newDraft = (id: string, now: number): Draft => ({
  id,
  markdown: "",
  createdAt: now,
  updatedAt: now,
});

/**
 * 稿子架的端口。Writer 只认这个形状，底下是什么它不管。
 *
 * 现在的底是统一目录（`blog/drafts-on-articles.ts`）：`id` 就是 slug 就是文件名。
 * 原来那个 `drafts/<uuid>.md` 的实现（`draft-store.ts`）ADR-0005 之后退休并删掉了。
 */
export interface DraftStore {
  /** 列出全部，按最近改动排前面。正文不带回来——列表不需要整篇。 */
  list(): Promise<DraftSummary[]>;
  /** 没有这一篇就是 null，不抛：列表和正文可能差着一次删除。 */
  load(id: string): Promise<Draft | null>;
  save(draft: Draft): Promise<void>;
  remove(id: string): Promise<void>;
}

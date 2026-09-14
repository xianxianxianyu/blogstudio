import type { Draft, DraftStore, DraftSummary } from "../draft";
import { summarize } from "../draft";
import type { ArticleStore } from "./article-store";

/**
 * 让 Writer 直接编辑**统一目录**里的文章（ADR-0005）。
 *
 * Writer 的端口（`DraftStore`）没变，换掉的是它的底：原来是 `drafts/<uuid>.md`
 * （JSON frontmatter），现在是 `site/content/blog/<slug>.md`（YAML）。
 * **一个目录、一套「未完成」**——这正是 ADR-0005 要的那一下。
 *
 * 两处对应关系：
 *
 * - `Draft.id` = `Article.slug` = 文件名。**不再有第二套身份。**
 * - `Draft.updatedAt` = 文件的 mtime。frontmatter 里那个 `date` 是**文章面世的日子**，
 *   跟「我最近碰的是哪一篇」不是一回事，不能拿来排列表。
 *
 * **新起的一篇一律是下架的**：还没写完的东西不该出现在网站上。
 */
/**
 * 这一篇的正文是不是原始 HTML（那 92 篇从 Halo 迁过来的就是）。
 *
 * **为什么要认出来**：markdown 编辑器拿不住这种正文。实测一篇真文章的往返：
 * `{ html: 1, paragraph: 7, heading: 2 }`——**只有开头一块被当成 HTML**，
 * 因为 `<pre><code>` 里的空行在 CommonMark 里就是 HTML 块的结束标志，后面全被当成
 * markdown 重新解析。再存回去时代码缩进没了、下划线变成 `\_`，28878 字符少了 85 个。
 *
 * 判据只看开头：正文以块级标签起头就算。**宁可多认几篇**——认错的代价是那一篇暂时
 * 不能在 Writer 里改，而漏认的代价是它被悄悄改坏。
 */
export const isRawHtml = (markdown: string): boolean =>
  /^\s*<(p|div|h[1-6]|pre|table|ul|ol|blockquote|figure|section)\b/i.test(markdown);

export function draftsOnArticles(articles: ArticleStore): DraftStore {
  return {
    async list(): Promise<DraftSummary[]> {
      const all = await articles.list();
      return all
        .map((one) => ({
          ...summarize({ id: one.slug, markdown: "", createdAt: 0, updatedAt: one.updatedAt ?? 0 }),
          // 标题走文章那一套（frontmatter 优先），不用 `summarize` 从正文猜——
          // 那 92 篇的正文里多半没有 H1。
          title: one.title,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async load(id: string): Promise<Draft | null> {
      const one = await articles.load(id);
      return one === null
        ? null
        : { id: one.slug, markdown: one.markdown, createdAt: 0, updatedAt: one.updatedAt ?? 0 };
    },

    async save(draft: Draft): Promise<void> {
      const had = await articles.load(draft.id);
      if (had === null) {
        // 新起的一篇：**下架**。名字用人起的那个；没起（老的 uuid 那条路）才从正文猜。
        await articles.save({ slug: draft.id, title: draft.title ?? titleOf(draft.markdown), markdown: draft.markdown, draft: true });
        return;
      }
      /**
       * **正文是原始 HTML 的，拒绝写回。**
       *
       * 不是保守，是实测：markdown 往返会把它改坏（见 `isRawHtml` 上那段）。
       * 拒绝的代价是这一篇暂时得用别的编辑器改；不拒绝的代价是它被悄悄改坏，
       * 而且改坏的样子（多出来的 `\_`、丢掉的缩进）要等文章发出去才看得见。
       */
      if (isRawHtml(had.markdown)) {
        throw new Error(
          "这篇的正文是原始 HTML（从 Halo 迁过来的那批），markdown 编辑器存回去会把它改坏——先转成 markdown 再改。",
        );
      }

      /**
       * 已有的那些：**只换正文，frontmatter 一个字不动**——包括 `title`，只有下面
       * 那一个例外。
       *
       * 跟着正文改标题会把 frontmatter 里手写的那个覆盖掉，而那 92 篇的标题恰恰
       * 都在 frontmatter 里、正文里没有 H1。改标题是管理页上的一个动作，不是打字的副作用。
       *
       * **例外：下架的文章，正文第一个 `# 标题` 就是它的名字。**
       *
       * 没有这条，Writer 新起的一篇会永远叫「未命名」：`create()` 用空正文落盘，那一刻
       * 的名字就冻在 frontmatter 里，而界面上没有任何一处能改它。两个条件缺一不可：
       * 「下架」是因为在架的标题挂在公网上，改它该是管理页上的一个动作；「`# `」是因为
       * 那 26 篇从 Halo 迁来的下架文章标题在 frontmatter、正文是 HTML（`<h1>` 不算），
       * 它们一个都不该被碰。
       */
      const h1 = had.draft ? h1Of(draft.markdown) : null;
      await articles.save({ ...had, markdown: draft.markdown, ...(h1 === null ? {} : { title: h1 }) });
    },

    remove: (id: string) => articles.remove(id, Date.now()).then(() => undefined),
  };
}

/**
 * 正文里第一个 `# ` 一级标题，**代码块里的不算**——一篇讲 shell 的文章，代码块里
 * `# 注释` 满地都是。没有就是 null。
 */
function h1Of(markdown: string): string | null {
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const hit = /^\s{0,3}#\s+(\S.*)$/.exec(line);
    if (hit) return hit[1]!.trim();
  }
  return null;
}

/** 正文第一个标题行；没有就第一行有字的；都没有就「未命名」。 */
function titleOf(markdown: string): string {
  const lines = markdown.split("\n");
  const heading = lines.find((line) => /^\s*#{1,6}\s+\S/.test(line));
  if (heading !== undefined) return heading.replace(/^\s*#{1,6}\s+/, "").trim();
  return lines.map((line) => line.trim()).find((line) => line !== "") ?? "未命名";
}

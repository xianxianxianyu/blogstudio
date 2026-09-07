import type { Context, Source } from "../../../contextstudio/src/context";
import { isoAt } from "../publish/frontmatter";
import type { Article } from "./article-store";

/**
 * 管理一篇文章的三个操作。**全是纯函数**：给一篇，返回改完的那一篇，落盘归
 * `ArticleStore`。所以这一层能在 Node 里测，而这条线上出的错有大半在接线上。
 *
 * 三个操作在云端的效果都一样：**下次同步时生效**。它们本身一个字节都不出这台机器。
 */

/** 换标签。 */
export const retag = (article: Article, tags: string[]): Article => ({ ...article, tags });

/** 上下架。`draft: true` = 下架：不被构建，同步时从云端消失，**文件原地不动**。 */
export const withdraw = (article: Article, draft: boolean): Article =>
  article.draft === draft ? article : { ...article, draft };

const CITE = /\[ctx:([^\]\s]+)\]/g;
/** `[authored]` 连同它前面可能有的一个空格一起吃掉，别在句子中间留个洞。 */
const AUTHORED = / ?\[authored\]/g;
const FENCE = /^\s{0,3}(```|~~~)/;
/**
 * 上一次上架留下的脚注定义。**只用来接着发号**，不用来跳过那一行——
 * 那一行里已经没有 `[ctx:]` 了（它变成了 `<!-- ctx: -->`），`mark()` 对它本就是空操作。
 * 曾经在这儿多写了一个跳过判断，变异测试证明它一个字都不改变。
 */
const NOTE = /^\[\^(\d+)\]:/;

function referenceOf(source: Source): string {
  const where = /^https?:\/\//.test(source.docId)
    ? `[${source.title}](${source.docId})`
    : `《${source.title}》`;
  return source.locator === "" ? where : `${where} ${source.locator}`;
}

/**
 * 上架：`draft: false`，并且**把 `[ctx:]` 就地落成脚注**。
 *
 * 为什么在这一刻做：写作期间标记留在正文里是对的（ADR-0002——出处跟着那段话一起被
 * 剪切粘贴）；但**它不能进公网**。上架是你选定的那个时刻，一次性、单向。
 *
 * 脚注用 Hugo 自带的语法（带回跳锚点），并把 id 藏进 `<!-- ctx:xxx -->`：
 * 实测那个注释**渲染时被吃掉、但留在 md 里**——读者看不见，索引读得到。
 */
export function promote(
  article: Article,
  pool: Context[],
  now: number,
  offsetMinutes: number,
): Article & { missing: string[] } {
  const found = new Map(pool.map((one) => [one.id, one]));
  const numbers = new Map<string, number>();
  const missing = new Set<string>();

  /**
   * 已经在正文里的脚注号，**下一个从它之后开始发**。
   *
   * 不看这个的话，第二次上架时新引用会从 `[^1]` 开始，跟上一次留下的 `[^1]` 撞上——
   * 而 Hugo 不会报错，只是两处引用指向同一条参考。
   */
  const taken = article.markdown
    .split("\n")
    .map((line) => NOTE.exec(line))
    .filter((hit): hit is RegExpExecArray => hit !== null)
    .map((hit) => Number(hit[1]));
  let next = taken.length === 0 ? 1 : Math.max(...taken) + 1;

  const mark = (line: string): string =>
    line.replace(AUTHORED, "").replace(CITE, (whole, id: string) => {
      if (!found.has(id)) {
        // 库里没有的 id **原样留着**：悄悄删掉等于把一句没出处的话送上公网，
        // 悄悄渲染等于**编**一条参考。
        missing.add(id);
        return whole;
      }
      const n = numbers.get(id) ?? next++;
      numbers.set(id, n);
      return `[^${n}]`;
    });

  /**
   * **正文开头的 `# 标题` 去掉——只在它就是这篇的标题时。**
   *
   * Hugo 自己渲染 frontmatter 的 `title`，正文里再来一份，页面上就是两个大标题。
   * Writer 里写的稿子第一行就是 `# 标题`（名字正是从它来的，`drafts-on-articles.ts`），
   * 所以这一步和 `[ctx:]` 落成脚注是同一类事：上架这一刻的翻译。
   *
   * 不相同的不动：那是正文里的一个标题，不是重复的名字。
   */
  const dropped = withoutLeadingTitle(article.markdown, article.title);

  let fenced = false;
  const lines = dropped.split("\n").map((line) => {
    // **代码块里的记号一个都不许动**：一篇讲 Blog Studio 的文章，正文里就会出现
    // `[ctx:xxx]` 这几个字——换成脚注等于把示例代码改错。
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    return fenced ? line : mark(line);
  });

  const notes = [...numbers]
    .sort((a, b) => a[1] - b[1])
    .map(([id, n]) => `[^${n}]: ${referenceOf(found.get(id)!.source)} <!-- ctx:${id} -->`);

  const body = lines.join("\n").trimEnd();
  return {
    ...article,
    draft: false,
    // **已经有 date 就不动**：那是文章面世的日子，不是这次改动的时间。每次上架都推到
    // 今天的话，博客首页的顺序会跟着每一次错别字修订翻一遍。
    date: article.date ?? isoAt(now, offsetMinutes),
    markdown: notes.length === 0 ? body : `${body}\n${notes.join("\n")}`,
    missing: [...missing],
  };
}

/** 开头（跳过空行）那一行是 `# <title>` 就去掉它，连同紧跟的空行。 */
function withoutLeadingTitle(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  if (at === -1) return markdown;
  const hit = /^\s{0,3}#\s+(\S.*)$/.exec(lines[at]!);
  if (!hit || hit[1]!.trim() !== title.trim()) return markdown;
  const rest = lines.slice(at + 1);
  while (rest[0]?.trim() === "") rest.shift();
  return rest.join("\n");
}

import { mkdir, readFile, readdir, rename as rename_, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRawHtml } from "./drafts-on-articles";
import { expired, parseTrashName, trashNameOf } from "./trash";
import { putFields, readFields } from "../publish/fields";
import { slugProblem } from "../publish/slug";

/**
 * 统一目录里的文章（ADR-0005）。
 *
 * **一篇文章就是一份 markdown**，YAML frontmatter 放机器读的、`---` 之后原样是正文。
 * 把一个 `.md` 丢进那个目录就能打开，不用导入；拿别的编辑器改也不会坏。
 *
 * 这一层取代了 `draft-store.ts` 在博客这一侧的位置。两处不同：frontmatter 是 YAML
 * 不是 JSON；**id 就是 slug 就是文件名**，不再有第二套身份。
 */

export interface Article {
  /** = 文件名（不含 `.md`）= 网址最后一截。 */
  slug: string;
  title: string;
  /** frontmatter 里那个 `date`，**原样的字符串**——不解析、不重排格式。 */
  date?: string;
  /** **下架** = `true`：不被构建，同步时从云端消失，文件原地不动。 */
  draft: boolean;
  tags?: string[];
  categories?: string[];
  markdown: string;
  /**
   * 文件最后改动的时刻。**不是 frontmatter 里那个 `date`**——那是文章面世的日子，
   * 这个是「我最近碰的是哪一篇」。写作时列表按它排。
   */
  updatedAt?: number;
}

/**
 * 列表里一行要的东西。正文可能几万字，列 92 篇时不该整篇拿在手上。
 *
 * 多一个 `html`：**这一篇的正文是不是原始 HTML**（那批从 Halo 迁过来的）。
 * 它是从正文算出来的，而列表恰好读得到正文——**放在这儿，列表才能一眼标出
 * 哪几篇不能在编辑器里改**（markdown 往返会把它们改坏，见 `drafts-on-articles.ts`）。
 */
export type ArticleSummary = Omit<Article, "markdown"> & { html: boolean };

/** 回收站里的一件。 */
export interface Trashed {
  /** 回收站里的文件名（含时间戳前缀）。放回去时要用它。 */
  name: string;
  /** 放回去之后的地址。 */
  slug: string;
  /** 什么时候丢的。**认不出就是 null**，那种永远不自动清。 */
  at: number | null;
  title: string;
}

/**
 * 回收站留多久。**一个月。**
 *
 * 按「每一件各自满 30 天」算，不是「每月某一天全清」——后者会让昨天丢的东西因为
 * 今天恰好到日子而消失（`trash.ts` 的 `expired`）。
 */
export const KEEP_DAYS = 30;

export interface ArticleStore {
  list(): Promise<ArticleSummary[]>;
  load(slug: string): Promise<Article | null>;
  save(article: Article): Promise<void>;
  /** 移进回收站，返回它的落点（相对仓库根）。**不是删除。** */
  remove(slug: string, now: number): Promise<string>;
  /** 回收站里现在有什么。**顺手把过期的清掉**。 */
  trash(now: number): Promise<Trashed[]>;
  /**
   * 只清，不列。返回清掉了哪些。
   *
   * 跟 `trash` 分开，是因为清理要挂在秒表上跑：**它不需要标题**，
   * 而标题要逐个读文件——一分钟读一遍一整个目录，为的是一条 30 天的规矩，不值。
   */
  purge(now: number): Promise<string[]>;
  /** 从回收站放回来。返回它的 slug。**同名的已经存在就拒绝**，不覆盖。 */
  restore(name: string): Promise<string>;

  /**
   * 换地址。**只该在下架时用**——在架的文章换地址等于公网上换 URL，旧链接全断，
   * 而这一层拦不住那件事，得由上一层守着。
   */
  rename(from: string, to: string): Promise<void>;
}

/** YAML 的双引号串。只有反斜杠和双引号要转义，顺序不能反。 */
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** 去掉一个标量外面的引号。**只去成对的**，别把正文里的引号啃掉。 */
const bare = (value: string): string =>
  /^"(.*)"$/.test(value) || /^'(.*)'$/.test(value) ? value.slice(1, -1) : value;

/**
 * 行内列表 `[a, b]`。**块状那种（`- a` 分行写）也读得出来**——那 92 篇两种写法都有。
 * 块状的值在 `readFields` 那儿是空串，所以这里给空数组，由调用方决定要不要改写成行内。
 */
function readList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const inline = /^\[(.*)\]$/.exec(value.trim());
  if (!inline) return [];
  return inline[1]!
    .split(",")
    .map((one) => bare(one.trim()))
    .filter((one) => one !== "");
}

const writeList = (list: string[]): string => `[${list.join(", ")}]`;

/** 正文里第一个标题行，剥掉 `#`。**只在 frontmatter 没有 title 时才用**。 */
function headingOf(markdown: string): string {
  const line = markdown.split("\n").find((one) => /^\s*#{1,6}\s+\S/.test(one));
  return line === undefined ? "" : line.replace(/^\s*#{1,6}\s+/, "").trim();
}

function fileOf(slug: string): string {
  const bad = slugProblem(slug);
  // 不是防谁——名字是自己起的——而是**别让一个坏名字静静地写到目录外面去**。
  // 这里比别处更要紧：那个目录在你的博客仓库里。
  if (bad !== null) throw new Error(`「${slug}」不能当文件名：${bad}`);
  return `${slug}.md`;
}

export function createArticleStore(repoRoot: string, articlesDir: string, trashDir = ".trash"): ArticleStore {
  const dir = path.join(repoRoot, articlesDir);
  const at = (slug: string): string => path.join(dir, fileOf(slug));

  function parse(slug: string, text: string): Article {
    const fields = readFields(text);
    const body = bodyOf(text);
    return {
      slug,
      // **frontmatter 的 title 优先**：那 92 篇的正文里多半没有 H1，
      // 因为 Hugo 自己渲染标题（ADR-0005）。
      title: fields.title !== undefined ? bare(fields.title) : headingOf(body),
      date: fields.date === undefined ? undefined : bare(fields.date),
      // 没标记就是在架——那 92 篇里有的根本没有 draft 字段。
      draft: fields.draft?.trim() === "true",
      tags: readList(fields.tags),
      categories: readList(fields.categories),
      markdown: body,
    };
  }

  async function read(slug: string): Promise<Article | null> {
    const text = await readFile(at(slug), "utf8").catch(() => null);
    if (text === null) return null;
    const when = await stat(at(slug)).then((it) => it.mtimeMs, () => undefined);
    return { ...parse(slug, text), updatedAt: when };
  }

  return {
    async list() {
      const names = await readdir(dir).catch(() => [] as string[]);
      const all = await Promise.all(
        names
          .filter((name) => name.endsWith(".md") && !/^_index(?:\.|$)/.test(name))
          .map(async (name) => read(name.slice(0, -3)).catch(() => null)),
      );
      return all
        .filter((one): one is Article => one !== null)
        // 列表不带正文：92 篇里每篇几万字，列一次不该整篇拿在手上。
        .map(({ markdown, ...rest }) => ({ ...rest, html: isRawHtml(markdown) }))
        // 新的在前。没有日期的排最后——它多半是刚起的一篇，还没决定发不发。
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    },

    load: read,

    async save(article) {
      const file = at(article.slug);
      // **每次写之前确保目录在**：目录在那之后被删掉的话，之后每一次保存都 ENOENT，
      // 而人没有任何办法把它弄回来（`draft-store.ts` 为同一个理由这么做）。
      await mkdir(dir, { recursive: true });
      const had = await readFile(file, "utf8").catch(() => null);

      const fields: Record<string, string> = {
        title: quote(article.title),
        draft: String(article.draft),
      };
      if (article.date !== undefined) fields.date = quote(article.date);
      if (article.tags !== undefined) fields.tags = writeList(article.tags);
      if (article.categories !== undefined) fields.categories = writeList(article.categories);

      // 原来那份的 frontmatter 是底，只覆盖上面这几个键——**手写的字段一个都不动**。
      const base = had === null ? `---\n---\n\n${article.markdown}` : replaceBody(had, article.markdown);
      await writeFile(file, putFields(base, fields), "utf8");
    },

    async purge(now) {
      const dir = path.join(repoRoot, trashDir);
      // 没有这个目录是正常状态：还没丢过东西。
      const names = await readdir(dir).catch(() => [] as string[]);
      const gone: string[] = [];
      for (const name of names.filter((one) => one.endsWith(".md"))) {
        // **只看名字，不读文件**：清理要知道的只有「什么时候丢的」，而那就写在名字里。
        if (!expired({ at: parseTrashName(name)?.at ?? null }, now, KEEP_DAYS)) continue;
        await rm(path.join(dir, name), { force: true });
        gone.push(name);
      }
      return gone;
    },

    async trash(now) {
      // 打开回收站时也清一次：秒表可能刚好没轮到，而这一刻人正看着它。
      await this.purge(now);

      const dir = path.join(repoRoot, trashDir);
      const names = await readdir(dir).catch(() => [] as string[]);
      const all: Trashed[] = [];
      for (const name of names.filter((one) => one.endsWith(".md"))) {
        const parsed = parseTrashName(name);
        const fields = readFields(await readFile(path.join(dir, name), "utf8").catch(() => ""));
        all.push({
          name,
          slug: parsed?.slug ?? name.replace(/\.md$/, ""),
          at: parsed?.at ?? null,
          title: fields.title !== undefined ? bare(fields.title) : (parsed?.slug ?? name),
        });
      }
      // 新丢的在前。
      return all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    },

    async restore(name) {
      const parsed = parseTrashName(name);
      const slug = parsed?.slug ?? name.replace(/\.md$/, "");
      // **不覆盖。** 丢掉之后又写了一篇同名的，是最容易撞上的那种。
      if ((await read(slug)) !== null) throw new Error(`已经有一篇叫「${slug}」了，先给它换个地址`);
      await mkdir(dir, { recursive: true });
      await rename_(path.join(repoRoot, trashDir, name), at(slug));
      return slug;
    },

    async rename(from, to) {
      if ((await read(to)) !== null) throw new Error(`已经有一篇叫「${to}」了`);
      await rename_(at(from), at(to));
    },

    async remove(slug, now) {
      const trash = path.join(repoRoot, trashDir);
      await mkdir(trash, { recursive: true });
      /**
       * 时间戳前缀不是装饰：**同一个 slug 删两次，不能后一次盖掉前一次**
       * ——而「删了又写了一篇同名的，再删」恰恰是最容易发生的那种。
       */
      const name = trashNameOf(slug, now);
      await rename_(at(slug), path.join(trash, name));
      return path.join(trashDir, name);
    },
  };
}


/** frontmatter 之后的全部。没有 frontmatter 就是全文。 */
function bodyOf(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  const end = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
  return end === -1 ? text : lines.slice(end + 1).join("\n").replace(/^\r?\n/, "");
}

/** 换掉正文，frontmatter 原样留着（`putFields` 随后只改它要改的那几个键）。 */
function replaceBody(text: string, markdown: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return `---\n---\n\n${markdown}`;
  const end = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
  if (end === -1) return `---\n---\n\n${markdown}`;
  return [...lines.slice(0, end + 1), "", markdown].join("\n");
}

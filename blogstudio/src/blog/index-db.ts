import { DatabaseSync } from "node:sqlite";
import { byRecency, type ArticleStore, type ArticleSummary } from "./article-store";
import { imagesIn } from "./images";

/**
 * 文章索引。**它不是真相，文件才是**（ADR-0005 决策 6）。
 *
 * 判据写成了一条测试：**建好 → 删库 → 重扫 → 两次查询结果一模一样**。
 * 做不到，它就不是索引，是真相——而那意味着同时接下备份、schema 迁移、损坏恢复三件事。
 *
 * 用**内置的 `node:sqlite`**，不引 `better-sqlite3`：后者是原生模块，而
 * `pdfstudio/electron-builder.yml` 第 19 行是 `!node_modules/**`——原生模块是另一场仗。
 * 已实测 Electron 43（Node 24.18.1）里 `node:sqlite` 直接可用。
 */

export interface Index {
  /** 扫一遍统一目录，把表对齐到文件现在的样子。 */
  reindex(store: ArticleStore): Promise<void>;
  articles(): ArticleSummary[];
  /** **反向问**：这条 context 被哪几篇文章引用过。索引唯一能给、扫文件给不了的东西。 */
  citing(contextId: string): string[];
  /** 这张图被哪几篇用着。跟 `citing` 同一个形状——扫文件答不了的反向问题。 */
  using(image: string): string[];
  /** 每篇用了哪几张图。**「这次发布要传哪些图」就是从这儿算的。** */
  imagesOf(slugs: string[]): string[];
  /** 一张也没人用的那些。**只报，不删**——删图是人的决定。 */
  orphans(all: string[]): string[];
  /**
   * 标签空间：**`tags` 和 `categories` 合在一起**，按用得多的排前面。
   *
   * 合并不是偷懒。那 92 篇里 `inference`、`vllm`、`LLM` 在 `categories`，
   * `agent`、`算子`、`vllm源码` 在 `tags`——**找文章的人不关心这个区别**，
   * 而只筛一边会整个漏掉另一半词。Hugo 那边两个 taxonomy 照旧，互不影响。
   */
  labels(): [string, number][];
  /** 搜标题、标签、正文。**空串是「不筛」，由调用方处理**——这一层只管有词的情况。 */
  search(query: string): string[];
  close(): void;
}

/** 正文里的 `[ctx:xxx]`，以及上架之后藏在脚注里的 `<!-- ctx:xxx -->`。 */
const CITE = /\[ctx:([^\]\s]+)\]|<!--\s*ctx:([^\s>]+?)\s*-->/g;

export function citationsOf(markdown: string): string[] {
  const found = new Set<string>();
  for (const hit of markdown.matchAll(CITE)) found.add((hit[1] ?? hit[2])!);
  return [...found];
}

/**
 * 拿来搜的正文：**剥掉 HTML 标签**。
 *
 * 不剥的话，那 87 篇里满是 `<p style="">`，搜 "style"、"width"、"px" 会命中所有文章
 * ——而那种结果比没有结果更糟，因为它看起来像是搜到了。
 *
 * 不转小写：`like` 那一侧已经不区分大小写了（见 `search`）。
 */
const searchable = (markdown: string): string =>
  markdown.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/**
 * schema 的版本。**加一列、改一张表，就把这个数字加一。**
 *
 * `create table if not exists` 不会给已有的表补列——所以老库会带着老 schema 一直用下去，
 * 直到某个查询报「no column named html」。实际就是这么撞上的。
 *
 * 解法不是写迁移，是**整个重建**：索引里没有任何找不回来的东西（ADR-0005 决策 6），
 * 而写迁移意味着从此要维护一条只增不减的迁移链——为一份随时能从文件重扫出来的缓存
 * 背那个，不划算。
 */
const SCHEMA = 3;

/** 正则里的特殊字符。查询词是人打进来的，`c++` 里那两个加号不该被当成量词。 */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 要不要按词匹配。**两头都是英数字才算**——那时候子串会把 `rl` 匹到 `url` 上。
 * 中文（以及以标点开头结尾的词）回 `null`，走子串。
 */
function boundary(query: string): RegExp | null {
  if (!/^[A-Za-z0-9]/.test(query) || !/[A-Za-z0-9]$/.test(query)) return null;
  return new RegExp(`(^|[^A-Za-z0-9])${escaped(query)}([^A-Za-z0-9]|$)`, "i");
}

export function openIndex(file: string): Index {
  const db = new DatabaseSync(file);

  const [{ user_version: had } = { user_version: 0 }] = db
    .prepare("pragma user_version")
    .all() as { user_version: number }[];
  if (had !== SCHEMA) {
    // 老版本（或全新的库）：推倒重来。下一次 `reindex` 会把它填满。
    db.exec("drop table if exists articles; drop table if exists citations; drop table if exists uses;");
    db.exec(`pragma user_version = ${SCHEMA}`);
  }

  db.exec(`
    create table if not exists articles (
      slug text primary key,
      title text not null,
      date text,
      draft integer not null,
      tags text,
      categories text,
      html integer not null default 0,
      -- 文件的改动时刻（毫秒）。没有 date 的那些靠它排序（article-store 的 recencyOf）。
      updated_at real,
      -- 搜正文用：剥掉 HTML 标签、转小写。不剥的话搜 style 会命中所有文章
      -- （那 87 篇正文里满是 p style=""）。见下面的 searchable。
      body text not null default ''
    );
    create table if not exists citations (
      slug text not null,
      context_id text not null,
      primary key (slug, context_id)
    );
    create table if not exists uses (
      slug text not null,
      image text not null,
      primary key (slug, image)
    );
  `);

  const list = (value: string | null): string[] | undefined =>
    value === null ? undefined : (JSON.parse(value) as string[]);

  return {
    async reindex(store) {
      const all = await store.list();

      /**
       * **整表重写，不做增量。**
       *
       * 增量要比 mtime/hash、要处理改名、要处理「文件没了」，而那 92 篇全量扫一遍
       * 是毫秒级的。省下的那点时间换来的是一整类「索引和文件对不上」的错，
       * 而那类错**不报错，只是显示得不对**。哪天真的慢了再说。
       */
      db.exec("begin");
      try {
        db.exec("delete from articles");
        db.exec("delete from citations");
        db.exec("delete from uses");
        const put = db.prepare(
          "insert into articles (slug,title,date,draft,tags,categories,html,updated_at,body) values (?,?,?,?,?,?,?,?,?)",
        );
        const cite = db.prepare("insert or ignore into citations (slug,context_id) values (?,?)");
        const uses = db.prepare("insert or ignore into uses (slug,image) values (?,?)");
        for (const one of all) {
          put.run(
            one.slug,
            one.title,
            one.date ?? null,
            one.draft ? 1 : 0,
            one.tags === undefined ? null : JSON.stringify(one.tags),
            one.categories === undefined ? null : JSON.stringify(one.categories),
            one.html ? 1 : 0,
            one.updatedAt ?? null,
            "",
          );
          // 引用要读正文，所以这一步比列表贵——但它是这张索引存在的理由。
          const full = await store.load(one.slug);
          const body = full?.markdown ?? "";
          for (const id of citationsOf(body)) cite.run(one.slug, id);
          for (const image of imagesIn(body)) uses.run(one.slug, image);
          db.prepare("update articles set body = ? where slug = ?").run(searchable(body), one.slug);
        }
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },

    articles() {
      // 新的在前，与 `ArticleStore.list` 同一个顺序（`byRecency`）——两处不一样的话，
      // 界面在「刚扫过」和「还没扫」之间会跳。百来行，在 JS 里排。
      const rows = db.prepare("select * from articles").all() as Record<string, string | number | null>[];
      return rows
        .map((row) => ({
          slug: row.slug as string,
          title: row.title as string,
          date: (row.date as string | null) ?? undefined,
          draft: row.draft === 1,
          // 正文是原始 HTML 的那 87 篇：列表要能一眼标出来，它们在编辑器里改不得。
          html: row.html === 1,
          tags: list(row.tags as string | null),
          categories: list(row.categories as string | null),
          updatedAt: (row.updated_at as number | null) ?? undefined,
        }))
        .sort(byRecency);
    },

    citing(contextId) {
      const rows = db
        .prepare("select slug from citations where context_id = ?")
        .all(contextId) as { slug: string }[];
      return rows.map((row) => row.slug);
    },

    using(image) {
      const rows = db.prepare("select slug from uses where image = ?").all(image) as { slug: string }[];
      return rows.map((row) => row.slug);
    },

    imagesOf(slugs) {
      // 不用给空数组开小灶：SQLite 接受 `in ()` 并且回 0 行——变异测试证明那个守卫
      // 一个字都不改变。空集合就是「一张都不要」，不是通配，测试钉着这一条。
      const holes = slugs.map(() => "?").join(",");
      const rows = db
        .prepare(`select distinct image from uses where slug in (${holes})`)
        .all(...slugs) as { image: string }[];
      return rows.map((row) => row.image);
    },

    orphans(all) {
      const used = new Set(
        (db.prepare("select distinct image from uses").all() as { image: string }[]).map((row) => row.image),
      );
      // **只报，不删。** 一张图今天没人用，可能是某篇还在下架、也可能是你刚删错了一段。
      return all.filter((one) => !used.has(one));
    },

    labels() {
      const counted = new Map<string, number>();
      for (const one of this.articles()) {
        // 同一篇里 tags 和 categories 撞了同一个词，只算一次。
        for (const name of new Set([...(one.tags ?? []), ...(one.categories ?? [])])) {
          counted.set(name, (counted.get(name) ?? 0) + 1);
        }
      }
      // 用得多的排前面——一天要点好几次的那几个不该藏在后面。
      return [...counted].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },

    search(query) {
      const q = `%${query.trim()}%`;
      /**
       * 标题、标签、正文各查一遍。
       *
       * **大小写靠 SQLite 自己**：它的 `like` 对 ASCII 默认就不区分大小写
       * （写文章的人一会儿 SGLang 一会儿 sglang），而中文本来就没有大小写。
       * 我原来在这儿和 `searchable` 里各转了一次小写——变异测试证明那三处
       * 一个字都不改变，删了。
       */
      const rows = db
        .prepare(
          `select slug, title, coalesce(tags,'') tags, coalesce(categories,'') cats, body from articles
           where title like ?1
              or coalesce(tags,'') like ?1
              or coalesce(categories,'') like ?1
              or body like ?1`,
        )
        .all(q) as { slug: string; title: string; tags: string; cats: string; body: string }[];

      /**
       * **英文按词、中文按子串。**
       *
       * 子串匹配对短英文词是灾难：实测搜 `rl` 会命中 26 篇，而独立的 `rl` 一篇都没有
       * ——全是 `url` / `curl` / `world`。而中文没有词边界，「算子」必须能在
       * 「通信算子优化」里搜到，所以那一侧只能是子串。
       *
       * 判据是「这个词两头是不是英数字」，不是「整串是不是 ASCII」：`cuda/Triton`
       * 两头都是字母，照样按词找；而 `算子` 走子串。
       */
      const word = boundary(query.trim());
      if (word === null) return rows.map((row) => row.slug);
      return rows
        .filter((row) => word.test(`${row.title}\n${row.tags}\n${row.cats}\n${row.body}`))
        .map((row) => row.slug);
    },

    close: () => db.close(),
  };
}

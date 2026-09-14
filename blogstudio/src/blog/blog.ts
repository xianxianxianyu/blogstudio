import path from "node:path";
import type { ArticleSection } from "../publish/scope";
import type { Context } from "../../../contextstudio/src/context";
import type { Config } from "../publish/publish-store";
import { createArticleStore, type Article, type ArticleStore, type Trashed } from "./article-store";
import { createImageStore, type ImageStore } from "./images";
import { openIndex, type Index } from "./index-db";
import { promote, retag, withdraw } from "./operations";

/**
 * 博客这一侧的应用层：**文章库 + 索引**接在一起。
 *
 * 三个操作在这儿落盘并重扫索引。它们**一个字节都不出这台机器**——云端只在
 * 你按「同步」那一下才变（`deploy.ts` 的 `syncOnly`）。
 */
export interface Blog {
  articles: ArticleStore;
  /** 图片跟文章住在同一个仓库里，走同一条同步链路（`images.ts`）。 */
  images: ImageStore;
  index: Index;
  /** 每次改完文件都重扫。92 篇全量扫一遍是毫秒级的，换来的是「索引永远对得上」。 */
  refresh(): Promise<void>;
  retag(slug: string, tags: string[]): Promise<void>;
  withdraw(slug: string, draft: boolean): Promise<void>;
  promote(slug: string, pool: Context[], now: number): Promise<{ missing: string[] }>;
  remove(slug: string, now: number): Promise<string>;
  /** 换地址。**在架的不许换**——那等于公网上换 URL，旧链接全断。 */
  rename(slug: string, to: string): Promise<void>;
  /** 回收站里有什么。**顺手清掉超过一个月的**。 */
  trash(now: number): Promise<Trashed[]>;
  /** 只清不列。秒表走的是这条。 */
  purge(now: number): Promise<string[]>;
  /** 从回收站放回来，返回它的 slug。 */
  restore(name: string): Promise<string>;
  /**
   * 一张也没人用的图。**只报，不删**——一张图今天没人用，可能是某篇还在下架、
   * 也可能是你刚删错了一段。删是下面那个动作，人按的。
   */
  orphanImages(): Promise<string[]>;
  /** 删一张**没人用的**图。有人用就拒绝：那是页面上的一张破图。 */
  removeImage(name: string): Promise<void>;
  close(): void;
}

export function createBlog(config: Config, dbFile: string, section: ArticleSection = "blog"): Blog {
  const articles = createArticleStore(config.repo, section === "blog" ? config.articles : `${config.site}/content/projects`, section === "blog" ? ".trash" : ".trash/projects");
  // 图片落在 Hugo 的 static 下：它把 `static/` 原样拷进产物，所以图片不需要任何
  // 额外的管道——跟文章走完全同一条路。
  const images = createImageStore(config.repo, `${config.site}/static/images`);
  const index = openIndex(dbFile);

  const refresh = () => index.reindex(articles);

  /** 读一篇、改一篇、存回去、重扫。三个操作的共同形状。 */
  async function edit(slug: string, change: (one: Article) => Article): Promise<void> {
    const one = await articles.load(slug);
    if (one === null) throw new Error(`没有「${slug}」这一篇`);
    await articles.save(change(one));
    await refresh();
  }

  return {
    articles,
    images,
    index,
    refresh,
    retag: (slug, tags) => edit(slug, (one) => retag(one, tags)),
    withdraw: (slug, draft) => edit(slug, (one) => withdraw(one, draft)),

    async promote(slug, pool, now) {
      const one = await articles.load(slug);
      if (one === null) throw new Error(`没有「${slug}」这一篇`);
      // 时区偏移在这一侧取：文章的日期该是**你的**日期，不是 UTC。
      const { missing, ...next } = promote(one, pool, now, -new Date(now).getTimezoneOffset());
      await articles.save(next);
      await refresh();
      return { missing };
    },

    async rename(slug, to) {
      const one = await articles.load(slug);
      if (one === null) throw new Error(`没有「${slug}」这一篇`);
      // **拦在这一层**：`ArticleStore.rename` 只管搬文件，它不知道什么叫「在架」。
      if (!one.draft) throw new Error("在架的文章不能换地址——先下架，换完再上架");
      await articles.rename(slug, to);
      await refresh();
    },

    trash: (now) => articles.trash(now),
    purge: (now) => articles.purge(now),

    async restore(name) {
      const slug = await articles.restore(name);
      await refresh();
      return slug;
    },

    async remove(slug, now) {
      const where = await articles.remove(slug, now);
      await refresh();
      return where;
    },

    async orphanImages() {
      // 先重扫：正文可能刚在别的编辑器里改过，索引里那份「谁用了哪张」是上一次的。
      await refresh();
      return index.orphans(await images.list());
    },

    async removeImage(name) {
      await refresh();
      const users = index.using(name);
      if (users.length > 0) throw new Error(`「${name}」还被 ${users.join("、")} 用着，不能删`);
      await images.remove(name);
    },

    close: () => index.close(),
  };
}

/** 索引落在数据目录里，与统一目录**分开**——它是可重建的缓存，不该混进你的仓库。 */
export const indexFileOf = (dataRoot: string): string => path.join(dataRoot, "blog-index.db");

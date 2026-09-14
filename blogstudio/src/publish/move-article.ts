import { mkdir, link, unlink } from "node:fs/promises";
import path from "node:path";
import { createArticleStore } from "../blog/article-store";
import type { Config } from "./publish-store";
import { articleSection } from "./scope";

/** 草稿换栏目，保留原始 frontmatter 与正文；已发表文章的地址保持稳定。 */
export async function moveArticle(config: Config, slug: string, from: unknown, to: unknown) {
  const source = articleSection(from), target = articleSection(to);
  if (source === target) return;
  const dir = (section: string) => section === "blog" ? config.articles : `${config.site}/content/projects`;
  const article = await createArticleStore(config.repo, dir(source)).load(slug);
  if (!article) throw new Error("文章不存在");
  if (!article.draft) throw new Error("请先下架，再修改文章所属栏目");
  const root = path.join(config.repo, dir(target));
  await mkdir(root, { recursive: true });
  const original = path.join(config.repo, dir(source), `${slug}.md`);
  // link 遇到同名文件会失败，不覆盖已有文章。
  await link(original, path.join(root, `${slug}.md`));
  await unlink(original);
}

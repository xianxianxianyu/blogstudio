/** Export 的发布范围。推荐由独立流程维护，旧地址和其资源也一起保护。 */
export const EXPORT_EXCLUDES = [
  "/recommend/", "/en/recommend/", "/loop/", "/en/loop/",
  "/css/loop.*", "/js/loop.*", "/upload/",
];

export type ArticleSection = "blog" | "projects";

export function articleSection(value: unknown): ArticleSection {
  if (value === null || value === undefined || value === "blog") return "blog";
  if (value === "projects") return "projects";
  throw new Error("文章只能发布到 Blog 或 Project");
}

/**
 * 带时区偏移的时刻，Hugo 的 `date` 要的那种格式。
 *
 * 上一版这个文件还管「更新一篇已经在博客里的文章时，手写过的字段一个都不动」
 * （`mergeFrontmatter`）。那是按稿子发布那条路的东西，ADR-0005 之后统一目录里的文章
 * 由 `fields.ts` 按行改，那一套删掉了；这里只剩时间格式这一件事。
 */

/** 两位数补零。 */
const two = (n: number): string => String(n).padStart(2, "0");

/**
 * 带时区偏移的时刻，Hugo 要的那种格式。
 *
 * **不能用 `toISOString()`**：那个给的是 `Z` 结尾的 UTC，而 Hugo 会照着 UTC 排文章的
 * 日期——晚上八点发的文章会显示成中午十二点，跨日的时候连日期都是错的。
 *
 * `offsetMinutes` 由调用方给（`-new Date().getTimezoneOffset()`），这一层不碰时钟。
 */
export function isoAt(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const size = Math.abs(offsetMinutes);
  const stamp =
    `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}` +
    `T${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
  return `${stamp}${sign}${two(Math.floor(size / 60))}:${two(size % 60)}`;
}

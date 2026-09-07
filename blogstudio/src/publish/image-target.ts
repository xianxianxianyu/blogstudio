/**
 * 一个去处的**图片**去哪。跟正文去哪是两件事——这正是「针对性上传」的意思。
 *
 * 两个站的 HTML 逐字节相同，都写 `/images/x.png`；变的只是**谁来发这些字节**：
 *
 * | 去处 | 正文 | 图片 |
 * |---|---|---|
 * | `moyutianzun.com`（日本，带宽好） | rsync | **跟着 rsync 一起走**，本地文件 |
 * | `moyutianzun.cn`（阿里云，实测 3.3 Mbps） | rsync（`--exclude images/`） | **传 OSS**，服务器 302 弹过去 |
 */
export interface ImageTarget {
  /** 那边现在有哪些图（文件名）。**问它要，不猜**——跟 rsync 干跑同一个道理。 */
  list(): Promise<string[]>;
  /** 把这几张传上去。**只增不删**，见下。 */
  put(localDir: string, names: string[]): Promise<void>;
}

/**
 * 这次要传哪几张。
 *
 * **只算差集，不算删除。** 跟正文那一侧的 `--delete` 故意不对称：
 *
 * - 正文是整站重建的产物，本地没有的就该从云端消失。
 * - 图片不是。`.cn` 那边 OSS 上那 231 张是它唯一的图源；某一篇临时下架、或者你刚删了
 *   一段又要撤回，都会让一张图**暂时**没人引用——照着删就是把线上页面弄坏。
 *
 * 清理孤儿是一个**单独的、人按下去的**动作（`index.orphans` 只报不删），不该混在
 * 每一次发布里顺手做掉。
 */
export function imagesToUpload(needed: string[], there: string[]): string[] {
  const has = new Set(there);
  return needed.filter((one) => !has.has(one)).sort();
}

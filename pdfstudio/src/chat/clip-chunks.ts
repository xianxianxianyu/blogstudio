import type { Clip } from "../clip/clip";
import type { Tag } from "../tag/tag";
import type { Chunk } from "./retrieval";

/**
 * 把摘录变成可检索的块。
 *
 * 这不是给检索多接一个数据源，是**补上它的盲区**：`chunking.ts` 索引的是 pdf.js 的
 * 文本层，而那一层恰好在最需要检索的地方是空的——
 *
 *   公式  文本层给乱码或什么都不给（正是我们走视觉路由的原因） 摘录里是 LaTeX
 *   图表  文本层没有                                          摘录里是图像描述
 *   译文  文本层没有                                          摘录里有
 *   笔记  文本层没有                                          摘录里有
 *
 * 所以摘录不是 PDF 正文的子集，在最关键的地方是超集。
 */

/**
 * **文本路由的原文不进索引。**
 *
 * 它逐字来自文本层，文档索引里已经有同一段话了。再塞一份不带来任何可检索的新信息，
 * 只会让同一段内容占掉两个位置，还往背景分布里掺水——而 abstention 的门槛
 * （`MIN_PEAK_MARGIN`）正是按背景分布标定出来的。
 *
 * 视觉路由的原文则相反：LaTeX 与图中标签是文本层给不出的东西。
 */
function retrievableText(clip: Clip): string[] {
  if (clip.content === null) return [];

  return [
    clip.content.route === "vision" ? clip.sourceText : null,
    clip.translation,
    clip.note,
    clip.content.multimodal ?? null,
  ].filter((text): text is string => text !== null && text.trim() !== "");
}

/**
 * 一条摘录出一个块，不再切。
 *
 * 摘录本来就是读者框出来的一小块，远短于 `CHUNK_CHARS`（600）——再走一遍
 * `chunkDocument` 的读序还原与重叠切分，输入是它自己拼出来的字符串而不是带坐标的
 * TextItem，那套逻辑无从施展，只会白跑一趟。
 *
 * 空白一律不产出块：空块对任何查询都不命中，却会进背景分布把中位数拉低，于是
 * `peakMargin` 虚高——**看起来更有把握，其实只是掺了水**。
 */
export function clipChunks(clips: Clip[], tags: Tag[] = []): Chunk[] {
  const chunks: Chunk[] = [];
  const nameOf = (clip: Clip) =>
    tags.find((tag) => tag.id === clip.tagId)?.name ?? null;

  for (const clip of clips) {
    // 墓碑（content 为 null）与还没识别完的都在这里被滤掉：
    // 保留规则即索引规则（ADR-0012 边界），内容过期，索引项随之过期。
    const parts = retrievableText(clip);
    if (parts.join("").trim() === "") continue;
    // 标签名进检索文本——是不是值得，由 eval 决定，见文件末尾。
    const name = nameOf(clip);
    const text = (name === null ? parts : [name, ...parts]).join("\n\n");
    chunks.push({ page: clip.region.page, text, clipId: clip.id });
  }

  return chunks;
}

/**
 * ## 标签名为什么进了检索文本
 *
 * 本来是有理由不加的：上面那条注释说文本路由的原文**故意不进索引**，因为重复内容会
 * 往背景分布掺水，而 abstention 的门槛（`MIN_PEAK_MARGIN`）正是按背景分布标定出来
 * 的——刚从 0.10 重标到 0.15。一个 2–4 字的名字附在**每一条**摘录块上，风险是同一个。
 *
 * 所以先量了再定（`eval/retrieval` 的 `tg-*`，退化问句，除标签名外没有任何主题词）：
 *
 *   标签题 recall@3   0/4 → 3/4     基线那 4 条**全部 abstain**，一条都没检索到
 *   摘录题 / 追问题   6/6 / 9/9     不动
 *   abstention        2/2 → 2/2     不动
 *   中文 margin 中位  0.236 → 0.231
 *   答不了 margin 中位 0.127 → 0.127 不动
 *   权衡曲线          每一档完全一样
 *
 * 掺水没有发生。收益大、代价量不出来，所以加。
 *
 * 唯一没救回来的是 tg-04（「标成要点的那些图表都在说什么」）：yellow 挂在 18 条里的
 * 7 条上，**没有哪一条能形成尖峰**，于是判据照常 abstain。这是对的行为——成员太多的
 * 标签本来就不该靠语义检索找，那是**筛选**要干的事（右栏那排颜色点）。
 */

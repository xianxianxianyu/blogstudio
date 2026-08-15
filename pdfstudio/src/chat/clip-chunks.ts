import type { Clip } from "../clip/clip";
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
export function clipChunks(clips: Clip[]): Chunk[] {
  const chunks: Chunk[] = [];

  for (const clip of clips) {
    // 墓碑（content 为 null）与还没识别完的都在这里被滤掉：
    // 保留规则即索引规则（ADR-0012 边界），内容过期，索引项随之过期。
    const text = retrievableText(clip).join("\n\n");
    if (text.trim() === "") continue;
    chunks.push({ page: clip.region.page, text, clipId: clip.id });
  }

  return chunks;
}

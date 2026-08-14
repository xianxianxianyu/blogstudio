import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Embedder } from "../model/embedder";
import { chunkDocument } from "./chunking";

// Chat 的**内部缝**：`chat-retrieval-interface.md` 判定 Retrieval 不独立成模块，
// 所以这三个文件都不从 `chat.ts` 再导出去。将来真出现第二个调用方时原样提级即可，
// `ask` 的签名不动。
//
// 拆成三块，各自一个变更理由：
//   chunking.ts  读序还原与切块——换切块策略只动它
//   ranking.ts   打分、融合、命中判据——换检索算法只动它
//   本文件       把两者接起来，外加建索引时的 embedding

/** 索引的最小单位。切块策略是内部缝，调用方只看得到 citation。 */
export interface Chunk {
  page: number;
  text: string;
  /** 配了 embedder 才有。没有就退回关键词打分。 */
  vector?: Float32Array;
}

export { searchChunks, scoreChunks, peakMargin } from "./ranking";
export type { ScoredChunk } from "./ranking";

export async function buildIndex(
  document: PDFDocumentProxy,
  embedder?: Embedder,
): Promise<Chunk[]> {
  const chunks = await chunkDocument(document);

  if (embedder) {
    const vectors = await embedder.embedDocuments(chunks.map((chunk) => chunk.text));
    chunks.forEach((chunk, index) => (chunk.vector = vectors[index]));
  }

  return chunks;
}

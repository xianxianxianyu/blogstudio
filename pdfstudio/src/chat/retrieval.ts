import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

// Chat 的**内部缝**：`chat-retrieval-interface.md` 判定 Retrieval 不独立成模块，
// 所以这个文件不从 `chat.ts` 再导出去。将来真出现第二个调用方时原样提级即可，
// `ask` 的签名不动。

/** 索引的最小单位。切块策略是内部缝，调用方只看得到 citation。 */
export interface Chunk {
  page: number;
  text: string;
}

const CHUNK_CHARS = 600;

/**
 * 读序还原目前还是 pdf.js 的原始顺序——双栏页会把左右栏交错读进来。
 * 那是 architecture.md 点名的「分块缺口」，等一条真实的双栏反例来驱动。
 */
export async function buildIndex(document: PDFDocumentProxy): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  for (let page = 1; page <= document.numPages; page++) {
    const { items } = await (await document.getPage(page)).getTextContent();
    const text = items
      .filter((item): item is TextItem => "str" in item)
      .map((item) => (item.hasEOL ? `${item.str}\n` : item.str))
      .join("");

    for (let start = 0; start < text.length; start += CHUNK_CHARS) {
      const slice = text.slice(start, start + CHUNK_CHARS).trim();
      if (slice !== "") chunks.push({ page, text: slice });
    }
  }

  return chunks;
}

/**
 * 关键词检索。这是**已知不够用**的基线：读者用中文问英文论文时它一分也打不出来，
 * 而那正是 ADR-0003 选 bge-m3 的理由。等跨语言那条红灯来驱动再换。
 */
export function searchChunks(chunks: Chunk[], query: string, limit = 1): Chunk[] {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
  const haystacks = chunks.map((chunk) => chunk.text.toLowerCase());

  // 在过半块里都出现的词没有区分度（the / what / with…）。拿它们当命中，
  // 任何问题都会「检索到」一段无关原文，grounding 就成了谎话。
  const distinctive = terms.filter(
    (term) => haystacks.filter((text) => text.includes(term)).length * 2 <= chunks.length,
  );
  if (distinctive.length === 0) return [];

  return chunks
    .map((chunk, index) => ({
      chunk,
      score: distinctive.filter((term) => haystacks[index].includes(term)).length,
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((scored) => scored.chunk);
}


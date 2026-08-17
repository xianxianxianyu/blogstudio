import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { inReadingOrder, toLines, type Line } from "../pdf/lines";
import type { Chunk } from "./retrieval";

// 切块：PDF 文本层 → 有页码的文本块。
// 与打分完全无关——换检索算法不动这个文件，换切块策略不动 ranking.ts。
//
// 聚行与读序还原搬去了 `pdf/lines.ts`：文本流选择也要判双栏，而那个 0.3 的阈值
// 对实测 0.298 只差 0.002，不能有第二份。

/** 一块目标大小。只在行边界上切，宁可略微超出也不切断一行。 */
const CHUNK_CHARS = 600;

/** 相邻块重叠的行数：一句话跨块边界时，两块里至少有一块是完整的。 */
const OVERLAP_LINES = 2;

/** 只在行边界上切，并让相邻块重叠若干行——一句话跨边界时不至于两块都残缺。 */
function packLines(lines: Line[], page: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let size = 0;

  const flush = () => {
    const text = current.join("\n").trim();
    if (text !== "") chunks.push({ page, text });
  };

  for (const line of lines) {
    if (size > 0 && size + line.text.length > CHUNK_CHARS) {
      flush();
      current = current.slice(-OVERLAP_LINES);
      size = current.reduce((total, text) => total + text.length, 0);
    }
    current.push(line.text);
    size += line.text.length;
  }
  flush();

  return chunks;
}

export async function chunkDocument(document: PDFDocumentProxy): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  for (let page = 1; page <= document.numPages; page++) {
    const loaded = await document.getPage(page);
    const { items } = await loaded.getTextContent();
    // view 是 [x0, y0, x1, y1]，页宽是 x1 - x0——带 CropBox 偏移的 PDF 上 x0 不为 0。
    const [x0, , x1] = loaded.view;

    const lines = inReadingOrder(
      toLines(items.filter((item): item is TextItem => "str" in item)),
      x0,
      x1,
    );
    chunks.push(...packLines(lines, page));
  }

  return chunks;
}

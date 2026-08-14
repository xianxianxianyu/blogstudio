import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { cosineSimilarity } from "../model/embedder";
import type { Embedder } from "../model/embedder";

// Chat 的**内部缝**：`chat-retrieval-interface.md` 判定 Retrieval 不独立成模块，
// 所以这个文件不从 `chat.ts` 再导出去。将来真出现第二个调用方时原样提级即可，
// `ask` 的签名不动。

/** 索引的最小单位。切块策略是内部缝，调用方只看得到 citation。 */
export interface Chunk {
  page: number;
  text: string;
  /** 配了 embedder 才有。没有就退回关键词打分。 */
  vector?: Float32Array;
}

/**
 * 向量检索的相似度下限。低于它就当没检索到，`grounding` 才能诚实地报 `none`。
 *
 * 关键词检索天然有这个下限（没有区分度的词一个都不匹配就返回空），向量检索没有
 * ——任何两段文本都有一个余弦值。不设下限的话，`eval/retrieval/` 那 3 条
 * 「文档答不了」的题会全部被硬凑出一段原文当出处，而那是不变量⑤ 明令禁止的。
 *
 * 0.5 是待标定的初值，用 `npm run eval:retrieval` 的 abstention 与中文 recall
 * 一起定——两者是此消彼长的，只看一个会调歪。
 */
const MIN_SIMILARITY = 0.5;

/** 一块目标大小。只在行边界上切，宁可略微超出也不切断一行。 */
const CHUNK_CHARS = 600;

/** 相邻块重叠的行数：一句话跨块边界时，两块里至少有一块是完整的。 */
const OVERLAP_LINES = 2;

interface Line {
  /** 基线 y，越大越靠上（PDF 坐标原点在左下）。 */
  y: number;
  /** 行的左右边界。 */
  x0: number;
  x1: number;
  text: string;
}

/** 把 item 按基线聚成行。同一行的 item 基线相同（允许极小抖动）。 */
function toLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];

  for (const item of items) {
    if (item.str.trim() === "") continue;
    const [a, b, , , x, y] = item.transform;
    const length = Math.hypot(a, b) || 1;
    const endX = x + (item.width * a) / length;

    const existing = lines.find((line) => Math.abs(line.y - y) < 2);
    if (existing) {
      existing.text += item.str;
      existing.x0 = Math.min(existing.x0, x, endX);
      existing.x1 = Math.max(existing.x1, x, endX);
    } else {
      lines.push({ y, x0: Math.min(x, endX), x1: Math.max(x, endX), text: item.str });
    }
  }

  return lines;
}

/**
 * 双栏检测：看有多少行横跨页面中线。
 *
 * 单栏页的正文行几乎都跨中线（左边距到右边距），双栏页的行都在自己那一栏里。
 * 所以「跨线行占比低」就是双栏。这比按 x 直方图找栏沟稳——图内标签、坐标轴文字
 * 会把直方图打乱，但它们同样不跨中线，不影响这个判据。
 */
function isTwoColumn(lines: Line[], middle: number): boolean {
  if (lines.length === 0) return false;
  const crossing = lines.filter((line) => line.x0 < middle && line.x1 > middle).length;
  return crossing / lines.length < 0.3;
}

/**
 * 读序还原：双栏页先读完左栏再读右栏，栏内自上而下。
 *
 * 不还原的话，pdf.js 的原始顺序会把右栏内容插进左栏正文中间——ResNet p.8 上
 * 一句完整的因果句就被隔壁栏的表格图题劈开了，读者看到的 citation 是拼接的。
 */
function inReadingOrder(lines: Line[], pageWidth: number): Line[] {
  const middle = pageWidth / 2;
  const topDown = (a: Line, b: Line) => b.y - a.y || a.x0 - b.x0;

  if (!isTwoColumn(lines, middle)) return [...lines].sort(topDown);

  // 按行的中点归栏。真正跨栏的东西（跨栏图题、大标题）中点也在中间附近，
  // 归到哪一栏都不会劈断正文——那才是要防的事。
  const center = (line: Line) => (line.x0 + line.x1) / 2;
  return [
    ...lines.filter((line) => center(line) < middle).sort(topDown),
    ...lines.filter((line) => center(line) >= middle).sort(topDown),
  ];
}

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

export async function buildIndex(
  document: PDFDocumentProxy,
  embedder?: Embedder,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  for (let page = 1; page <= document.numPages; page++) {
    const loaded = await document.getPage(page);
    const { items } = await loaded.getTextContent();
    const [, , pageWidth] = loaded.view;

    const lines = inReadingOrder(
      toLines(items.filter((item): item is TextItem => "str" in item)),
      pageWidth,
    );
    chunks.push(...packLines(lines, page));
  }

  if (embedder) {
    const vectors = await embedder.embedDocuments(chunks.map((chunk) => chunk.text));
    chunks.forEach((chunk, index) => (chunk.vector = vectors[index]));
  }

  return chunks;
}

/**
 * 关键词检索。这是**已知不够用**的基线：读者用中文问英文论文时它一分也打不出来
 * （`eval/retrieval/` 实测中文 recall@3 为 0%、英文 100%），
 * 而那正是 ADR-0003 选多语言 embedding 的理由。等跨语言那条红灯来驱动再换。
 */
export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/**
 * 向量打分，按分数降序。**不施加下限**——下限由调用方给。
 *
 * 单独导出是给 eval 扫阈值用：一次打分、多个阈值，不必为每个阈值重跑 embedding。
 * 这样 eval 与生产走的是同一段排序逻辑，不会各自漂。
 */
export async function scoreChunks(
  chunks: Chunk[],
  query: string,
  embedder: Embedder,
): Promise<ScoredChunk[]> {
  const queryVector = await embedder.embedQuery(query);
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector!) }))
    .sort((a, b) => b.score - a.score);
}

export async function searchChunks(
  chunks: Chunk[],
  query: string,
  limit = 1,
  embedder?: Embedder,
  minSimilarity = MIN_SIMILARITY,
): Promise<Chunk[]> {
  if (embedder && chunks.every((chunk) => chunk.vector)) {
    return (await scoreChunks(chunks, query, embedder))
      .filter((scored) => scored.score >= minSimilarity)
      .slice(0, limit)
      .map((scored) => scored.chunk);
  }

  return keywordSearch(chunks, query, limit);
}

function keywordSearch(chunks: Chunk[], query: string, limit: number): Chunk[] {
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

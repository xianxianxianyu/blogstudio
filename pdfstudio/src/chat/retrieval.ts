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

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/**
 * 命中判据：top-1 要比**背景分布**高出这么多，才算检索到。
 *
 * 一开始用的是绝对余弦下限，实测证明那个机制不成立（`eval/retrieval/`）：
 *
 *     阈值 0.30–0.60  中文 recall@3 85%   答不了正确返回空 0/3
 *     阈值 0.70       中文 recall@3 40%   答不了正确返回空 2/3
 *
 * **任何一条横线都切不开。** 因为归一化之后，一个 ML 领域的中文问题跟任何一段
 * ML 论文都有不低的相似度——「法国的首都」与「残差网络」的余弦值，和「退化问题」
 * 与「残差网络」的余弦值，差距没有大到能用绝对阈值分开。而绝对量纲还是模型相关、
 * 领域相关的，换个模型就要重标。
 *
 * 改成相对判据：答得了的题有明显尖峰（top-1 远高于中位数），答不了的题 top-1 跟
 * 中位数差不多。这个判据与模型和领域都无关。
 *
 * 不这么做的后果是实的：不变量⑤ 要求「没有可靠依据必须 grounding: 'none'」，
 * 而绝对阈值下三条答不了的题全部被硬凑出一段原文当出处——那是在编造引用。
 */
const MIN_PEAK_MARGIN = 0.1;

/*
 * 0.10 由 `npm run eval:retrieval -- --embed` 标定，是曲线上的支配点：
 *
 *   margin  zh@1   zh@3   en@3   abstention
 *   0.10   60.0%  80.0% 100.0%   2/3   ← 当前取值
 *   0.12   40.0%  60.0%  83.3%   2/3
 *   0.15   10.0%  15.0%  83.3%   3/3
 *
 * 换判据把代价降了一个量级：同样拿到 2/3 的 abstention，绝对阈值要把 zh@3 砍到
 * 40%，尖峰判据只掉到 80%。
 *
 * **但两组仍未完全分开**，这条得记着：
 *
 *   中文题   margin 最低 0.079  中位 0.128  最高 0.215
 *   答不了   margin 最低 0.073  中位 0.083  最高 0.145
 *
 * 「答不了」的最高值压过了中文题的中位数——有一条答不了的题，尖峰比一半真问题还
 * 明显。所以 3 条里仍有 1 条会被硬凑出出处，不变量⑤ 没有完全守住。单靠相似度这
 * 一个信号到头了，下一步要 hybrid：关键词那一路能提供一个独立的信号
 * （答不了的题往往两路都没有支持）。
 *
 * 另外 abstention 只有 3 条题，2/3 与 3/3 差一道题——这个数本身也很薄。
 */

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** top-1 高出背景分布多少。调用方据此判命中，也供 eval 扫曲线。 */
export function peakMargin(scored: ScoredChunk[]): number {
  if (scored.length === 0) return 0;
  return scored[0].score - median(scored.map((entry) => entry.score));
}

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

/**
 * 倒数排名融合（RRF）：只看名次，不看分数。
 *
 * 关键词打的是词元命中数（整数、上不封顶），向量打的是余弦（[-1,1]）——两个量纲
 * 根本不可比，加权求和先得各自归一化，而归一化参数又是语料相关的。RRF 绕开这一整
 * 类问题：`1/(K + 名次)` 与分数量纲无关，跟尖峰判据用相对量而非绝对量是同一个道理。
 *
 * K = 60 是原论文的取值，作用是压低头部名次之间的差距，让两路都排得靠前的块胜出。
 */
const RRF_K = 60;

function fuse(ranked: Chunk[][], limit: number): Chunk[] {
  const scores = new Map<Chunk, number>();

  for (const list of ranked) {
    list.forEach((chunk, rank) => {
      scores.set(chunk, (scores.get(chunk) ?? 0) + 1 / (RRF_K + rank));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([chunk]) => chunk);
}

export async function searchChunks(
  chunks: Chunk[],
  query: string,
  limit = 1,
  embedder?: Embedder,
  minPeakMargin = MIN_PEAK_MARGIN,
): Promise<Chunk[]> {
  if (!embedder || !chunks.every((chunk) => chunk.vector)) {
    return keywordSearch(chunks, query, limit);
  }

  const scored = await scoreChunks(chunks, query, embedder);
  // 没有尖峰就是没检索到——宁可报 grounding: 'none'，也不编造一段出处。
  // 判据只看向量那一路：中文问句抽不出词元，关键词那一路对它恒为空，
  // 拿它当否决条件会把中文全毙掉。
  if (peakMargin(scored) < minPeakMargin) return [];

  // 排序两路都用：关键词在英文和「中文夹英文术语」上很强（它在英文题上曾是满分），
  // 向量负责跨语言。RRF 让两路都排得靠前的块胜出。
  return fuse(
    [scored.map((entry) => entry.chunk), keywordSearch(chunks, query, limit * 3)],
    limit,
  );
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

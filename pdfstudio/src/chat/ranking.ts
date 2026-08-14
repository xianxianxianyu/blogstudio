import { cosineSimilarity } from "../model/embedder";
import type { Embedder } from "../model/embedder";
import type { Chunk } from "./retrieval";

// 排序与命中判据：给定块和问题，选出哪几块、以及要不要认定为「没检索到」。
// 与块从哪来无关——换检索算法只动这个文件。

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
 * 0.10 由 `npm run eval:retrieval -- --embed` 标定。曲线与生产路径**同口径**——
 * 排序同样经 RRF 融合，只有门槛在变（此前曲线排的是纯向量，标出来的数填回生产路径
 * 其实对不上）：
 *
 *   margin  zh@1   zh@3   en@3   abstention
 *   0.08   40.0%  90.0% 100.0%   1/2
 *   0.10   40.0%  85.0% 100.0%   2/2   ← 拿满 abstention 的最低档
 *   0.12   40.0%  80.0% 100.0%   2/2   ← 被 0.10 支配
 *   0.15   10.0%  20.0% 100.0%   2/2
 *
 * abstention 的分母是 **2 而非 3**：`na-03`（问 DDPM 在 ImageNet 上的 FID，全文无
 * ImageNet 但满页 FID 表格）不计入——按 `chat-retrieval-interface.md` 定的语义，
 * `'retrieved'` 承诺的是「检索到主题相关的原文」，它找到 FID 表格是**对的**。
 * 「这段里没有你问的事实」要读一遍才知道，是推理不是检索。
 *
 * 换判据这件事本身把代价降了一个量级：同样拿到满分 abstention，早先的绝对余弦阈值
 * 要把中文 recall@3 砍到 40%，尖峰判据只掉到 85%。
 *
 * 注意 abstention 只有 2 条题——这个数很薄，别过度解读。
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

/** 关键词那一路：词元重合打分。 */
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
  // 写成 `!(x >= t)` 而非 `x < t`：万一算出 NaN，前者拦住、后者放行。
  if (!(peakMargin(scored) >= minPeakMargin)) return [];

  // **两侧深度必须一致**。此前向量那一路传的是全量排序、关键词只有 limit*3，
  // 于是任何关键词命中都能同时从两个列表拿分（≥ 1/60 + ε），而只在向量列表里
  // 排第一的块只有 1/60——关键词 top-1 永远赢过向量 top-1，与「两路都排得靠前的
  // 块胜出」正好相反。eval 的中文题刻意不含英文词、关键词那一路恒空，所以这个偏置
  // 在 eval 上完全测不出来；读者一旦在中文问句里带上英文术语就会踩到。
  const depth = limit * 3;
  return fuse(
    [scored.slice(0, depth).map((entry) => entry.chunk), keywordSearch(chunks, query, depth)],
    limit,
  );
}

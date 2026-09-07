import type { Context } from "../../contextstudio/src/context";
import { bigrams, coverage } from "./text";

/**
 * 召回：这一问该拿库里的哪几条 context 当材料。
 *
 * Blog Studio 从知识库**读** context 当素材（`CONTEXT-MAP.md`）。写文章时人不会先去
 * 图里翻，所以这一层的职责是：拿问题（和正在写的这一段）去库里找，找不到就**明说找不到**。
 *
 * **不按 topic 查**（`docs/workflow.md` §4④ 已经写死了这条）：纯 tag/topic 匹配在库大了
 * 之后召回率差，而且主题体系会漂。这里按语义召回，topic 只是被一并编码进文本。
 */

/** 向量端口。形状与 PDF Studio 那侧的 `Embedder` 相同——接的就是同一个本机服务。 */
export interface Embed {
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
}

export interface Recalled {
  context: Context;
  score: number;
}

export interface Recaller {
  /** 召回，最多 `k` 条。**没有像样的命中就返回空数组**，不硬凑。 */
  recall(query: string, pool: Context[], k?: number): Promise<Recalled[]>;
}

/**
 * 一条 context 拿去编码的文本：断言 + 证据 + 主题。
 *
 * 证据要进——断言常常只有一句话，光凭它跟问题算相似度太稀薄；主题也进，它是人给的
 * 归类信号，白扔可惜。**出处不进**：书名会让同一本书里的所有 context 一起被拉高。
 */
const textOf = (context: Context): string =>
  [context.claim ?? "", context.evidence, context.topics.join(" ")].join("\n").trim();

/** 余弦相似度。维度不一致当场炸，理由同 PDF Studio：NaN 会**通过**下游的阈值判断。 */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`向量维度不一致：${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denominator = Math.sqrt(na) * Math.sqrt(nb);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * 命中判据是**相对**的：top-1 要比中位数高出这么多，才算真的召回到东西。
 *
 * 抄的是 PDF Studio 那次实测的结论（`pdfstudio/src/chat/ranking.ts`）：绝对的余弦下限
 * 切不开「答得了」与「答不了」，因为归一化之后同领域的任意两段文本相似度都不低。
 * 相对判据与模型、领域都无关。
 *
 * **这个数字在这里还没有量过**——PDF Studio 那边是拿 eval 扫出来的，Blog Studio 还没有
 * 对应的评测集。写成常量而不是散在代码里，是为了等有了评测集能一处改掉。
 */
const MIN_PEAK_MARGIN = 0.1;

/** 少于这么多条就不谈分布：三条材料的「中位数」没有意义。 */
const ENOUGH_FOR_PEAK = 4;

function pick(scored: Recalled[], k: number): Recalled[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  if (sorted.length === 0 || sorted[0].score <= 0) return [];
  if (sorted.length < ENOUGH_FOR_PEAK) return sorted.slice(0, k).filter((one) => one.score > 0);

  const median = sorted[Math.floor(sorted.length / 2)].score;
  const margin = sorted[0].score - median;
  // 尖峰不明显＝这一问跟库里的材料没关系。**宁可一条不给**：硬塞几条不相干的进 prompt，
  // 模型会认认真真地围着它们写，而写文章的人看不出那几条是凑数的。
  if (margin < MIN_PEAK_MARGIN) return [];

  // 跟着尖峰的那几条一起要：与 top-1 差得比尖峰本身还远的，已经是背景分布里的东西。
  return sorted.filter((one) => one.score >= median + margin / 2).slice(0, k);
}

/**
 * 建一个召回器。**向量按 context 缓存在内存里**——一次问答只该给问题算一条向量，
 * 而不是把整个库重算一遍。
 *
 * 缓存连着它当时的文本一起记：读者在 Context Studio 里改了主题、改了断言，文本变了，
 * 那条就重算。只按 id 缓存的话，改完主题召回还是老样子，而且不会有任何报错。
 *
 * 不接 `embed` 也能用，退化成二元组重合度打分——那时召回质量差，但**不是零**：
 * PDF Studio 那边的教训是反过来的（中文问英文论文，关键词那一路是零召回），这里两侧
 * 都是中文，退化档还撑得住。
 */
export function createRecaller(deps: { embed?: Embed } = {}): Recaller {
  const vectors = new Map<string, { text: string; vector: Float32Array }>();

  return {
    async recall(query: string, pool: Context[], k = 6): Promise<Recalled[]> {
      if (query.trim() === "" || pool.length === 0) return [];

      if (!deps.embed) {
        const grams = bigrams(query);
        return pick(
          pool.map((context) => ({ context, score: coverage(grams, bigrams(textOf(context))) })),
          k,
        );
      }

      const missing = pool.filter((context) => vectors.get(context.id)?.text !== textOf(context));
      if (missing.length > 0) {
        const fresh = await deps.embed.embedDocuments(missing.map(textOf));
        missing.forEach((context, index) => {
          vectors.set(context.id, { text: textOf(context), vector: fresh[index] });
        });
      }

      const asked = await deps.embed.embedQuery(query);
      return pick(
        pool.map((context) => ({
          context,
          score: cosine(asked, vectors.get(context.id)!.vector),
        })),
        k,
      );
    },
  };
}

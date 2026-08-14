import type { Embedder } from "../src/model/embedder";

/**
 * 确定性 embedder。真模型要下几百 MB 权重、且结果随版本浮动，
 * 进不了红绿循环——语义质量归 `eval/retrieval/`，这里只钉接线。
 *
 * 用显式的「文本 → 向量」映射：想让中文 query 与英文块同向，就把它们映到同一个
 * 向量。这样测的是「向量检索有没有被用上、下限有没有生效」，不是模型好不好。
 */
export function createFakeEmbedder(vectors: Record<string, number[]>): Embedder {
  const lookup = (text: string): Float32Array => {
    const key = Object.keys(vectors).find((candidate) => text.includes(candidate));
    return Float32Array.from(key ? vectors[key] : [0, 0, 1]);
  };

  return {
    embedQuery: (text) => Promise.resolve(lookup(text)),
    embedDocuments: (texts) => Promise.resolve(texts.map(lookup)),
  };
}

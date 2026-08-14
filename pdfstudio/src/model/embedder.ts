/**
 * 检索用的向量端口。
 *
 * 与 `ModelClient` 形状不同（文本进、向量出，不是 complete/streamComplete），
 * 所以是独立的端口——ADR-0010 预告过这一条。
 *
 * **query 与 document 是两个方法，不是一个方法加参数。** 因为多语言 embedding
 * 普遍要求两侧注入不同的任务前缀（embeddinggemma 是
 * `task: search result | query: ` 与 `title: none | text: `），而
 * `research-embedding-shortlist.md` §3.4 把「不加前缀就掉到 bge-m3 之下」列为
 * 推翻条件之一。写成两个方法，调用方就没法误用同一条路径。
 */
export interface Embedder {
  /** 编码一条查询。 */
  embedQuery(text: string): Promise<Float32Array>;
  /** 编码一批文档块。批量是因为建索引时块很多，逐条往返太慢。 */
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
}

/** 余弦相似度。两侧都已归一化时等价于点积，但不假设这一点。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

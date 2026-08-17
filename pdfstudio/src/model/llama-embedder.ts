import type { Embedder } from "./embedder";

/**
 * 走 llama-server 的 `/v1/embeddings` 算向量。
 *
 * 换掉 onnxruntime-node 的理由是它在 Electron 的进程里根本跑不起来——主进程上
 * EXC_BREAKPOINT，utilityProcess 里同一个信号，两处都试过。而 llama.cpp 我们本来就
 * 已经下好、已经在跑（识别那档），`LocalEngine` 也已经在管它的进程生死：换过去等于
 * **少一个推理运行时**，而不是多一个。
 *
 * Apple Silicon 上它走 Metal，比 onnxruntime 的 CPU 路径还快。
 */

/**
 * **任务前缀必须一字不差。** embeddinggemma 的成绩是在注入前缀的条件下跑的；不加或
 * 加错就掉到 bge-m3 之下（`research-embedding-shortlist.md` §3.4 的推翻条件）。
 *
 * 这两条与 `transformers-embedder.ts` 里的必须一致——换了推理后端不等于换了模型契约。
 */
const QUERY_PREFIX = "task: search result | query: ";
const DOCUMENT_PREFIX = "title: none | text: ";

/** 一次请求塞多少段。整篇论文一次发过去会撑爆 llama-server 的上下文预算。 */
const BATCH_SIZE = 32;

export function createLlamaEmbedder(baseURL: string): Embedder {
  async function embed(inputs: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];

    for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
      const response = await fetch(`${baseURL}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: inputs.slice(start, start + BATCH_SIZE) }),
      });
      if (!response.ok) {
        throw new Error(`向量计算失败：HTTP ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as { data?: { embedding: number[] }[] };
      if (!body.data) throw new Error("向量服务没有返回 data");
      // 顺序按请求顺序回来（OpenAI 契约保证 index），这里直接按序取——真要乱序，
      // 下游的相似度会静默算错，而不是报错。
      for (const item of body.data) vectors.push(Float32Array.from(item.embedding));
    }

    return vectors;
  }

  return {
    async embedQuery(text: string): Promise<Float32Array> {
      return (await embed([`${QUERY_PREFIX}${text}`]))[0];
    },
    embedDocuments(texts: string[]): Promise<Float32Array[]> {
      return embed(texts.map((text) => `${DOCUMENT_PREFIX}${text}`));
    },
  };
}

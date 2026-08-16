import type { Embedder } from "../src/model/embedder";
import type { Progress } from "../src/app/progress";

/**
 * 浏览器侧的 `Embedder`：把编码转给 dev server，那边用 onnxruntime-node 原生跑。
 *
 * 换掉 Worker + WASM 那条路的理由是速度，而速度差来自档次不同：WASM 那一档是单线程、
 * 没有原生 SIMD 的；`onnxruntime-node` 是原生多线程——检索 eval 跑三篇论文很快，
 * 正是这个原因。顺带还省掉「每次页面加载往 WASM 里塞 300 MB 权重」，那部分即使有
 * HTTP 缓存也躲不掉。
 *
 * 这也不是丢弃性的工作：打包之后主进程正是这么跑（ADR-0006），这条 HTTP 边界就是
 * IPC 的预演——和 ClipStore、Bookshelf、配置、索引缓存走的是同一条路。
 */
export function createHttpEmbedder(route: string, progress: Progress): Embedder {
  async function post(body: unknown): Promise<Float32Array[]> {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`向量计算失败：HTTP ${response.status} ${await response.text()}`);

    const { dims, data } = (await response.json()) as { dims: number; data: string };
    // 一整块 base64 拆成若干条向量：逐条 JSON 数组会把 97×768 个浮点写成几 MB 文本。
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const vectors: Float32Array[] = [];
    for (let start = 0; start < all.length; start += dims) {
      vectors.push(all.slice(start, start + dims));
    }
    return vectors;
  }

  return {
    async embedQuery(text: string): Promise<Float32Array> {
      return (await post({ kind: "query", texts: [text] }))[0];
    },
    async embedDocuments(texts: string[]): Promise<Float32Array[]> {
      // 建索引是这里唯一慢的一步（一篇论文几十上百段）。不报的话界面上就是一段
      // 没有尽头的空白——那正是读者第一次问文档时以为它坏了的原因。
      progress.set(`正在给这篇文档建索引（${texts.length} 段）…只需一次`);
      try {
        return await post({ kind: "documents", texts });
      } finally {
        progress.set(null);
      }
    },
  };
}

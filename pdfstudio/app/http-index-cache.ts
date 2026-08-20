import { apiFetch } from "./api-base";
import type { Chunk } from "../src/chat/retrieval";
import type { IndexCache } from "../src/chat/retrieval";

/**
 * 正文向量的缓存，落在这篇文档自己的文件夹里（由 dev server 代写，同 ClipStore）。
 *
 * 向量走 base64 而不是 JSON 数字数组：768 维 × 40 块写成 `[0.0123,...]` 是几 MB 文本，
 * 而 base64 的 Float32Array 只有几百 KB，解析也快一个量级。
 */
export function createHttpIndexCache(route: string, docId: string, model: string): IndexCache {
  const url = `${route}/${encodeURIComponent(docId)}`;

  return {
    async load(): Promise<Chunk[] | null> {
      const response = await apiFetch(url);
      if (!response.ok) return null;
      const cached = (await response.json()) as { model?: string; chunks?: WireChunk[] } | null;
      // **换了模型就作废**：不同模型的向量根本不在同一个空间里，混用不会报错，
      // 只会让检索悄悄返回不相干的段落。
      if (!cached?.chunks || cached.model !== model) return null;
      return cached.chunks.map((chunk) => ({
        page: chunk.page,
        text: chunk.text,
        vector: chunk.vector === undefined ? undefined : decode(chunk.vector),
      }));
    },

    async save(chunks: Chunk[]): Promise<void> {
      await apiFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          chunks: chunks.map((chunk) => ({
            page: chunk.page,
            text: chunk.text,
            vector: chunk.vector && encode(chunk.vector),
          })),
        }),
      });
    },
  };
}

interface WireChunk {
  page: number;
  text: string;
  vector?: string;
}

function encode(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function decode(text: string): Float32Array {
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

import { describe, expect, it, vi } from "vitest";
import { createLlamaEmbedder } from "./llama-embedder";

/** 记下请求体，好断言前缀真的注入了。 */
function scriptedFetch(dims = 4) {
  const sent: { input: string[] }[] = [];
  const fake = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    sent.push(body);
    return {
      ok: true,
      json: async () => ({ data: body.input.map(() => ({ embedding: Array.from({ length: dims }, () => 0.5) })) }),
    } as unknown as Response;
  });
  return { sent, fake };
}

describe("llama-server 向量", () => {
  it("查询侧与文档侧注入各自的任务前缀", async () => {
    // **不加或加错就掉到 bge-m3 之下**（research-embedding-shortlist §3.4 的推翻条件）。
    // 换推理后端不等于换模型契约，所以这两条必须与 transformers 那份一字不差。
    const { sent, fake } = scriptedFetch();
    vi.stubGlobal("fetch", fake);
    const embedder = createLlamaEmbedder("http://x/v1");

    await embedder.embedQuery("注意力");
    await embedder.embedDocuments(["Attention"]);

    expect(sent[0].input[0]).toBe("task: search result | query: 注意力");
    expect(sent[1].input[0]).toBe("title: none | text: Attention");
    vi.unstubAllGlobals();
  });

  it("整篇论文分批发，不是一次全塞过去", async () => {
    // 一次发上百段会撑爆 llama-server 的上下文预算——而它给的错跟「段太多」毫无关系。
    const { sent, fake } = scriptedFetch();
    vi.stubGlobal("fetch", fake);

    await createLlamaEmbedder("http://x/v1").embedDocuments(Array.from({ length: 70 }, (_, i) => `第 ${i} 段`));

    expect(sent).toHaveLength(3);
    expect(sent.every((body) => body.input.length <= 32)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("服务报错就抛，不静默返回空向量", async () => {
    // 返回空的话下游的余弦相似度会算出一堆 0，排序全乱而没有任何报错。
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, text: async () => "boom" }) as unknown as Response);

    await expect(createLlamaEmbedder("http://x/v1").embedQuery("x")).rejects.toThrow("HTTP 500");
    vi.unstubAllGlobals();
  });
});

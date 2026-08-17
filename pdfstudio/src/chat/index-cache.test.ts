import { describe, expect, it } from "vitest";
import { buildIndex } from "./retrieval";
import { openFixturePdf } from "../../test/fixtures";
import { createFakeEmbedder } from "../../test/fake-embedder";
import type { Chunk } from "./retrieval";
import type { Clip } from "../clip/clip";
import type { Screenshot } from "../recognizer/recognizer";

const PIXELS: Screenshot = { mime: "image/png", bytes: new Uint8Array([1]), width: 4, height: 4 };

function noteClip(id: string, note: string): Clip {
  const rect = { x: 1, y: 2, width: 30, height: 40 };
  return {
    id,
    state: "ready",
    region: { page: 1, rect, pixels: PIXELS },
    content: { route: "vision", anchor: { page: 1, rect }, sourceText: null, images: [], screenshot: PIXELS },
    sourceText: null,
    translation: null,
    note,
    label: "dot",
    important: true,
    tagId: null,
    lastViewedAt: 0,
  };
}

/** 记账用的 embedder：这里要验的正是「有没有再算一遍」。 */
function countingEmbedder() {
  // 具体向量无所谓：这里数的是「有没有再算一遍」，不是排序对不对。
  const inner = createFakeEmbedder({ 梯度: [1, 0, 0] });
  const counts = { documents: 0, texts: 0 };
  return {
    counts,
    embedder: {
      embedQuery: (text: string) => inner.embedQuery(text),
      embedDocuments: (texts: string[]) => {
        counts.documents++;
        counts.texts += texts.length;
        return inner.embedDocuments(texts);
      },
    },
  };
}

function memoryCache() {
  let stored: Chunk[] | null = null;
  return {
    get stored() {
      return stored;
    },
    cache: {
      load: async () => stored,
      save: async (chunks: Chunk[]) => {
        stored = chunks;
      },
    },
  };
}

describe("索引缓存", () => {
  it("第一次算完就存下来，第二次不再算正文", async () => {
    // 不缓存的话，每次打开这本书都要给整篇论文重算一遍向量——浏览器 WASM 里要一两
    // 分钟，读者每次打开书都得先等着才能问第一句话。
    const document = await openFixturePdf("1706.03762.pdf");
    const { counts, embedder } = countingEmbedder();
    const holder = memoryCache();

    await buildIndex(document, embedder, [], holder.cache);
    const firstRound = counts.texts;
    expect(firstRound).toBeGreaterThan(0);
    expect(holder.stored).not.toBeNull();

    await buildIndex(document, embedder, [], holder.cache);

    expect(counts.texts).toBe(firstRound);
  });

  it("缓存里不含摘录块——摘录随时在变，缓存下来新框的就再也进不去", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const { embedder } = countingEmbedder();
    const holder = memoryCache();

    await buildIndex(document, embedder, [noteClip("c1", "第一条笔记")], holder.cache);

    expect(holder.stored!.some((chunk) => chunk.clipId !== undefined)).toBe(false);
  });

  it("命中缓存后新加的摘录照样进得了索引", async () => {
    // 正文用缓存、摘录每次现算：摘录少而短，重算便宜；正文多而稳，值得缓存。
    // 这样就完全不需要给摘录做缓存失效——最容易出错的那部分直接不存在。
    const document = await openFixturePdf("1706.03762.pdf");
    const { embedder } = countingEmbedder();
    const holder = memoryCache();
    await buildIndex(document, embedder, [], holder.cache);

    const chunks = await buildIndex(document, embedder, [noteClip("c1", "梯度检查点")], holder.cache);

    expect(chunks.some((chunk) => chunk.clipId === "c1")).toBe(true);
    expect(chunks.every((chunk) => chunk.vector !== undefined)).toBe(true);
  });
});

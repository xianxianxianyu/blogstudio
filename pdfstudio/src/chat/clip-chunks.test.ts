import { describe, expect, it } from "vitest";
import { clipChunks } from "./clip-chunks";
import { defaultTags } from "../tag/tag";
import type { Clip } from "../clip/clip";
import type { Screenshot } from "../recognizer/recognizer";

const PIXELS: Screenshot = { mime: "image/png", bytes: new Uint8Array([1]), width: 4, height: 4 };

function clip(over: Partial<Clip> & Pick<Clip, "content">): Clip {
  return {
    id: "c1",
    state: "ready",
    region: { page: 4, rect: { x: 1, y: 2, width: 30, height: 40 }, pixels: PIXELS },
    sourceText: over.content?.sourceText ?? null,
    translation: null,
    note: null,
    label: "dot",
    important: false,
    tagId: null,
    title: null,
    lastViewedAt: 0,
    ...over,
  };
}

const vision = (fields: { sourceText?: string | null; multimodal?: string }) =>
  clip({
    content: {
      route: "vision",
      anchor: { page: 4, rect: { x: 1, y: 2, width: 30, height: 40 } },
      sourceText: fields.sourceText ?? null,
      multimodal: fields.multimodal,
      images: [],
      screenshot: PIXELS,
    },
  });

describe("摘录进检索索引", () => {
  it("公式的 LaTeX 进索引——文本层在这里恰好是瞎的", () => {
    const latex = String.raw`\mathrm{Attention}(Q,K,V)=\mathrm{softmax}(\frac{QK^T}{\sqrt{d_k}})V`;

    const chunks = clipChunks([vision({ sourceText: latex })]);

    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("softmax");
    expect(chunks[0].page).toBe(4);
    expect(chunks[0].clipId).toBe("c1");
  });

  it("图表的描述进索引——文本层根本没有这段", () => {
    const chunks = clipChunks([
      vision({ sourceText: null, multimodal: "Transformer 模型架构图，左编码器右解码器" }),
    ]);

    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("解码器");
  });

  it("译文和笔记都进索引", () => {
    // 两者文本层都没有。译文是跨语言检索的关键，笔记是读者自己写的。
    const one = vision({ sourceText: "x" });
    const chunks = clipChunks([{ ...one, translation: "主流的序列转导模型", note: "论点起点" }]);
    const text = chunks.map((chunk) => chunk.text).join("\n");

    expect(text).toContain("主流的序列转导模型");
    expect(text).toContain("论点起点");
  });

  it("文本路由的原文不进索引——它逐字来自文本层，进去就是重复", () => {
    // 文档索引里已经有同一段话了。再塞一份不带来任何可检索的新信息，只会让同一段
    // 内容占掉两个位置，还把背景分布搅乱——而 abstention 的门槛正是按背景分布标定的。
    const text = "The dominant sequence transduction models are based on complex recurrent";
    const chunks = clipChunks([
      clip({
        sourceText: text,
        translation: "主流的序列转导模型",
        content: {
          route: "text",
          anchor: { page: 4, rect: { x: 1, y: 2, width: 30, height: 40 } },
          sourceText: text,
          images: [],
          screenshot: PIXELS,
        },
      }),
    ]);

    const joined = chunks.map((chunk) => chunk.text).join("\n");
    expect(joined).not.toContain("dominant sequence");
    expect(joined).toContain("主流的序列转导模型");
  });

  it("墓碑不进索引", () => {
    // 保留规则即索引规则（ADR-0012 边界）：内容过期，索引项随之过期。
    // 墓碑一定没有笔记——写过笔记的摘录回收器不会碰。
    expect(clipChunks([clip({ content: null })])).toEqual([]);
  });

  it("还没识别完的不进索引", () => {
    expect(clipChunks([clip({ state: "capturing", content: null })])).toEqual([]);
  });

  it("空白字段不会变成空块", () => {
    // 空块在关键词那一路里对任何查询都不命中，但会进背景分布、把中位数拉低，
    // 于是 peakMargin 虚高——**看起来更有把握，其实只是掺了水**。
    const chunks = clipChunks([vision({ sourceText: "   ", multimodal: "" })]);

    expect(chunks).toEqual([]);
  });
});

describe("标签名进检索文本", () => {
  it("带标签的摘录，块里有标签名", () => {
    // 量过才加的：退化的分类问句（「读懂了的那段讲了什么」，除了标签名没有任何主题词）
    // 0/4 → 3/4，而摘录题 6/6、追问题 9/9、abstention 2/2、margin 分布全部不动。
    const [chunk] = clipChunks([{ ...vision({ multimodal: "结构对比图" }), tagId: "green" }], defaultTags());

    expect(chunk.text).toContain("读懂了");
  });

  it("没标签的摘录，块里一个字都不多", () => {
    const untagged = vision({ multimodal: "结构对比图" });
    const [tagged] = clipChunks([untagged], defaultTags());
    const [bare] = clipChunks([untagged]);

    expect(tagged.text).toBe(bare.text);
  });

  it("标签表里查不到那个 id 时不塞空串", () => {
    // 塞空串会在块头上留一行空行，而空白进不了任何查询、只会往背景分布掺水——
    // abstention 的门槛正是按背景分布标定的。
    const [chunk] = clipChunks([{ ...vision({ multimodal: "结构对比图" }), tagId: "purple" }], []);

    expect(chunk.text.startsWith("\n")).toBe(false);
  });
});

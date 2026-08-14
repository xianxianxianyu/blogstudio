import { describe, expect, it } from "vitest";
import { createChat } from "./chat";
import { openFixturePdf } from "../../test/fixtures";
import { createFakeModelClient } from "../../test/fake-model-client";
import { createFakeEmbedder } from "../../test/fake-embedder";
import type { FakeModelOptions } from "../../test/fake-model-client";
import type { ClipSnapshot } from "./chat";
import type { Screenshot } from "../recognizer/recognizer";
import type { PDFDocumentProxy } from "pdfjs-dist";

const DOC_ID = "arxiv-1706.03762";

async function setup(modelOptions?: FakeModelOptions) {
  const document = await openFixturePdf("1706.03762.pdf");
  const model = createFakeModelClient(modelOptions);
  return { model, chat: createChat({ document, docId: DOC_ID, model }) };
}

const ask = (text: string) => [
  { role: "user" as const, parts: [{ kind: "text" as const, text }] },
];

describe("Chat — 流式回答", () => {
  it("走 streamComplete，把增量累积成最终回答", async () => {
    const { model, chat } = await setup({
      completeText: "这篇论文在 WMT 2014 英德翻译任务上做了实验。",
      deltas: ["这篇论文在 WMT 2014 ", "英德翻译任务上", "做了实验。"],
    });

    const answer = await chat.ask(ask("这篇的实验用了什么数据集？"));

    expect(answer.text).toBe("这篇论文在 WMT 2014 英德翻译任务上做了实验。");
    // ADR-0009：Chat 用 streamComplete，Recognizer 才用 complete。
    expect(model.streamCalls).toHaveLength(1);
    expect(model.completeCalls).toHaveLength(0);
  });
});

describe("Chat — 贴入的摘录与图片", () => {
  const PNG: Screenshot = {
    mime: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    width: 320,
    height: 120,
  };

  const SNAPSHOT: ClipSnapshot = {
    clipId: "c1",
    sourceText: "Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V",
    translation: "注意力等于……",
    image: PNG,
    page: 4,
    note: "缩放因子是这里的关键",
  };

  it("摘录快照的原文进 ModelRequest，图进 images", async () => {
    const { model, chat } = await setup({ completeText: "缩放是为了稳定梯度。" });

    await chat.ask([
      {
        role: "user",
        parts: [
          { kind: "text", text: "这段公式的假设是什么？" },
          { kind: "clip", snapshot: SNAPSHOT },
        ],
      },
    ]);

    const request = model.streamCalls[0];
    const prompt = request.messages.map((message) => message.content).join("\n");

    expect(prompt).toContain(SNAPSHOT.sourceText);
    expect(prompt).toContain("这段公式的假设是什么？");
    expect(request.images).toEqual([PNG]);
  });

  it("单独贴的图片也进 images", async () => {
    const { model, chat } = await setup({ completeText: "这是一张架构图。" });

    await chat.ask([
      {
        role: "user",
        parts: [
          { kind: "text", text: "这张图在讲什么？" },
          { kind: "image", image: PNG },
        ],
      },
    ]);

    expect(model.streamCalls[0].images).toEqual([PNG]);
  });
});

describe("Chat — 停止", () => {
  it("中途取消返回已收到的部分回答，而不是抛错", async () => {
    const controller = new AbortController();
    const { chat } = await setup({
      completeText: "整段回答",
      deltas: ["这篇论文", "在 WMT 2014", "英德翻译任务上"],
      onDelta: (index) => {
        if (index === 0) controller.abort();
      },
    });

    const answer = await chat.ask(ask("这篇的实验用了什么数据集？"), {
      signal: controller.signal,
    });

    // 不变量 ⑥：ask 只 reject 模型失败或契约违反。读者按停止不是失败，
    // 已经读到的那半段答案照样留着。
    expect(answer.text).toBe("这篇论文");
    expect(answer.grounding).toBe("none");
  });

  it("signal 透到 ModelRequest，adapter 才断得掉远端流", async () => {
    const controller = new AbortController();
    const { model, chat } = await setup({ completeText: "回答" });

    await chat.ask(ask("问题"), { signal: controller.signal });

    expect(model.streamCalls[0].signal).toBe(controller.signal);
  });
});

describe("Chat — 检索与出处", () => {
  it("答案在文中时，citation 指向正确的页，grounding 是 retrieved", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "退化问题指的是更深的网络反而训练误差更高。" });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model });

    const answer = await chat.ask(ask("What is the degradation problem?"));

    // grounding 由 Chat 判定，与模型输出无关（不变量 ⑤）。
    expect(answer.grounding).toBe("retrieved");
    expect(answer.citations.length).toBeGreaterThan(0);

    const [citation] = answer.citations;
    expect(citation.kind).toBe("chunk");
    // "degradation" 在 ResNet 里首次出现在第 1 页摘要。
    expect(citation.page).toBe(1);
    expect(citation.snippet?.toLowerCase()).toContain("degradation");
  });

  it("检索到的原文进 prompt——不然模型无从作答", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "答案" });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model });

    await chat.ask(ask("What is the degradation problem?"));

    const prompt = model.streamCalls[0].messages.map((message) => message.content).join("\n");
    expect(prompt.toLowerCase()).toContain("degradation");
  });
});

describe("Chat — 没有依据时", () => {
  it("问文档里根本没有的事，grounding 是 none，不给出处", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "这篇论文没有讲这个。" });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model });

    const answer = await chat.ask(ask("What is the capital of France?"));

    // 「the」「what」这类词在每一块里都有，不能拿它们当命中——
    // 否则任何问题都会「检索到」一段无关原文，grounding 就成了谎话。
    expect(answer.grounding).toBe("none");
    expect(answer.citations).toEqual([]);
  });
});

describe("Chat — 只基于贴入内容作答", () => {
  it("检索没命中但有贴入的摘录时，grounding 是 pasted，出处指向摘录", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "缩放是为了稳定梯度。" });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model });

    const answer = await chat.ask([
      {
        role: "user",
        parts: [
          // 问题里没有一个能命中这篇论文的词。
          { kind: "text", text: "为什么要除以根号 dk？" },
          {
            kind: "clip",
            snapshot: {
              clipId: "c7",
              sourceText: "We scale the dot products by 1/sqrt(d_k).",
              page: 4,
            },
          },
        ],
      },
    ]);

    expect(answer.grounding).toBe("pasted");
    expect(answer.citations).toEqual([{ kind: "clip", page: 4, clipId: "c7" }]);
  });
});

describe("Chat — 索引只建一次", () => {
  it("同一个 PDF 的后续提问复用索引，不重读文档", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    let getPageCalls = 0;
    // 数注入依赖上的调用——document 在构造缝上，与数 model.complete 同性质。
    const counted = new Proxy(document, {
      get(target, prop: keyof PDFDocumentProxy) {
        if (prop === "getPage") {
          return (page: number) => {
            getPageCalls++;
            return target.getPage(page);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const model = createFakeModelClient({ completeText: "答案" });
    const chat = createChat({ document: counted, docId: "arxiv-1512.03385", model });

    await chat.ask(ask("What is the degradation problem?"));
    const afterFirst = getPageCalls;
    await chat.ask(ask("What is a residual block?"));

    // 首问读完整篇；第二问一页都不该再读（不变量 ④ 幂等索引）。
    expect(afterFirst).toBe(document.numPages);
    expect(getPageCalls).toBe(afterFirst);
  });
});

describe("Chat — 检索命中且贴了摘录", () => {
  it("两种出处都要给，不能因为检索命中就把摘录的 citation 丢掉", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "退化问题是……" });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model });

    const answer = await chat.ask([
      {
        role: "user",
        parts: [
          { kind: "text", text: "What is the degradation problem?" },
          {
            kind: "clip",
            snapshot: { clipId: "c9", sourceText: "deeper networks degrade", page: 2 },
          },
        ],
      },
    ]);

    // 依据里有检索到的原文，所以 grounding 是 retrieved；但读者贴进来的摘录
    // 同样是这次回答的依据，出处不该被吞掉。
    expect(answer.grounding).toBe("retrieved");
    expect(answer.citations.map((citation) => citation.kind).sort()).toEqual(["chunk", "clip"]);
  });
});

describe("Chat — reindex", () => {
  it("重建索引后下一次提问会重读文档", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    let getPageCalls = 0;
    const counted = new Proxy(document, {
      get(target, prop: keyof PDFDocumentProxy) {
        if (prop === "getPage") {
          return (page: number) => {
            getPageCalls++;
            return target.getPage(page);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const model = createFakeModelClient({ completeText: "答案" });
    const chat = createChat({ document: counted, docId: "arxiv-1512.03385", model });

    await chat.ask(ask("What is the degradation problem?"));
    const afterFirst = getPageCalls;

    await chat.reindex();
    await chat.ask(ask("What is the degradation problem?"));

    // canonical 把 reindex 定为「OCR 修正 / 换切块策略后重建」的逃生口——
    // 没有它，索引一旦建成就不可失效。
    expect(getPageCalls).toBeGreaterThan(afterFirst);
  });
});

describe("Chat — 双栏页的读序", () => {
  it("citation 的原文片段里不该混进隔壁栏的表格图题", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "因为过拟合。" });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model });

    // 用能唯一命中那一块的词提问。排序质量是这个关键词基线的已知弱项，由
    // eval/retrieval/ 去量；这条测试只测读序，不该被排序带偏。
    const answer = await chat.ask(
      ask("regularization such as maxout or dropout unnecessarily large overfitting"),
    );

    const snippet = answer.citations.find((citation) => citation.kind === "chunk")?.snippet ?? "";
    expect(snippet).toContain("1202-layer network may be unnecessarily");

    // pdf.js 的原始顺序会把右栏的表格图题插进左栏正文中间，读者看到的出处就成了
    // 「…See also Table 9 for better results.have similar training error…」这种拼接。
    const splice = snippet.indexOf("have similar training error");
    if (splice >= 0) {
      expect(snippet.slice(Math.max(0, splice - 80), splice)).not.toContain("Table 9");
    }
  });
});

describe("Chat — 配了 embedder 时走向量检索", () => {
  it("中文提问能命中英文原文——关键词检索原理上做不到这件事", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "退化问题是……" });
    // 让中文问句与含 degradation 的英文块同向：测的是向量检索有没有被用上。
    const embedder = createFakeEmbedder({
      退化问题: [1, 0, 0],
      degradation: [1, 0, 0],
    });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model, embedder });

    const answer = await chat.ask(ask("退化问题指的是什么？"));

    expect(answer.grounding).toBe("retrieved");
    expect(answer.citations[0]?.snippet?.toLowerCase()).toContain("degradation");
  });

  it("相似度低于下限时返回空，grounding 诚实报 none", async () => {
    const document = await openFixturePdf("1512.03385.pdf");
    const model = createFakeModelClient({ completeText: "这篇论文没有讲这个。" });
    // 问句与所有块正交——向量检索没有天然下限，不设阈值就会硬凑一段原文当出处。
    const embedder = createFakeEmbedder({ 法国的首都: [0, 1, 0] });
    const chat = createChat({ document, docId: "arxiv-1512.03385", model, embedder });

    const answer = await chat.ask(ask("法国的首都是哪里？"));

    expect(answer.grounding).toBe("none");
    expect(answer.citations).toEqual([]);
  });
});

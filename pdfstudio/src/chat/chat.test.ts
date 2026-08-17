import { describe, expect, it } from "vitest";
import { createChat, isAlreadyPasted, retrievalQuery } from "./chat";
import type { Clip } from "../clip/clip";
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
          // **问题和摘录都不能命中这篇论文**——摘录现在也进检索查询（「问这段」要它
          // 找同主题的邻近段落），所以只让问题落空是不够的，那样检索照样会命中。
          { kind: "text", text: "为什么要除以根号 dk？" },
          {
            kind: "clip",
            snapshot: {
              clipId: "c7",
              sourceText: "牛肉面的汤底要用筒骨慢炖六小时。",
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
    // 两类都要在，条数不管：检索现在喂 top-3（与 eval 的 k 一致），断言精确序列
    // 会把「喂几块」这个可调的量钉死在一条讲出处种类的测试里。
    const kinds = new Set(answer.citations.map((citation) => citation.kind));
    expect([...kinds].sort()).toEqual(["chunk", "clip"]);
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

    // pdf.js 把词间空格单独发成 item（这一页 308 个 item 里 90 个是纯空白）。
    // 丢掉它们再直接拼接，会得到 `Table7.ObjectdetectionmAP` 这种粘死的东西——
    // 关键词那一路按 /[a-z0-9]{3,}/ 切词，`detection`、`object` 就此从索引里消失。
    expect(snippet).toContain("Object detection");
    expect(snippet).not.toMatch(/[a-z][A-Z][a-z]{3,}/);
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

describe("摘录进检索池", () => {
  it("命中摘录时 citation 报 clip，不冒充原文", async () => {
    // 「这是论文原文」和「这是我当时记下的」在读者眼里必须分得开。
    const document = await openFixturePdf("1706.03762.pdf");
    const chat = createChat({
      document,
      docId: "d1",
      model: createFakeModelClient({ completeText: "好的" }),
      clips: () => [clipWith("gradient checkpointing 把显存换成算力", 7)],
    });

    const answer = await chat.ask([
      { role: "user", parts: [{ kind: "text", text: "gradient checkpointing" }] },
    ]);

    expect(answer.citations[0]).toMatchObject({ kind: "clip", page: 7, clipId: "note-1" });
  });

  it("摘录是取值时才读的，新框的立刻能检索到", async () => {
    // 传数组的话会把建索引那一刻的快照钉死，之后新框的摘录永远检索不到，
    // 而且不会有任何报错——这类静默失效最难发现。
    const document = await openFixturePdf("1706.03762.pdf");
    const clips: Clip[] = [];
    const chat = createChat({
      document,
      docId: "d1",
      model: createFakeModelClient({ completeText: "好的" }),
      clips: () => clips,
    });
    await chat.ask([{ role: "user", parts: [{ kind: "text", text: "随便问问" }] }]);

    clips.push(clipWith("gradient checkpointing 把显存换成算力", 7));
    await chat.reindex();
    const answer = await chat.ask([
      { role: "user", parts: [{ kind: "text", text: "gradient checkpointing" }] },
    ]);

    expect(answer.citations[0]).toMatchObject({ kind: "clip", clipId: "note-1" });
  });
});

function clipWith(note: string, page: number): Clip {
  const rect = { x: 1, y: 2, width: 30, height: 40 };
  const shot = { mime: "image/png" as const, bytes: new Uint8Array([1]), width: 4, height: 4 };
  return {
    id: "note-1",
    state: "ready",
    region: { page, rect, pixels: shot },
    content: { route: "vision", anchor: { page, rect }, sourceText: null, images: [], screenshot: shot },
    sourceText: null,
    translation: null,
    note,
    label: "dot",
    important: true,
    tagId: null,
    title: null,
    lastViewedAt: 0,
  };
}

describe("流式出口", () => {
  it("边生成边报，报的是累计文本", async () => {
    // 报累计而不是增量：ADR-0008 的 LocalRuntime 要的就是累计文本事件。让每个 adapter
    // 自己攒一遍的话，攒错了或攒两遍都不会有任何报错，只会看到重复的字。
    const document = await openFixturePdf("1706.03762.pdf");
    const chat = createChat({
      document,
      docId: "d1",
      model: createFakeModelClient({ completeText: "注意力机制", deltas: ["注意", "力", "机制"] }),
    });
    const seen: string[] = [];

    const answer = await chat.ask(
      [{ role: "user", parts: [{ kind: "text", text: "什么是注意力" }] }],
      { onText: (text) => seen.push(text) },
    );

    expect(seen).toEqual(["注意", "注意力", "注意力机制"]);
    expect(seen.at(-1)).toBe(answer.text);
  });

  it("停止之后，最后报出去的和返回的半段一致", async () => {
    // 界面显示的是最后一次 onText，接口返回的是 Answer.text。两者不一致的话，读者
    // 看到的文字和存下来的文字就不是同一段——而停止是常用操作，不是边角情况。
    const document = await openFixturePdf("1706.03762.pdf");
    const controller = new AbortController();
    const chat = createChat({
      document,
      docId: "d1",
      model: createFakeModelClient({
        completeText: "一二三四",
        deltas: ["一", "二", "三", "四"],
        onDelta: (index) => {
          if (index === 1) controller.abort();
        },
      }),
    });
    const seen: string[] = [];

    const answer = await chat.ask([{ role: "user", parts: [{ kind: "text", text: "数数" }] }], {
      signal: controller.signal,
      onText: (text) => seen.push(text),
    });

    expect(answer.text).toBe(seen.at(-1));
    expect(answer.text.length).toBeLessThan("一二三四".length);
  });
});

describe("检索到的原文怎么送给模型", () => {
  it("不发 system 角色——有的端点根本不收", async () => {
    // 实测：读者配的 Responses 格式端点直接拒绝——
    // 「System messages are not allowed in the prompt or messages fields」。
    // 而「支不支持 system 角色」是端点的能力差异，不该由领域假定。
    const document = await openFixturePdf("1706.03762.pdf");
    const seen: { role: string; content: string }[][] = [];
    const model = createFakeModelClient({ completeText: "好" });
    const chat = createChat({
      document,
      docId: "d1",
      model: {
        complete: model.complete.bind(model),
        streamComplete: (request) => {
          seen.push(request.messages.map((m) => ({ role: m.role, content: String(m.content) })));
          return model.streamComplete(request);
        },
      },
    });

    await chat.ask([{ role: "user", parts: [{ kind: "text", text: "encoder 是怎么堆的" }] }]);

    expect(seen[0].some((message) => message.role === "system")).toBe(false);
  });

  it("检索到的原文仍然要送到模型手上", async () => {
    // 上一条只说了「别用 system」。这一条保证原文没被顺手丢掉——不然 grounding 说
    // 「依据是文档原文」，而模型其实什么都没看到。
    //
    // 用英文问句：这条测试没接 embedder，关键词那一路抽不出中文词元（已知，
    // 见 .scratch/pdfstudio-chat/issues/01），中文问句会检索不到而测偏。
    const document = await openFixturePdf("1706.03762.pdf");
    const seen: string[] = [];
    const model = createFakeModelClient({ completeText: "好" });
    const chat = createChat({
      document,
      docId: "d1",
      model: {
        complete: model.complete.bind(model),
        streamComplete: (request) => {
          seen.push(request.messages.map((m) => String(m.content)).join("\n"));
          return model.streamComplete(request);
        },
      },
    });

    const answer = await chat.ask([
      { role: "user", parts: [{ kind: "text", text: "hardware used for training" }] },
    ]);

    expect(answer.grounding).toBe("retrieved");
    expect(seen[0]).toContain(answer.citations[0].snippet!.slice(0, 40));
  });
});

describe("喂给模型几块原文", () => {
  /** 记下真正发给模型的那条消息。 */
  function spy(document: PDFDocumentProxy) {
    const seen: string[] = [];
    const model = createFakeModelClient({ completeText: "好" });
    const chat = createChat({
      document,
      docId: "d1",
      model: {
        complete: model.complete.bind(model),
        streamComplete: (request) => {
          seen.push(request.messages.map((m) => String(m.content)).join("\n"));
          return model.streamComplete(request);
        },
      },
    });
    return { seen, chat };
  }

  it("检索到几块就喂几块，不是只喂第一块", async () => {
    // eval 量的是 recall@3（README：「k 取实际喂给 LLM 的块数」），而此前生产只喂
    // top-1——于是汇报的 85% 是模型根本看不到的数字，它实际只有 45% 的机会拿到
    // 正确那段。度量和实现必须跑在同一套参数上。
    const document = await openFixturePdf("1706.03762.pdf");
    const { seen, chat } = spy(document);

    const answer = await chat.ask([
      { role: "user", parts: [{ kind: "text", text: "training hardware GPUs steps" }] },
    ]);

    expect(answer.citations.filter((c) => c.kind === "chunk").length).toBeGreaterThan(1);
    for (const citation of answer.citations) {
      if (citation.snippet) expect(seen[0]).toContain(citation.snippet.slice(0, 40));
    }
  });

  it("每块都标出页码", async () => {
    // 不标的话模型说不清依据来自哪一页，读者点引用跳过去也对不上——而引用可点
    // 正是 grounding: 'retrieved' 这个语义成立的必要条件。
    const document = await openFixturePdf("1706.03762.pdf");
    const { seen, chat } = spy(document);

    const answer = await chat.ask([
      { role: "user", parts: [{ kind: "text", text: "training hardware GPUs steps" }] },
    ]);

    expect(seen[0]).toContain(`第 ${answer.citations[0].page} 页`);
  });

  it("一块都没检索到时不往消息里塞任何材料", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const { seen, chat } = spy(document);

    const answer = await chat.ask([{ role: "user", parts: [{ kind: "text", text: "你好" }] }]);

    expect(answer.grounding).toBe("none");
    expect(seen[0]).toBe("你好");
  });
});

describe("贴进来的摘录参与检索", () => {
  const pasted = (text: string, page = 3) => ({
    role: "user" as const,
    parts: [
      { kind: "clip" as const, snapshot: { clipId: "c1", sourceText: text, page } },
      { kind: "text" as const, text: "这一段主要讲了什么" },
    ],
  });

  it("贴了摘录才检索得到——不贴就是一句什么都不指的话", async () => {
    // 受控对照：同一句「这一段主要讲了什么」，唯一的差别是有没有贴摘录。
    // 它在索引里没有任何主题词，所以单独问必然落空；而这正是「问这段」此前的处境。
    const document = await openFixturePdf("1706.03762.pdf");
    const model = createFakeModelClient({ completeText: "好" });
    const chat = createChat({ document, docId: "d1", model });

    const alone = await chat.ask([
      { role: "user", parts: [{ kind: "text", text: "这一段主要讲了什么" }] },
    ]);
    const withClip = await chat.ask([
      pasted("We trained our models on one machine with 8 NVIDIA P100 GPUs. Each training step took about 0.4 seconds."),
    ]);

    expect(alone.citations.filter((c) => c.kind === "chunk")).toEqual([]);
    expect(withClip.citations.filter((c) => c.kind === "chunk").length).toBeGreaterThan(0);
  });

  it("检索到的块若已经贴在问题里，就不再重复喂一遍", async () => {
    // 贴进来的摘录本来就在 prompt 里。检索又把它自己那段捞回来的话，三块材料里
    // 有一块是白占的——而正确答案可能就在被挤掉的那块里。
    const document = await openFixturePdf("1706.03762.pdf");
    const seen: string[] = [];
    const model = createFakeModelClient({ completeText: "好" });
    const chat = createChat({
      document,
      docId: "d1",
      model: {
        complete: model.complete.bind(model),
        streamComplete: (request) => {
          seen.push(request.messages.map((m) => String(m.content)).join("\n"));
          return model.streamComplete(request);
        },
      },
    });

    const answer = await chat.ask([
      pasted("We trained our models on one machine with 8 NVIDIA P100 GPUs", 7),
    ]);

    // 贴的是一整块的内容，所以检索捞回同一块时应当被剔掉；摘录本身仍在 prompt 里。
    expect(answer.citations.filter((c) => c.kind === "clip")).toHaveLength(1);
    expect(seen[0]).toContain("8 NVIDIA P100 GPUs");
  });
});

describe("哪些块已经在 prompt 里了", () => {
  const chunk = "We trained our models on one machine with 8 NVIDIA P100 GPUs.";

  it("块整个落在贴入内容里 ⟹ 是重复", () => {
    // 读者框了一整页，检索又从那页捞回一块——它一个字的新信息都不带。
    expect(isAlreadyPasted(chunk, [`前面一句。${chunk} 后面一句。`])).toBe(true);
  });

  it("**摘录在块里 ⟹ 不是重复**——那个块还有大半是新内容", () => {
    // 方向错过一次：两个方向都算重复的话，框一句话就会把所有含这句话的块清掉，
    // 而那恰恰是最相关的上下文。
    expect(isAlreadyPasted(`${chunk} 这一段还有五百多字的上下文……`, [chunk])).toBe(false);
  });

  it("空白不同不影响判定", () => {
    // 检索块来自 pdf.js 文本层，摘录来自框选后的拼接，两边的换行和空格不会严丝合缝。
    expect(isAlreadyPasted("We  trained\nour models", ["We trained our models on one machine"])).toBe(true);
  });

  it("没贴任何东西时什么都不删", () => {
    expect(isAlreadyPasted(chunk, [])).toBe(false);
  });
});

describe("追问带上一问", () => {
  const ask = (text: string) => ({ role: "user" as const, parts: [{ kind: "text" as const, text }] });
  const reply = (text: string) => ({ role: "assistant" as const, parts: [{ kind: "text" as const, text }] });

  it("退化的追问要带上上一个问题", () => {
    // 「那它呢」单独去检索什么都不指，实测正确地 abstain 了——但读者要的答案明明就在
    // 上一问指的那一段。
    const query = retrievalQuery([ask("多头注意力一共并行几个头？"), reply("八个。"), ask("那它呢？")]);

    expect(query).toContain("多头注意力");
    expect(query).toContain("那它呢");
  });

  it("只带最近那一个问题，不把整段历史都倒进去", () => {
    // 倒进去等于让三轮之前的话题继续影响这一次检索——读者早就聊到别处了。
    const query = retrievalQuery([
      ask("残差网络解决了什么问题？"),
      reply("退化问题。"),
      ask("多头注意力一共并行几个头？"),
      reply("八个。"),
      ask("那它呢？"),
    ]);

    expect(query).not.toContain("残差网络");
  });

  it("助手说了什么不进查询", () => {
    // 模型的回答可能长且发散，掺进查询会把检索带偏——而它本来就是从检索出来的东西
    // 生成的，等于让上一轮的检索结果决定这一轮检索什么。
    const query = retrievalQuery([ask("编码器有几层？"), reply("六层，每层两个子层。"), ask("那它呢？")]);

    expect(query).not.toContain("六层");
  });

  it("第一问不受影响", () => {
    expect(retrievalQuery([ask("编码器有几层？")])).toBe("编码器有几层？");
  });
});

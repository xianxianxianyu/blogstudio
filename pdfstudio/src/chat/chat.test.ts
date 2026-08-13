import { describe, expect, it } from "vitest";
import { createChat } from "./chat";
import { openFixturePdf } from "../../test/fixtures";
import { createFakeModelClient } from "../../test/fake-model-client";
import type { FakeModelOptions } from "../../test/fake-model-client";
import type { ClipSnapshot } from "./chat";
import type { Screenshot } from "../recognizer/recognizer";

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

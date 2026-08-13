import { describe, expect, it } from "vitest";
import { createChat } from "./chat";
import { openFixturePdf } from "../../test/fixtures";
import { createFakeModelClient } from "../../test/fake-model-client";
import type { FakeModelOptions } from "../../test/fake-model-client";

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

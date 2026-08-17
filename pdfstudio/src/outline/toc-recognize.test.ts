import { describe, expect, it } from "vitest";
import { recognizeTocPage } from "./toc-recognize";
import { RecognizeError } from "../recognizer/recognizer";
import { ModelError } from "../model/model-client";
import { createFakeModelClient } from "../../test/fake-model-client";
import type { Screenshot } from "../recognizer/recognizer";

const PAGE: Screenshot = { mime: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 1586, height: 2259 };

const answering = (payload: unknown) =>
  createFakeModelClient({ completeText: JSON.stringify(payload) });

describe("扫描版目录页交给模型", () => {
  it("拿回条目，并把整页图交上去", async () => {
    const model = answering({
      entries: [
        { title: "第 1 章 分布式系统的特征", page: 1, level: 0 },
        { title: "1.1 简介", page: 2, level: 1 },
      ],
    });

    const entries = await recognizeTocPage(model, PAGE);

    expect(entries).toEqual([
      { title: "第 1 章 分布式系统的特征", printedPage: 1, level: 0 },
      { title: "1.1 简介", printedPage: 2, level: 1 },
    ]);
    // 扫描版没有文本层，所以图是唯一的输入——不传图就只剩瞎猜。
    expect(model.completeCalls[0].images).toEqual([PAGE]);
  });

  it("坏条目丢掉，好条目留下——不为两条错的把整页作废", async () => {
    // 一页 40 条里错两条是常态。整页扔掉的话读者只剩「什么都没有」，
    // 而剩下的 38 条仍然有用（反正每一条都可以改）。
    const model = answering({
      entries: [
        { title: "第 1 章 特征", page: 1, level: 0 },
        { title: "", page: 5, level: 0 },
        { title: "缺页码的一行", level: 0 },
        { title: "页码不是数", page: "十二", level: 0 },
        { title: "第 2 章 系统模型", page: 37, level: 0 },
      ],
    });

    expect((await recognizeTocPage(model, PAGE)).map((entry) => entry.title)).toEqual([
      "第 1 章 特征",
      "第 2 章 系统模型",
    ]);
  });

  it("层级缺了或是负数一律归 0，不让它带崩后面的分组", async () => {
    const model = answering({ entries: [{ title: "附录 A", page: 601 }, { title: "附录 B", page: 610, level: -1 }] });

    expect((await recognizeTocPage(model, PAGE)).map((entry) => entry.level)).toEqual([0, 0]);
  });

  it("模型没返回 JSON 时抛 bad-output，不把 SyntaxError 漏给调用方", async () => {
    const model = createFakeModelClient({ completeText: "这一页的目录如下：第一章……" });

    const thrown = await recognizeTocPage(model, PAGE).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RecognizeError);
    expect((thrown as RecognizeError).kind).toBe("bad-output");
  });

  it("返回了 JSON 但没有 entries 也算坏输出", async () => {
    const thrown = await recognizeTocPage(answering({ ok: true }), PAGE).catch((error: unknown) => error);

    expect((thrown as RecognizeError).kind).toBe("bad-output");
  });

  it("端点调不通是 model-unavailable，与「模型乱答」分开", async () => {
    // 两者要分得开：一个该提示去查配置，一个该提示重试或换页。
    const model = createFakeModelClient({ completeError: new ModelError("http", "connect ECONNREFUSED") });

    const thrown = await recognizeTocPage(model, PAGE).catch((error: unknown) => error);

    expect((thrown as RecognizeError).kind).toBe("model-unavailable");
  });

  it("模型回了空，算坏输出而不是调不通", async () => {
    const model = createFakeModelClient({ completeError: new ModelError("empty-response", "空") });

    const thrown = await recognizeTocPage(model, PAGE).catch((error: unknown) => error);

    expect((thrown as RecognizeError).kind).toBe("bad-output");
  });
});

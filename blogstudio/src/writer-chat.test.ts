import { describe, expect, it, vi } from "vitest";
import { createWriterChat, type Message, type Model } from "./writer-chat";
import type { Recaller } from "./recall";
import type { Context } from "../../contextstudio/src/context";

function context(id: string, patch: Partial<Context> = {}): Context {
  return {
    id,
    sourceClipId: `clip_${id}`,
    source: { docId: "doc_1", title: "某本书", locator: "p.3" },
    claim: `断言 ${id}`,
    evidence: `证据 ${id}`,
    stance: null,
    status: "pending",
    sourceClipDeleted: false,
    topics: [],
    ...patch,
  };
}

/** 记下收到的 messages，按字吐回给定的答案。 */
function fakeModel(answer: string) {
  const seen: Message[][] = [];
  const model: Model = {
    async *streamComplete({ messages }) {
      seen.push(messages);
      for (const piece of answer.split(" ")) yield { textDelta: `${piece} ` };
    },
  };
  return { model, seen, prompt: () => seen[seen.length - 1].map((one) => one.content).join("\n\n") };
}

const recaller = (hits: Context[]): Recaller => ({
  recall: vi.fn(async () => hits.map((one, index) => ({ context: one, score: 1 - index * 0.1 }))),
});

describe("写作搭子", () => {
  it("稿子、材料、问题都进 prompt", async () => {
    const fake = fakeModel("好的");
    const chat = createWriterChat({
      model: fake.model,
      materials: async () => [context("c1")],
      recaller: recaller([context("c1")]),
    });

    await chat.ask([{ role: "user", text: "这段该怎么开头" }], { draft: "# 我的稿子\n\n正文" });

    expect(fake.prompt()).toContain("# 我的稿子");
    expect(fake.prompt()).toContain("[ctx:c1]");
    expect(fake.prompt()).toContain("这段该怎么开头");
  });

  it("**选中的那一段也拿去召回**——「这段怎么改」光凭问题几乎召不回任何东西", async () => {
    const found = recaller([]);
    const chat = createWriterChat({
      model: fakeModel("嗯").model,
      materials: async () => [context("c1")],
      recaller: found,
    });

    await chat.ask([{ role: "user", text: "这段怎么改", quoted: "召回率会掉" }], { draft: "正文" });

    expect(found.recall).toHaveBeenCalledWith(expect.stringContaining("召回率会掉"), expect.anything());
  });

  it("只认真的引用了的材料——回答里没提的不算出处", async () => {
    const chat = createWriterChat({
      model: fakeModel("这一点见 [ctx:c1] ，另一条我没用上").model,
      materials: async () => [context("c1"), context("c2")],
      recaller: recaller([context("c1"), context("c2")]),
    });

    const answer = await chat.ask([{ role: "user", text: "问" }], { draft: "正文" });

    expect(answer.recalled.map((one) => one.id)).toEqual(["c1", "c2"]);
    expect(answer.cited.map((one) => one.id)).toEqual(["c1"]);
  });

  it("**模型编出来的记号一律不算数**——库里没这条就不给出处", async () => {
    const chat = createWriterChat({
      model: fakeModel("依据 [ctx:根本不存在] 可知").model,
      materials: async () => [context("c1")],
      recaller: recaller([context("c1")]),
    });

    expect((await chat.ask([{ role: "user", text: "问" }], { draft: "正文" })).cited).toEqual([]);
  });

  it("一条都没召回时，明确告诉模型别编记号", async () => {
    const fake = fakeModel("嗯");
    const chat = createWriterChat({
      model: fake.model,
      materials: async () => [context("c1")],
      recaller: recaller([]),
    });

    await chat.ask([{ role: "user", text: "问" }], { draft: "正文" });

    expect(fake.prompt()).toContain("不要编造");
  });

  it("知识库读不出来不该让人问不了话——当成没有材料继续", async () => {
    const chat = createWriterChat({
      model: fakeModel("嗯").model,
      materials: () => Promise.reject(new Error("库挂了")),
      recaller: recaller([]),
    });

    await expect(chat.ask([{ role: "user", text: "问" }], { draft: "正文" })).resolves.toBeTruthy();
  });

  it("边生成边报的是累计文本", async () => {
    const seen: string[] = [];
    const chat = createWriterChat({
      model: fakeModel("一 二 三").model,
      materials: async () => [],
      recaller: recaller([]),
    });

    await chat.ask([{ role: "user", text: "问" }], { draft: "", onText: (text) => seen.push(text) });

    expect(seen).toEqual(["一 ", "一 二 ", "一 二 三 "]);
  });

  it("**长稿子掐中间、两头都留，而且要在 prompt 里说出来**", async () => {
    const fake = fakeModel("嗯");
    const chat = createWriterChat({
      model: fake.model,
      materials: async () => [],
      recaller: recaller([]),
    });
    const draft = `开头的话${"中".repeat(20000)}结尾的话`;

    await chat.ask([{ role: "user", text: "问" }], { draft });

    expect(fake.prompt()).toContain("开头的话");
    expect(fake.prompt()).toContain("结尾的话");
    expect(fake.prompt()).toContain("中间略去");
  });
});

describe("联网搜索", () => {
  const search = (hits: { title: string; url: string; content: string }[]) => ({
    search: vi.fn(async () => hits),
  });

  it("开着联网就先搜一次，网页进 prompt、也回给界面", async () => {
    const fake = fakeModel("见 [文档](https://a)");
    const web = search([{ title: "文档", url: "https://a", content: "甲" }]);
    const chat = createWriterChat({ model: fake.model, materials: async () => [], recaller: recaller([]), search: web });

    const answer = await chat.ask([{ role: "user", text: "kv cache 最近有什么" }], { draft: "", web: true });

    expect(web.search).toHaveBeenCalledWith("kv cache 最近有什么", undefined);
    expect(fake.prompt()).toContain("[文档](https://a)");
    expect(answer.hits).toEqual([{ title: "文档", url: "https://a", content: "甲" }]);
    expect(answer.searchFailed).toBeNull();
  });

  it("关着联网就不搜；没接搜索时开关也不起作用", async () => {
    const fake = fakeModel("好");
    const web = search([]);
    const chat = createWriterChat({ model: fake.model, materials: async () => [], recaller: recaller([]), search: web });
    await chat.ask([{ role: "user", text: "x" }], { draft: "", web: false });
    expect(web.search).not.toHaveBeenCalled();

    const bare = createWriterChat({ model: fake.model, materials: async () => [], recaller: recaller([]) });
    const answer = await bare.ask([{ role: "user", text: "x" }], { draft: "", web: true });
    expect(answer.hits).toEqual([]);
  });

  it("**搜不成不拦回答**：答照给，原因摆在旁边", async () => {
    const fake = fakeModel("照答");
    const chat = createWriterChat({
      model: fake.model,
      materials: async () => [],
      recaller: recaller([]),
      search: { search: async () => { throw new Error("搜索失败：HTTP 432 额度用完"); } },
    });
    const answer = await chat.ask([{ role: "user", text: "x" }], { draft: "", web: true });
    expect(answer.text.trim()).toBe("照答");
    expect(answer.searchFailed).toContain("432");
    // RULES 里也有这几个字，所以认的是材料那一段的标题（带冒号）。
    expect(fake.prompt()).not.toContain("联网查到的网页：");
  });
});

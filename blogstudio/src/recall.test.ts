import { describe, expect, it, vi } from "vitest";
import { createRecaller, type Embed } from "./recall";
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

/** 假向量：按 id 给一条钉死的向量，测的是选取规则而不是某个 embedding 模型。 */
const fakeEmbed = (table: Record<string, number[]>): Embed => ({
  embedQuery: async (text) => new Float32Array(table[text]),
  embedDocuments: async (texts) =>
    texts.map((text) => new Float32Array(table[text] ?? table[text.split("\n")[0]])),
});

describe("召回", () => {
  it("按语义排序，最像的排前面", async () => {
    const pool = [context("a"), context("b"), context("c"), context("d")];
    const embed = fakeEmbed({
      问题: [1, 0],
      "断言 a\n证据 a": [0.2, 1],
      "断言 b\n证据 b": [1, 0.05],
      "断言 c\n证据 c": [0.1, 1],
      "断言 d\n证据 d": [0.15, 1],
    });

    const hits = await createRecaller({ embed }).recall("问题", pool);

    expect(hits[0].context.id).toBe("b");
  });

  it("**尖峰不明显就一条都不给**——硬塞不相干的材料，模型会围着它们认真地写", async () => {
    const pool = ["a", "b", "c", "d"].map((id) => context(id));
    const flat = fakeEmbed({
      问题: [1, 0],
      "断言 a\n证据 a": [1, 1],
      "断言 b\n证据 b": [1, 1.02],
      "断言 c\n证据 c": [1, 0.98],
      "断言 d\n证据 d": [1, 1.01],
    });

    expect(await createRecaller({ embed: flat }).recall("问题", pool)).toEqual([]);
  });

  it("库小于四条时不谈分布——三条材料的中位数没有意义", async () => {
    const pool = [context("a"), context("b")];
    const embed = fakeEmbed({
      问题: [1, 0],
      "断言 a\n证据 a": [1, 0.9],
      "断言 b\n证据 b": [1, 0.95],
    });

    expect(await createRecaller({ embed }).recall("问题", pool)).toHaveLength(2);
  });

  it("**改了主题就重算这一条**——只按 id 缓存的话，改完召回还是老样子且不报错", async () => {
    const embed = {
      embedQuery: vi.fn(async () => new Float32Array([1, 0])),
      embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0]))),
    };
    const recaller = createRecaller({ embed });

    await recaller.recall("问题", [context("a")]);
    await recaller.recall("问题", [context("a")]);
    expect(embed.embedDocuments).toHaveBeenCalledTimes(1);

    await recaller.recall("问题", [context("a", { topics: ["新主题"] })]);
    expect(embed.embedDocuments).toHaveBeenCalledTimes(2);
  });

  it("空问题、空库都直接返回空，不去打模型", async () => {
    const embed = {
      embedQuery: vi.fn(),
      embedDocuments: vi.fn(),
    } as unknown as Embed;

    expect(await createRecaller({ embed }).recall("   ", [context("a")])).toEqual([]);
    expect(await createRecaller({ embed }).recall("问题", [])).toEqual([]);
    expect(embed.embedQuery).not.toHaveBeenCalled();
  });

  it("没接向量就退化成二元组重合——差，但不是零", async () => {
    const pool = [
      context("a", { claim: "纯 tag 匹配在库大了以后召回率会掉" }),
      context("b", { claim: "扫描版的目录页要交给模型认" }),
      context("c", { claim: "捏合缩放在 Electron 里到不了 touch 事件" }),
      context("d", { claim: "摘录到期会衰减" }),
    ];

    const hits = await createRecaller().recall("tag 匹配的召回率如何", pool);

    expect(hits[0].context.id).toBe("a");
  });
});

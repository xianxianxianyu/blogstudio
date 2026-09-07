import { describe, expect, it } from "vitest";
import type { Context } from "./context";
import { buildGraph } from "./graph";
import { proposeTopics } from "./intake";

function context(id: string, topics: string[]): Context {
  return {
    id,
    sourceClipId: "clip_" + id,
    source: { docId: "doc_1", title: "某篇论文", locator: "p.1" },
    claim: "断言 " + id,
    evidence: "逐字原文 " + id,
    stance: null,
    status: "pending",
    sourceClipDeleted: false,
    topics,
  };
}

/** 造一个库：`spec` 是「主题 → 挂了几条」。 */
function library(spec: Record<string, number>) {
  const contexts: Context[] = [];
  for (const [topic, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i++) contexts.push(context(`${topic}_${i}`, [topic]));
  }
  return buildGraph(contexts);
}

describe("proposeTopics", () => {
  it("模型给的写法不一样时，对齐到池里已经在用的那个", () => {
    const proposal = proposeTopics(library({ eval: 3 }), ["Eval"]);

    expect(proposal.topics).toEqual(["eval"]);
  });

  // ADR-0003 胜出的真正原因是「窄」——摊开一大把候选，读者就会顺手多点几个，
  // 而那正是假边的来源。模型不会自觉守这条，所以在代码里截断。
  it("模型给一大把，只留前两个", () => {
    const proposal = proposeTopics(library({}), ["a", "b", "c", "d", "e"]);

    expect(proposal.topics).toEqual(["a", "b"]);
  });

  it("候选里的重复写法先合并，再算数量", () => {
    const proposal = proposeTopics(library({}), ["rag", "RAG", " rag ", "eval"]);

    expect(proposal.topics).toEqual(["rag", "eval"]);
  });

  it("模型什么也没给出来时，主题就是空的——孤儿是合法的", () => {
    const proposal = proposeTopics(library({ eval: 3 }), []);

    expect(proposal.topics).toEqual([]);
  });

  it("空白候选不算候选", () => {
    const proposal = proposeTopics(library({}), ["  ", "rag"]);

    expect(proposal.topics).toEqual(["rag"]);
  });

  // ADR-0003 自己承认「假边没有药」。issue 05 发现 IDF 天然是笼统主题的检测器——
  // 一个什么都挂的主题信息量趋近于零。这里不拦，只提醒；读者说了算。
  it("候选是个什么都挂的主题时，提醒一句", () => {
    const graph = library({ "agent-design": 40, rag: 5, eval: 5 });

    const proposal = proposeTopics(graph, ["agent-design"]);

    expect(proposal.topics).toEqual(["agent-design"]);
    expect(proposal.vague).toEqual([{ topic: "agent-design", display: "agent-design", size: 40 }]);
  });

  it("挂得不多的主题不提醒", () => {
    const graph = library({ "agent-design": 40, rag: 5, eval: 5 });

    expect(proposeTopics(graph, ["rag"]).vague).toEqual([]);
  });

  // 一个刚出现的新主题当然「不笼统」，但那是因为它还没被用过，不是因为它精确。
  // 拿它去触发提醒会让每条新主题都被质疑一遍。
  it("池里还没有的新主题不提醒", () => {
    const proposal = proposeTopics(library({ "agent-design": 40 }), ["全新的主题"]);

    expect(proposal.topics).toEqual(["全新的主题"]);
    expect(proposal.vague).toEqual([]);
  });

  it("笼统的判定线可以调——阈值还没用真实数据标定过", () => {
    const graph = library({ "agent-design": 40, rag: 5, eval: 5 });

    expect(proposeTopics(graph, ["rag"], { vagueAbove: 0.05 }).vague).toEqual([
      { topic: "rag", display: "rag", size: 5 },
    ]);
  });

  // code review 抓到的：`spelling` 曾是个恒等 Map，「对齐到池里在用的写法」拿到的是
  // 归一化后的小写。读者写「Agent Design」，第二次入库就被系统改成「agent design」。
  // 旧测试的 fixture 池全是小写，正好遮住了它。
  it("对齐到的是读者写的那份，不是归一化后的小写", () => {
    const graph = buildGraph([context("a", ["Agent Design"]), context("b", ["Agent Design"])]);

    expect(proposeTopics(graph, ["AGENT DESIGN"]).topics).toEqual(["Agent Design"]);
  });

  it("池里没有的新主题，保留模型给的写法", () => {
    expect(proposeTopics(library({}), ["Agent Design"]).topics).toEqual(["Agent Design"]);
  });
});

import { describe, expect, it } from "vitest";
import type { Context } from "./context";
import { buildGraph } from "./graph";

/** 只填测试关心的字段，其余给个不影响判定的默认值。 */
function context(id: string, topics: string[], patch: Partial<Context> = {}): Context {
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
    ...patch,
  };
}

describe("buildGraph", () => {
  it("没有主题的 context 是孤儿：它仍然是节点，但一条边都不连", () => {
    const graph = buildGraph([context("a", []), context("b", [])]);

    expect(graph.edges).toEqual([]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(graph.nodes.every((node) => node.degree === 0)).toBe(true);
  });

  it("共享一个主题就连一条边，边记住共享的是哪个主题", () => {
    const graph = buildGraph([context("a", ["eval"]), context("b", ["eval"])]);

    expect(graph.edges).toEqual([{ a: "a", b: "b", topics: ["eval"] }]);
    expect(graph.nodes.map((node) => node.degree)).toEqual([1, 1]);
  });

  it("主题不同就不连边", () => {
    const graph = buildGraph([context("a", ["eval"]), context("b", ["rag"])]);

    expect(graph.edges).toEqual([]);
  });

  it("共享两个主题仍然只有一条边，topics 有两项", () => {
    const graph = buildGraph([
      context("a", ["eval", "rag"]),
      context("b", ["eval", "rag"]),
    ]);

    expect(graph.edges).toEqual([{ a: "a", b: "b", topics: ["eval", "rag"] }]);
    expect(graph.nodes.map((node) => node.degree)).toEqual([1, 1]);
  });

  it("三条同主题的 context 连成 3 条边（n(n-1)/2）", () => {
    const graph = buildGraph([
      context("a", ["eval"]),
      context("b", ["eval"]),
      context("c", ["eval"]),
    ]);

    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.map((node) => node.degree)).toEqual([2, 2, 2]);
  });

  // 没有这条，两次调用会算出同一张图但排列不同——落盘就 diff 不出来，快照测试也钉不住。
  it("边是定序的：换一个输入顺序，边完全一样", () => {
    const a = context("a", ["eval", "rag"]);
    const b = context("b", ["rag"]);
    const c = context("c", ["eval"]);

    expect(buildGraph([c, a, b]).edges).toEqual(buildGraph([a, b, c]).edges);
  });

  it("边内的 topics 也定序，不跟着输入里主题的先后走", () => {
    const forward = buildGraph([context("a", ["rag", "eval"]), context("b", ["eval", "rag"])]);

    expect(forward.edges[0].topics).toEqual(["eval", "rag"]);
  });

  // 归一化放在这里而不是入库口：主题是读者手打的，大小写和空格的差别不是语义差别。
  it("大小写与前后空格不算不同的主题", () => {
    const graph = buildGraph([context("a", ["Agent Design"]), context("b", ["  agent design "])]);

    expect(graph.edges).toEqual([{ a: "a", b: "b", topics: ["agent design"] }]);
  });

  it("同一条 context 把一个主题写了两遍，不会连到它自己", () => {
    const graph = buildGraph([context("a", ["eval", "Eval"]), context("b", ["eval"])]);

    expect(graph.edges).toEqual([{ a: "a", b: "b", topics: ["eval"] }]);
    expect(graph.edges.every((edge) => edge.a !== edge.b)).toBe(true);
    expect(graph.nodes.map((node) => node.degree)).toEqual([1, 1]);
  });

  // 直接把 rejected 从图上抹掉，读者就会隔几周再捡回同一条烂材料。
  // 它留在图上，但节点带着 status，渲染层可以画暗。
  it("被否决的 context 仍然是节点、仍然连边，只是带着 rejected", () => {
    const graph = buildGraph([
      context("a", ["eval"], { status: "rejected" }),
      context("b", ["eval"]),
    ]);

    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.map((node) => node.status)).toEqual(["rejected", "pending"]);
  });

  it("节点带上 claim，图上不用回头查库就能显示它说了什么", () => {
    const graph = buildGraph([context("a", ["eval"], { claim: "tag 匹配召回率会掉" })]);

    expect(graph.nodes[0].claim).toBe("tag 匹配召回率会掉");
  });

  // 排序要用的是频次，不是 IDF——频次是事实，IDF 是一条排序政策，
  // 政策放在渲染层，`buildGraph` 只交出事实。
  it("交出每个主题挂了几条，按条数降序、同数按字典序", () => {
    const graph = buildGraph([
      context("a", ["rag", "eval"]),
      context("b", ["eval"]),
      context("c", ["eval", "本地模型"]),
    ]);

    expect(graph.topics).toEqual([
      { topic: "eval", size: 3 },
      { topic: "rag", size: 1 },
      { topic: "本地模型", size: 1 },
    ]);
  });

  it("主题频次也按归一化后的形式统计", () => {
    const graph = buildGraph([context("a", ["Eval"]), context("b", [" eval "])]);

    expect(graph.topics).toEqual([{ topic: "eval", size: 2 }]);
  });

  it("空白主题不算主题，不产生边", () => {
    const graph = buildGraph([context("a", ["   "]), context("b", [""])]);

    expect(graph.edges).toEqual([]);
    expect(graph.nodes.every((node) => node.degree === 0)).toBe(true);
  });
});

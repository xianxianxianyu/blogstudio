import { describe, expect, it } from "vitest";
import type { Context } from "./context";
import { buildGraph } from "./graph";
import { focusOn } from "./focus";

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

describe("focusOn", () => {
  it("只给这一条和它的邻居，中心自己不在邻居里", () => {
    const graph = buildGraph([
      context("a", ["rag"]),
      context("b", ["rag"]),
      context("c", ["eval"]),
    ]);

    const focus = focusOn(graph, "a");

    expect(focus!.center.id).toBe("a");
    expect(focus!.neighbors.map((n) => n.context.id)).toEqual(["b"]);
  });

  it("邻居带上共享的是哪几个主题——点开一条边要能说出它为什么连", () => {
    const graph = buildGraph([context("a", ["rag", "eval"]), context("b", ["rag", "eval"])]);

    expect(focusOn(graph, "a")!.neighbors[0].topics).toEqual(["eval", "rag"]);
  });

  // issue 05 的定案。理由不是「冷门更有意思」这种直觉——是 94% 的边只共享 1 个主题，
  // 所以「共享几个」对绝大多数邻居给出同一个分数，压根排不出名次。
  it("共享冷门主题的邻居，排在共享热门主题的前面", () => {
    const crowd = Array.from({ length: 18 }, (_, i) => context("hot_" + i, ["热门"]));
    const graph = buildGraph([
      context("center", ["热门", "冷门"]),
      context("shares-hot", ["热门"]),
      context("shares-cold", ["冷门"]),
      ...crowd,
    ]);

    const focus = focusOn(graph, "center")!;

    expect(focus.neighbors[0].context.id).toBe("shares-cold");
  });

  it("共享两个主题比只共享一个更靠前", () => {
    const graph = buildGraph([
      context("center", ["rag", "eval"]),
      context("one", ["rag"]),
      context("two", ["rag", "eval"]),
    ]);

    expect(focusOn(graph, "center")!.neighbors.map((n) => n.context.id)).toEqual(["two", "one"]);
  });

  // 截掉的要显式说出来。静默丢弃会让读者以为这个节点就这么点邻居。
  it("默认只给前 8 个，剩下的报个数", () => {
    const crowd = Array.from({ length: 20 }, (_, i) => context("n" + i, ["rag"]));
    const graph = buildGraph([context("center", ["rag"]), ...crowd]);

    const focus = focusOn(graph, "center")!;

    expect(focus.neighbors).toHaveLength(8);
    expect(focus.hidden).toBe(12);
  });

  it("截断条数可以调", () => {
    const crowd = Array.from({ length: 20 }, (_, i) => context("n" + i, ["rag"]));
    const graph = buildGraph([context("center", ["rag"]), ...crowd]);

    expect(focusOn(graph, "center", 3)!.hidden).toBe(17);
  });

  it("孤儿：没有邻居，也没有被截掉的", () => {
    const graph = buildGraph([context("a", []), context("b", ["rag"])]);

    const focus = focusOn(graph, "a")!;

    expect(focus.neighbors).toEqual([]);
    expect(focus.hidden).toBe(0);
  });

  // 重导之后某条 context 可能没了，而界面上还留着上次选中的 id。
  it("聚焦一个不存在的 id，给 null 而不是崩", () => {
    expect(focusOn(buildGraph([context("a", ["rag"])]), "没这条")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { Context } from "./context";
import { buildGraph } from "./graph";
import { cluster } from "./cluster";

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

/** 造一批讲同一件事的 context。 */
function batch(prefix: string, count: number, topics: string[]) {
  return Array.from({ length: count }, (_, i) => context(`${prefix}${i}`, topics));
}

describe("cluster", () => {
  it("讲同一件事的连成一簇，井水不犯河水的分开", () => {
    const clustering = cluster(
      buildGraph([...batch("rag_", 3, ["rag"]), ...batch("bat_", 3, ["电池"])]),
    );

    expect(clustering.clusters.map((one) => one.contexts)).toEqual([
      ["bat_0", "bat_1", "bat_2"],
      ["rag_0", "rag_1", "rag_2"],
    ]);
  });

  it("簇的标签就是簇内的主题，按簇内条数降序", () => {
    const clustering = cluster(
      buildGraph([
        ...batch("a", 3, ["rag", "eval"]),
        context("a3", ["rag"]),
        ...batch("b", 3, ["电池"]),
      ]),
    );

    const rag = clustering.clusters.find((one) => one.contexts.includes("a0"))!;
    expect(rag.topics).toEqual([
      { topic: "rag", display: "rag", size: 4 },
      { topic: "eval", display: "eval", size: 3 },
    ]);
  });

  it("簇内条数是簇内自己数的，不是全库频次", () => {
    const clustering = cluster(
      buildGraph([
        ...batch("a", 4, ["rag", "共用"]),
        ...batch("b", 4, ["电池", "共用"]),
        ...batch("c", 4, ["编译器", "共用"]),
      ]),
    );

    const first = clustering.clusters[0];
    // 「共用」全库 12 条，但在这一簇里只有 4 条。用全库数字会让它显得比实际重。
    expect(first.topics.find((stat) => stat.topic === "共用")!.size).toBe(4);
  });

  it("没有主题的落进 orphans，不算一簇", () => {
    const clustering = cluster(buildGraph([...batch("a", 3, ["rag"]), context("孤儿", [])]));

    expect(clustering.clusters).toHaveLength(1);
    expect(clustering.orphans).toEqual(["孤儿"]);
  });

  // **这一条是整个模块换算法的理由。** 连通分量在这里给的是「一整块」：实测 320 条真实
  // 形状的库连通分量 100% 是一簇，要剪开得砍掉 22/60 个主题、把 155 条打成孤儿。
  // 按稀有度加权之后，笼统主题自己变轻，结构不用剪就出来了。
  it("一个什么都挂的主题，不该把所有东西粘成一块", () => {
    const clustering = cluster(
      buildGraph([...batch("a", 5, ["万物", "rag"]), ...batch("b", 5, ["万物", "电池"])]),
    );

    expect(clustering.clusters.map((one) => one.contexts)).toEqual([
      ["a0", "a1", "a2", "a3", "a4"],
      ["b0", "b1", "b2", "b3", "b4"],
    ]);
  });

  // `log(n/size)` 对「每条都挂」的主题恰好给 0。全库只用一个主题时所有边权都是 0，
  // 总权重也是 0——整个库会被报成一堆孤儿。`log(1 + n/size)` 是为了堵这个退化。
  it("全库只有一个主题时，它们仍然是一簇，不是一堆孤儿", () => {
    const clustering = cluster(buildGraph(batch("a", 4, ["唯一的主题"])));

    expect(clustering.orphans).toEqual([]);
    expect(clustering.clusters.map((one) => one.contexts)).toEqual([["a0", "a1", "a2", "a3"]]);
  });

  // 模块度是给自己看的：分不开的时候也会给出一堆簇，不说的话没人知道那是噪声。
  it("分得开时模块度明显为正，一团浆糊时接近 0", () => {
    const split = cluster(buildGraph([...batch("a", 6, ["rag"]), ...batch("b", 6, ["电池"])]));
    const blob = cluster(buildGraph(batch("x", 6, ["同一个主题"])));

    expect(split.modularity).toBeGreaterThan(0.3);
    expect(blob.modularity).toBeLessThan(0.1);
  });

  it("空库不是错误，是新装应用的正常状态", () => {
    expect(cluster(buildGraph([]))).toEqual({ clusters: [], orphans: [], modularity: 0 });
  });

  // Louvain 原文是随机遍历顺序，那意味着同一批 context 刷新一次就换一种分法，
  // 读者会以为库变了。这里按下标顺序遍历、同分取簇号小的，两处都是为了这条。
  it("换个输入顺序，分法一样", () => {
    const contexts = [
      ...batch("a", 4, ["rag", "eval"]),
      ...batch("b", 4, ["电池", "材料"]),
      context("孤儿", []),
    ];

    const forward = cluster(buildGraph(contexts));
    const backward = cluster(buildGraph([...contexts].reverse()));

    expect(backward).toEqual(forward);
  });
});

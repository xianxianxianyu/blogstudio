import type { Graph, Node } from "./graph";

export interface Neighbor {
  context: Node;
  /** 和中心共享的是哪几个主题。点开一条边要能说出它为什么连。 */
  topics: string[];
}

export interface Focus {
  center: Node;
  /** 按稀有度降序，最多 `limit` 个。 */
  neighbors: Neighbor[];
  /** 被截掉的邻居数。**显式说出来**——静默丢弃会让读者以为这个节点就这么点邻居。 */
  hidden: number;
}

/**
 * 默认给几个邻居。issue 05 在原型里试过 5 / 8 / 15：5 条太少，读者会觉得这个节点很孤立；
 * 15 条已经要滚动，而滚动就等于没有截断。
 */
const DEFAULT_LIMIT = 8;

/**
 * 一条边的稀有度：共享的每个主题的 IDF 之和。
 *
 * 排序依据选它，理由不是「冷门更有意思」这种直觉——是 2000 条时 **94% 的边只共享
 * 1 个主题**，所以「共享几个」对绝大多数邻居给出同一个分数，压根排不出名次，
 * 剩下的顺序由数组下标决定，等于随机。稀有度能给这 94% 排出先后。
 *
 * **IDF 是排序政策，所以住在这里，不在 `buildGraph` 里**——那边只交出频次这个事实。
 */
function rarity(topics: string[], size: Map<string, number>, total: number): number {
  return topics.reduce((sum, topic) => sum + Math.log(total / (size.get(topic) || 1)), 0);
}

/**
 * 聚焦视图的 view model：一个节点和它的一跳邻居。
 *
 * **这是知识图唯一能用的主视图，不是一个附加功能。** 原型量过：断言级粒度下全局图在
 * 60 条上下就糊成一团，2000 条时有 14 万条边、最大度数 469
 * （`.scratch/knowledge-graph/issues/05`）。
 *
 * 纯函数，不含坐标也不含布局——那是渲染层的事。
 */
export function focusOn(graph: Graph, id: string, limit: number = DEFAULT_LIMIT): Focus | null {
  const center = graph.nodes.find((node) => node.id === id);
  if (!center) return null;

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const size = new Map(graph.topics.map((stat) => [stat.topic, stat.size]));
  const found: { neighbor: Neighbor; score: number }[] = [];

  for (const edge of graph.edges) {
    if (edge.a !== id && edge.b !== id) continue;
    const other = byId.get(edge.a === id ? edge.b : edge.a);
    if (!other) continue;
    found.push({
      neighbor: { context: other, topics: edge.topics },
      score: rarity(edge.topics, size, graph.nodes.length),
    });
  }

  // 同分时按 id 定序，否则同一张图算两次会给出不同的前 8。
  found.sort((left, right) =>
    right.score - left.score || left.neighbor.context.id.localeCompare(right.neighbor.context.id));

  return {
    center,
    neighbors: found.slice(0, limit).map((entry) => entry.neighbor),
    hidden: Math.max(0, found.length - limit),
  };
}

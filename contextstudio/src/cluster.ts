import { normalizeTopic, rarity, topicIndex, type Graph, type TopicStat } from "./graph";

export interface Cluster {
  /** 稳定 id：成员里字典序最小的那个 context id。重算一次不该换名字。 */
  id: string;
  contexts: string[];
  /** 把这一簇粘在一起的主题，按簇内条数降序。**这就是这一簇的标签**。 */
  topics: TopicStat[];
}

export interface Clustering {
  /** 按大小降序，不含单点。 */
  clusters: Cluster[];
  /** 落单的：一条边都没有的孤儿，以及自成一簇的。 */
  orphans: string[];
  /**
   * 模块度，`[-0.5, 1)`。**这个数是给自己看的，不是给读者看的**——它衡量分出来的簇比
   * 随机连边好多少。经验上 0.3 以上算有结构，接近 0 就是「这批 context 本来就分不开」。
   *
   * 交出来是为了让「聚类失败」可见。分不开时给一堆簇也是给，不说的话没人知道那是噪声。
   */
  modularity: number;
}

/**
 * 边权用 `graph.ts` 的 `rarity`——和 `focus.ts` 排邻居是同一个数。
 *
 * **这是这个模块的胜负手。** 无权图上聚类必然失败，量过：60 主题偏斜分布下，320 条的
 * 连通分量是**一整块 100%**；要把它剪开得砍掉 22/60 个主题、把 155 条打成孤儿——
 * 那不是聚类，是拆房子。
 *
 * 原因是笼统主题（实测最热的一个挂了 28%）把所有东西连成一片，而它携带的信息趋近于零。
 * 加权之后它自己就轻了，结构自己浮出来，**而且一条数据都没丢**——这比硬剪主题好，
 * 剪掉的边读者永远看不见了。加权版实测分出 9 簇、最大簇 23%、模块度 0.371。
 */

/** 邻接表。Louvain 要反复重建聚合图，所以用下标而不是 id。 */
interface Weighted {
  size: number;
  adjacency: { to: number; weight: number }[][];
  /** 聚合后的自环：一个簇内部的边聚合成节点自己身上的权重。 */
  loops: number[];
  /** 加权度数，含自环两次。 */
  degrees: number[];
  /** 所有边权之和。 */
  total: number;
}

function weighted(
  size: number,
  edges: { a: number; b: number; weight: number }[],
  loops: number[],
): Weighted {
  const adjacency: { to: number; weight: number }[][] = Array.from({ length: size }, () => []);
  for (const edge of edges) {
    adjacency[edge.a].push({ to: edge.b, weight: edge.weight });
    adjacency[edge.b].push({ to: edge.a, weight: edge.weight });
  }
  const degrees = adjacency.map((links, at) =>
    links.reduce((sum, link) => sum + link.weight, 2 * loops[at]),
  );
  const total = edges.reduce((sum, edge) => sum + edge.weight, 0) + loops.reduce((a, b) => a + b, 0);
  return { size, adjacency, loops, degrees, total };
}

/**
 * Louvain 的局部移动：反复把每个节点挪到「挪过去模块度涨得最多」的邻居簇，直到没得挪。
 *
 * **按下标顺序遍历、同分取簇号小的**，两处都是为了确定性。Louvain 原文是随机顺序，
 * 而随机顺序意味着同一批 context 刷新一次就换一种分法——读者会以为库变了。
 */
function localMoving(graph: Weighted): { community: number[]; moved: boolean } {
  const community = Array.from({ length: graph.size }, (_, at) => at);
  const inside = graph.degrees.slice();
  const twice = 2 * graph.total;
  if (twice === 0) return { community, moved: false };

  let movedEver = false;
  for (let round = 0; round < 32; round++) {
    let moved = false;
    for (let at = 0; at < graph.size; at++) {
      const from = community[at];
      const links = new Map<number, number>();
      for (const link of graph.adjacency[at]) {
        if (link.to === at) continue;
        links.set(community[link.to], (links.get(community[link.to]) ?? 0) + link.weight);
      }

      // 先摘出来，否则算「留在原簇」的收益时会把自己的度数算进原簇。
      inside[from] -= graph.degrees[at];

      let best = from;
      let bestGain = (links.get(from) ?? 0) - (inside[from] * graph.degrees[at]) / twice;
      for (const to of [...links.keys()].sort((left, right) => left - right)) {
        const gain = links.get(to)! - (inside[to] * graph.degrees[at]) / twice;
        if (gain > bestGain) {
          best = to;
          bestGain = gain;
        }
      }

      inside[best] += graph.degrees[at];
      community[at] = best;
      if (best !== from) {
        moved = true;
        movedEver = true;
      }
    }
    if (!moved) break;
  }

  return { community, moved: movedEver };
}

/** 把每个簇缩成一个节点，簇内的边变成自环。Louvain 的第二相。 */
function aggregate(graph: Weighted, community: number[]): { next: Weighted; index: number[] } {
  const renumber = new Map<number, number>();
  for (const at of community) if (!renumber.has(at)) renumber.set(at, renumber.size);
  const index = community.map((at) => renumber.get(at)!);

  const loops = new Array<number>(renumber.size).fill(0);
  const between = new Map<string, number>();
  for (let at = 0; at < graph.size; at++) {
    loops[index[at]] += graph.loops[at];
    for (const link of graph.adjacency[at]) {
      if (link.to < at) continue; // 每条边只数一次
      const [a, b] = [index[at], index[link.to]];
      if (a === b) loops[a] += link.weight;
      else {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        between.set(key, (between.get(key) ?? 0) + link.weight);
      }
    }
  }

  const edges = [...between.entries()].map(([key, weight]) => {
    const [a, b] = key.split("|").map(Number);
    return { a, b, weight };
  });
  return { next: weighted(renumber.size, edges, loops), index };
}

/** 分出来的簇比随机连边好多少。`[-0.5, 1)`，0.3 以上算有结构。 */
function modularityOf(graph: Weighted, community: number[]): number {
  const twice = 2 * graph.total;
  if (twice === 0) return 0;
  const inside = new Map<number, number>();
  const degree = new Map<number, number>();
  for (let at = 0; at < graph.size; at++) {
    const one = community[at];
    degree.set(one, (degree.get(one) ?? 0) + graph.degrees[at]);
    inside.set(one, (inside.get(one) ?? 0) + graph.loops[at]);
    for (const link of graph.adjacency[at]) {
      if (community[link.to] === one && link.to > at) {
        inside.set(one, (inside.get(one) ?? 0) + link.weight);
      }
    }
  }
  let sum = 0;
  for (const [one, weight] of inside) {
    sum += weight / graph.total - ((degree.get(one) ?? 0) / twice) ** 2;
  }
  return sum;
}

/**
 * 把知识图分簇：**Louvain（模块度最优化），边按主题稀有度加权**。
 *
 * 为什么不是连通分量——见 `weigh` 的注释：那个在这个密度上分不开，量过。
 *
 * 纯函数，同 `buildGraph`：布局和配色是渲染层的事。
 */
export function cluster(graph: Graph): Clustering {
  const index = topicIndex(graph);
  const at = new Map(graph.nodes.map((node, position) => [node.id, position]));

  let current = weighted(
    graph.nodes.length,
    graph.edges.map((edge) => ({
      a: at.get(edge.a)!,
      b: at.get(edge.b)!,
      weight: rarity(edge.topics, index, graph.nodes.length),
    })),
    new Array<number>(graph.nodes.length).fill(0),
  );

  // 每一层把上一层的簇缩成节点再分一次，直到分不动。层数上限只是防呆——
  // 实际收敛在个位数层内，聚合图每层至少小一半。
  let belongs = Array.from({ length: graph.nodes.length }, (_, position) => position);
  for (let level = 0; level < 16; level++) {
    const { community, moved } = localMoving(current);
    if (!moved) break;
    const { next, index: renumbered } = aggregate(current, community);
    belongs = belongs.map((one) => renumbered[one]);
    current = next;
  }

  const modularity = modularityOf(current, Array.from({ length: current.size }, (_, one) => one));

  const members = new Map<number, string[]>();
  graph.nodes.forEach((node, position) => {
    const one = belongs[position];
    const group = members.get(one);
    if (group) group.push(node.id);
    else members.set(one, [node.id]);
  });

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const clusters: Cluster[] = [];
  const orphans: string[] = [];

  for (const contexts of members.values()) {
    if (contexts.length === 1) {
      orphans.push(contexts[0]);
      continue;
    }
    contexts.sort();

    // 簇内频次自己数，不能直接用全库的 `TopicStat.size`——一个主题在**这一簇里**挂了
    // 几条，才是「这一簇讲什么」。全库数字会让跨簇的主题显得比它在这里的分量重。
    const inCluster = new Map<string, number>();
    for (const id of contexts) {
      // 同一条 context 把一个主题写了两遍，不该在簇内计两次。
      for (const key of new Set((byId.get(id)?.topics ?? []).map(normalizeTopic))) {
        if (key === "") continue;
        inCluster.set(key, (inCluster.get(key) ?? 0) + 1);
      }
    }

    clusters.push({
      id: contexts[0],
      contexts,
      topics: [...inCluster.entries()]
        .map(([topic, size]) => ({ topic, display: index.get(topic)?.display ?? topic, size }))
        .sort((left, right) => right.size - left.size || left.topic.localeCompare(right.topic)),
    });
  }

  // 定序，理由同 `buildGraph`：同一批 context 换个顺序不该算出排列不同的结果。
  clusters.sort(
    (left, right) => right.contexts.length - left.contexts.length || left.id.localeCompare(right.id),
  );
  orphans.sort();

  return { clusters, orphans, modularity };
}

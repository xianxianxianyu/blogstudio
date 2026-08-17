import type { Context } from "./context";

export interface Node {
  id: string;
  claim: string | null;
  /**
   * **读者原样写下的主题**，不是归一化后的。判定相等用 `normalizeTopic`，显示用这一份——
   * 把「Agent Design」在图上画成「agent design」是拿内部实现去改读者的字。
   */
  topics: string[];
  status: Context["status"];
  /** 邻居数。`0` 就是孤儿——不是脏数据，是新主题的种子。 */
  degree: number;
}

export interface Edge {
  a: string;
  b: string;
  /** 共享的是哪几个主题。点开一条边要能说出它为什么连。 */
  topics: string[];
}

export interface TopicStat {
  topic: string;
  /** 挂着这个主题的 context 有几条。 */
  size: number;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
  /**
   * 每个主题挂了几条，按条数降序。
   *
   * **交出的是频次这个事实，不是 IDF 那个分数。** 稀有度排序（`log(n / size)`）是一条
   * 渲染层的政策——聚焦视图靠它给枢纽节点的几百个邻居排序，因为 94% 的边只共享一个
   * 主题，「共享几个」根本排不出名次。政策会变，事实不会，所以只交出事实。
   */
  topics: TopicStat[];
}

/**
 * 主题的归一化形式。**边按它判定相等**——主题是读者手打的，大小写和前后空格的差别
 * 不是语义差别，手抖一个空格就断一条边的话，图就变得不可信了。
 *
 * 只做这两样，不做同义词合并、不做词干还原：那些需要判断，而这里必须是纯规则。
 */
const normalizeTopic = (topic: string): string => topic.trim().toLowerCase();

/**
 * 从一批 context 算出知识图：**共享至少一个主题的两条 context 之间有一条边**
 * （`contextstudio/docs/adr/0002-edges-by-shared-topic.md`）。
 *
 * 纯函数，理由同 `clip.ts` 的 reducer——同一批 context 永远算出同一张图，测试才钉得住。
 * 布局（力导向、坐标）是渲染层的事，不在这里。
 */
export function buildGraph(contexts: Context[]): Graph {
  const nodes: Node[] = contexts.map((context) => ({
    id: context.id,
    claim: context.claim,
    topics: context.topics,
    status: context.status,
    degree: 0,
  }));

  // 主题 → 挂着它的 context。边只可能在同一个主题的成员之间产生，所以先分组，
  // 而不是拿所有 context 两两比主题——后者是 O(n²) 次数组求交，前者只在真有共享时才动。
  const byTopic = new Map<string, string[]>();
  for (const context of contexts) {
    // 去重放在每条 context 内部：同一个主题写了两遍（或写成 "eval" 与 "Eval"）
    // 会让它在同一组里出现两次，两两配对时就配到了自己身上。
    for (const topic of new Set(context.topics.map(normalizeTopic))) {
      if (topic === "") continue;
      const members = byTopic.get(topic);
      if (members) members.push(context.id);
      else byTopic.set(topic, [context.id]);
    }
  }

  // 一对 context 共享几个主题，仍然只是**一条**边——多出来的主题进 `topics`，不进边数。
  // 按 `a|b` 归并，否则「共享两个主题」会画出两条重叠的线，而它们说的是同一件事。
  const byPair = new Map<string, Edge>();
  for (const [topic, members] of byTopic) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [a, b] = members[i] < members[j] ? [members[i], members[j]] : [members[j], members[i]];
        const existing = byPair.get(a + "|" + b);
        if (existing) existing.topics.push(topic);
        else byPair.set(a + "|" + b, { a, b, topics: [topic] });
      }
    }
  }

  // 定序。分组是按 Map 的插入顺序走的，那等于跟着输入顺序走——同一批 context
  // 换个顺序就会算出排列不同的图，落盘后 diff 全是噪声。
  const edges = [...byPair.values()]
    .map((edge) => ({ ...edge, topics: [...edge.topics].sort() }))
    .sort((left, right) => left.a.localeCompare(right.a) || left.b.localeCompare(right.b));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    byId.get(edge.a)!.degree++;
    byId.get(edge.b)!.degree++;
  }

  // 分组时已经按归一化后的主题分好了，频次直接读它，不重扫一遍。
  const topics: TopicStat[] = [...byTopic.entries()]
    .map(([topic, members]) => ({ topic, size: members.length }))
    .sort((left, right) => right.size - left.size || left.topic.localeCompare(right.topic));

  return { nodes, edges, topics };
}

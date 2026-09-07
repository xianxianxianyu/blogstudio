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
  /** 归一化形式。**这是 key**——边、分组、去重都按它判定相等。 */
  topic: string;
  /**
   * 读者原样写下的那一份，取库里第一次出现的写法。**给人看的一律用它。**
   *
   * 少了它，「对齐到池里在用的写法」就是句空话：池子里只剩小写，`proposeTopics`
   * 只能提议小写，读者写的「Agent Design」会在第二次入库时被系统改成「agent design」——
   * 正是 `Node.topics` 那条注释拒绝的事。归一化是**相等规则**，不是**显示规则**。
   */
  display: string;
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
export const normalizeTopic = (topic: string): string => topic.trim().toLowerCase();

/**
 * `Graph.topics` 的按名索引。导出它，是因为下游（`intake` 要 display、`focus` 要 size）
 * 各自 `new Map(graph.topics.map(...))` 建一遍，同一个索引写两处，改一处就会静默走偏。
 */
export function topicIndex(graph: Graph): Map<string, TopicStat> {
  return new Map(graph.topics.map((stat) => [stat.topic, stat]));
}

/** 把归一化后的主题换回读者的写法。池里没有的（新主题）原样返回。 */
export function display(index: Map<string, TopicStat>, topic: string): string {
  return index.get(topic)?.display ?? topic;
}

/**
 * 一条边的稀有度：共享的每个主题的 IDF 之和。**排邻居和分簇用的是同一个数**，
 * 所以它住在这里而不是各写一份。
 *
 * 用 `log(1 + n/size)` 而不是教科书的 `log(n/size)`，是因为后者有个退化：一个**每条
 * context 都挂**的主题 IDF 恰好是 0。排序时无所谓，聚类时是致命的——全库只用一个主题
 * 的话所有边权都是 0，总权重也是 0，于是「谁都不像一簇」，整个库被报成一堆孤儿。
 * 加一之后最笼统的主题也还剩 `log 2`，相对差距几乎没变（实测 6.8 倍）。
 *
 * **交出的仍然是政策，不是事实**——`Graph.topics` 只给频次，这个函数是可以换掉的那层。
 */
export function rarity(topics: string[], index: Map<string, TopicStat>, total: number): number {
  return topics.reduce((sum, topic) => sum + Math.log(1 + total / (index.get(topic)?.size || 1)), 0);
}

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
  const byTopic = new Map<string, { display: string; members: string[] }>();
  for (const context of contexts) {
    // 去重放在每条 context 内部：同一个主题写了两遍（或写成 "eval" 与 "Eval"）
    // 会让它在同一组里出现两次，两两配对时就配到了自己身上。
    const seen = new Set<string>();
    for (const written of context.topics) {
      const topic = normalizeTopic(written);
      if (topic === "" || seen.has(topic)) continue;
      seen.add(topic);
      const group = byTopic.get(topic);
      // 先到先得。写法之争没有正确答案，但**必须稳定**——按「最后一次出现」的话，
      // 新导入一条就可能把全库这个主题的显示改掉一次。
      if (group) group.members.push(context.id);
      else byTopic.set(topic, { display: written.trim(), members: [context.id] });
    }
  }

  // 一对 context 共享几个主题，仍然只是**一条**边——多出来的主题进 `topics`，不进边数。
  // 按 `a|b` 归并，否则「共享两个主题」会画出两条重叠的线，而它们说的是同一件事。
  const byPair = new Map<string, Edge>();
  for (const [topic, { members }] of byTopic) {
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
    .map(([topic, group]) => ({ topic, display: group.display, size: group.members.length }))
    .sort((left, right) => right.size - left.size || left.topic.localeCompare(right.topic));

  return { nodes, edges, topics };
}

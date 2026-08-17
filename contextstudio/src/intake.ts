import type { Graph, TopicStat } from "./graph";

/**
 * 最多提议几个。**这个数就是 ADR-0003 的胜负手**：原型量过，把整个主题池摊给读者挑
 * （「带补全」）会治好漏边，却造出 6 条假边——池子摆在眼前，人会顺手点一个勉强沾边的。
 * 窄提议同时拿到了对齐效果和「不诱惑偷懒」。
 */
const MAX_SUGGESTIONS = 2;

/**
 * 判为「笼统」的线：一个主题挂到了全库这个比例以上，就几乎不携带信息了。
 *
 * **这个数还没有用真实数据标定过。** issue 05 量到 `#agent-design` 在 320 条的库里挂了
 * 123 条（38%），而冷门主题的 IDF 是它的两倍——0.2 是照着那个形状挑的，不是算出来的。
 * 跑过一批真实导入之后回来改，所以它是参数不是常量。
 *
 * 用占比而不是 IDF 的绝对值，是因为占比能直接说给读者听：
 * 「这个主题已经挂了 123 条，全库的 38%」。
 */
const DEFAULT_VAGUE_ABOVE = 0.2;

export interface ProposeOptions {
  /** 超过这个占比就提醒。默认 0.2，见 `DEFAULT_VAGUE_ABOVE` 的标定说明。 */
  vagueAbove?: number;
}

export interface Proposal {
  /** 最终建议的主题，已经对齐到池里在用的写法。读者确认或改写。 */
  topics: string[];
  /**
   * 候选里那些什么都挂的主题。**只提醒，不拦**——读者可能真的就是要用它。
   *
   * 这是 ADR-0003 承认「假边没有药」之后唯一的线索：假边来自笼统主题，
   * 而笼统是可以从频次上看出来的。
   */
  vague: TopicStat[];
}

/**
 * 入库时给读者提议主题（`docs/adr/0003-topics-proposed-by-ai-against-the-pool.md`）。
 *
 * `aiRead` 是模型读完这条材料给出的候选。**模型那一步要把主题池放进 prompt**——
 * 「评测」和 `eval` 是不是一回事，只有模型判得了。这个函数不做语义判断，
 * 它做的是模型之后那一道确定性的检查。
 *
 * 原型（`public/knowledge-topics-prototype.html`）里那张 `SYNONYM_GROUPS` 表是**模拟器的
 * 拐杖**，不要搬进来：真实的同义词判断没有表可查。
 */
export function proposeTopics(
  graph: Graph,
  aiRead: string[],
  options: ProposeOptions = {},
): Proposal {
  const spelling = new Map(graph.topics.map((stat: TopicStat) => [stat.topic, stat.topic]));

  const aligned = new Map<string, string>();
  for (const raw of aiRead) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "") continue;
    // 先按归一化去重，再取写法：模型给 "rag" 和 "RAG" 是同一个主题，不该占两个名额。
    if (!aligned.has(normalized)) aligned.set(normalized, spelling.get(normalized) ?? raw.trim());
  }

  // 保留模型给的先后。它按相关度排的，而我们没有能力重排——按稀有度重排会
  // 系统性地把新主题顶到前面，那恰好是漂移的入口，与「对齐」的目标相反。
  const topics = [...aligned.values()].slice(0, MAX_SUGGESTIONS);

  // 只看已经在池里的：一个刚出现的新主题当然「不笼统」，但那是因为它还没被用过，
  // 不是因为它精确。拿它触发提醒会让每条新主题都被质疑一遍。
  const ceiling = (options.vagueAbove ?? DEFAULT_VAGUE_ABOVE) * graph.nodes.length;
  const size = new Map(graph.topics.map((stat) => [stat.topic, stat.size]));
  const vague = topics
    .map((topic) => ({ topic, size: size.get(topic.toLowerCase()) ?? 0 }))
    .filter((stat) => stat.size > ceiling);

  return { topics, vague };
}

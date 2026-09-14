/**
 * 联网搜索——写作搭子的第二种材料。
 *
 * 第一种是知识库里召回的 context（`recall.ts`）；这一种是**现搜的网页**。两种走同一条路
 * 进 prompt：当材料摆给模型，答里引用了哪条就摆出哪条。区别在出处的形态：context 用
 * `[ctx:id]`（发布时落成脚注），网页**直接写成 markdown 链接**——链接跟着段落一起被
 * 粘进正文，不需要任何库来解析它，也就不会在哪个目录里堆出一摞「搜过的东西」。
 *
 * 端口。Tavily 只是第一个适配器；换家只换 `create*Search`，`writer-chat.ts` 不动。
 */
export interface WebHit {
  title: string;
  url: string;
  /** 搜索引擎给的正文摘录，几百字。 */
  content: string;
}

export interface WebSearch {
  search(query: string, signal?: AbortSignal): Promise<WebHit[]>;
}

/** 一次最多要几条。五条够一个回答引用，再多只是把 prompt 撑长。 */
export const MAX_HITS = 5;

/**
 * Tavily（https://docs.tavily.com）。POST `/search`，Bearer 鉴权，返回 `results[]`。
 *
 * `fetch` 可注入：测试里喂假的；服务端就是全局那个。**key 只活在服务端**——浏览器那侧
 * 走 `/__search` 转一手（`http-search.ts`），同模型 key 的待遇。
 */
export function createTavilySearch(deps: { apiKey: string; fetch?: typeof fetch; endpoint?: string }): WebSearch {
  const call = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? "https://api.tavily.com/search";
  return {
    async search(query, signal) {
      const response = await call(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({ query, max_results: MAX_HITS, search_depth: "basic", include_answer: false }),
        signal,
      });
      if (!response.ok) {
        // 把它自己的话带上来：401 是 key 错了、432 是额度用完，一句「搜索失败」分不出来。
        throw new Error(`搜索失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
      const body = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      return (body.results ?? [])
        .filter((one) => typeof one.url === "string" && one.url !== "")
        .slice(0, MAX_HITS)
        .map((one) => ({ title: one.title?.trim() || one.url!, url: one.url!, content: (one.content ?? "").trim() }));
    },
  };
}

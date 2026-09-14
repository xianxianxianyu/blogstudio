import { apiFetch } from "./api-base";
import type { WebHit, WebSearch } from "../../blogstudio/src/search";

/**
 * 浏览器侧的联网搜索，转交本机 API（`/__search`）。key 在那边，页面里没有。
 *
 * 503 = 没配。**照样抛**：`writer-chat.ts` 会接住、把这句摆在回答旁边，
 * 人看到的是「没配联网搜索」而不是一个没有材料的回答。
 */
export function createHttpSearch(route: string): WebSearch {
  return {
    async search(query, signal): Promise<WebHit[]> {
      const response = await apiFetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal,
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as WebHit[];
    },
  };
}

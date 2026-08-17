import { normalizeTags, type Tag } from "../src/tag/tag";
import type { TagStore } from "../src/tag/tag-store";

/**
 * 浏览器侧的标签表读写：和书架、摘录、配置一样转交给本机 API（ADR-0014 共用那一份）。
 *
 * 读失败也归一成默认的五个，不抛。首次打开、断开重连、文件被改烂——这些都不该让阅读页
 * 打不开，最差的结果只是标签名回到默认。
 */
export function createHttpTagStore(route: string): TagStore {
  return {
    async load(): Promise<Tag[]> {
      const stored = await fetch(route)
        .then((response) => (response.ok ? (response.json() as Promise<Tag[]>) : []))
        .catch(() => [] as Tag[]);
      return normalizeTags(stored);
    },

    async save(tags: Tag[]): Promise<void> {
      const response = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalizeTags(tags)),
      });
      if (!response.ok) throw new Error(`存标签失败：HTTP ${response.status}`);
    },
  };
}

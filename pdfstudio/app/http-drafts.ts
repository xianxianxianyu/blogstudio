import { apiFetch } from "./api-base";
import type { Draft, DraftStore, DraftSummary } from "../../blogstudio/src/draft";

/**
 * 浏览器侧的稿子读写，转交本机 API（ADR-0014 共用那一份实现）。
 *
 * 与摘录、目录、context 走的是同一条路：这层 HTTP 边界也是将来 IPC 的预演。
 *
 * **存失败必须抛。** 别的几样（目录、索引）取不到都可以退回「没有」，稿子不行——
 * 静默失败等于让人以为自己写的东西存住了。
 */
export function createHttpDraftStore(route: string): DraftStore {
  const one = (id: string) => `${route}/${encodeURIComponent(id)}`;

  return {
    async list(): Promise<DraftSummary[]> {
      const response = await apiFetch(route);
      if (!response.ok) throw new Error(`读稿子架失败：HTTP ${response.status}`);
      return (await response.json()) as DraftSummary[];
    },

    async load(id: string): Promise<Draft | null> {
      const response = await apiFetch(one(id));
      if (!response.ok) throw new Error(`读这篇稿子失败：HTTP ${response.status}`);
      return (await response.json()) as Draft | null;
    },

    async save(draft: Draft): Promise<void> {
      const response = await apiFetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error(`存稿子失败：HTTP ${response.status} ${await response.text()}`);
    },

    async remove(id: string): Promise<void> {
      const response = await apiFetch(one(id), { method: "DELETE" });
      if (!response.ok) throw new Error(`删稿子失败：HTTP ${response.status}`);
    },
  };
}

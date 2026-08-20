import { apiFetch } from "./api-base";
import type { Draft, DraftSummary } from "../../blogstudio/src/draft";
import type { DraftStore } from "../../blogstudio/src/draft-store";
import type { Revision, RevisionInfo, RevisionStore } from "../../blogstudio/src/revisions";

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

/**
 * 历史版本，同一条路。
 *
 * 与稿子分成两个适配器而不是一个大的：它们在领域上就是两个 store（`DraftStore` 只管
 * 「现在这一份」，`RevisionStore` 只管「留过的那些」），合成一个的话，将来 agent 那条线
 * 要往版本里加东西时，会连带动到日常保存那条路。
 */
export function createHttpRevisionStore(route: string): RevisionStore {
  const of = (draftId: string) => `${route}/${encodeURIComponent(draftId)}/revisions`;

  return {
    async list(draftId: string): Promise<RevisionInfo[]> {
      const response = await apiFetch(of(draftId));
      if (!response.ok) throw new Error(`读版本列表失败：HTTP ${response.status}`);
      return (await response.json()) as RevisionInfo[];
    },

    async read(draftId: string, n: number): Promise<Revision | null> {
      const response = await apiFetch(`${of(draftId)}/${n}`);
      if (!response.ok) throw new Error(`读第 ${n} 版失败：HTTP ${response.status}`);
      return (await response.json()) as Revision | null;
    },

    async append(draftId, revision): Promise<Revision> {
      const response = await apiFetch(of(draftId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(revision),
      });
      if (!response.ok) throw new Error(`留这一版失败：HTTP ${response.status} ${await response.text()}`);
      return (await response.json()) as Revision;
    },
  };
}

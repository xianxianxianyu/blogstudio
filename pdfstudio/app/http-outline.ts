import type { Section } from "../src/clip/outline";
import type { OutlineStore } from "../src/outline/outline-store";

/**
 * 浏览器侧的「生成的目录」读写，转交本机 API（ADR-0014 共用那一份）。
 *
 * 读失败一律当成「没生成过」（`null`），不抛：目录是锦上添花，它取不到不该让书打不开
 * ——摘录栏会自动退回按页排。
 */
export function createHttpOutlineStore(route: string): OutlineStore {
  const url = (docId: string) => `${route}/${encodeURIComponent(docId)}`;

  return {
    async load(docId: string): Promise<Section[] | null> {
      return fetch(url(docId))
        .then((response) => (response.ok ? (response.json() as Promise<Section[] | null>) : null))
        .catch(() => null);
    },

    async save(docId: string, sections: Section[]): Promise<void> {
      const response = await fetch(url(docId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sections),
      });
      if (!response.ok) throw new Error(`存目录失败：HTTP ${response.status}`);
    },

    async remove(docId: string): Promise<void> {
      await fetch(url(docId), { method: "DELETE" });
    },
  };
}

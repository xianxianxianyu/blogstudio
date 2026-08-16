import type { Clip } from "../src/clip/clip";
import type { ClipStore } from "../src/clip/clip-store";
import { deserialize, serializeClip } from "../src/clip/clip-wire";

/**
 * 浏览器侧的 `ClipStore`：把落盘转交给 dev server。
 *
 * `clip-store.ts` 导入 `node:fs/promises`，在浏览器里直接白屏——和当初 `config.ts`
 * 那次是同一类错误。好在 `ClipStore` 本来就是端口，`capture-clip.ts` 对它只有
 * `import type`（编译后擦除），所以换一个实现就够了，编排代码一行不用动。
 *
 * 这也正是 ADR-0006 打包应用里的那条边界：渲染进程不碰文件系统，写盘在主进程。
 * 这里的 HTTP 只是 IPC 在开发页面里的替身。
 */
export function createHttpClipStore(route: string): ClipStore {
  async function expectOk(response: Response): Promise<Response> {
    // 静默失败在这里格外坏：编排层拿到 resolve 就认为已落盘，内存说 ready、
    // 磁盘上什么都没有——ADR-0011 说文件才是唯一真相。
    if (!response.ok) throw new Error(`摘录落盘失败：HTTP ${response.status} ${await response.text()}`);
    return response;
  }

  return {
    async save(docId: string, clip: Clip): Promise<void> {
      await expectOk(
        await fetch(`${route}/${encodeURIComponent(docId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: serializeClip(clip),
        }),
      );
    },

    async listByDoc(docId: string): Promise<Clip[]> {
      const response = await expectOk(await fetch(`${route}/${encodeURIComponent(docId)}`));
      return deserialize<Clip[]>(await response.text());
    },

    async delete(docId: string, clipId: string): Promise<void> {
      await expectOk(
        await fetch(`${route}/${encodeURIComponent(docId)}/${encodeURIComponent(clipId)}`, {
          method: "DELETE",
        }),
      );
    },
  };
}

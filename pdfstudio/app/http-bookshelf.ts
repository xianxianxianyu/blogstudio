import { apiFetch } from "./api-base";
import type { Bookshelf, Doc, ImportRequest } from "../src/bookshelf/bookshelf";

/**
 * 浏览器侧的书架：和 `ClipStore` 一样，真正的文件操作转交给 dev server
 * （打包应用里这条边界是 IPC，ADR-0006）。
 *
 * 上传走裸字节 + 一个自定义头带文件名，不用 multipart：这里只有一个文件、没有别的
 * 表单字段，multipart 是在为不存在的复杂度付编解码的代价。
 */
export function createHttpBookshelf(route: string): Bookshelf {
  async function expectOk(response: Response): Promise<Response> {
    if (!response.ok) throw new Error(`书架操作失败：HTTP ${response.status} ${await response.text()}`);
    return response;
  }

  return {
    async import({ filename, bytes }: ImportRequest): Promise<Doc> {
      const response = await expectOk(
        await apiFetch(route, {
          method: "POST",
          // 文件名可能有中文，头里不能直接放非 ASCII。
          headers: { "x-filename": encodeURIComponent(filename) },
          body: bytes as BodyInit,
        }),
      );
      return (await response.json()) as Doc;
    },

    async list(): Promise<Doc[]> {
      return (await (await expectOk(await apiFetch(route))).json()) as Doc[];
    },

    async read(docId: string): Promise<Uint8Array> {
      const response = await expectOk(await apiFetch(`${route}/${docId}/pdf`));
      return new Uint8Array(await response.arrayBuffer());
    },

    async rename(docId: string, title: string): Promise<void> {
      await expectOk(
        await apiFetch(`${route}/${docId}/title`, { method: "POST", body: title }),
      );
    },

    async remove(docId: string): Promise<void> {
      await expectOk(await apiFetch(`${route}/${docId}`, { method: "DELETE" }));
    },
  };
}

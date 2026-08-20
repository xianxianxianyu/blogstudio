import { apiFetch } from "./api-base";
import type { ContextStudio, StudioView } from "../../contextstudio/src/api";
import type { Focus } from "../../contextstudio/src/focus";
import type { IngestReport } from "../../contextstudio/src/context-store";
import type { Context } from "../../contextstudio/src/context";

/**
 * 浏览器侧的 Context Studio：与 `http-bookshelf.ts` 同一个形状，真正的读写在本机 API 那边。
 *
 * 它实现的是 `ContextStudio` 那个接口本身，不是另发明一套——**接口就是测试面**，
 * 换一个传输不该让调用方改一行。
 */
export function createHttpContextStudio(route: string): ContextStudio & { sweep(): Promise<number> } {
  async function expectOk(response: Response): Promise<Response> {
    if (!response.ok) {
      throw new Error(`知识库操作失败：HTTP ${response.status} ${await response.text()}`);
    }
    return response;
  }

  return {
    async view(): Promise<StudioView> {
      return (await (await expectOk(await apiFetch(route))).json()) as StudioView;
    },

    async focus(id: string): Promise<Focus | null> {
      const response = await expectOk(await apiFetch(`${route}/focus/${encodeURIComponent(id)}`));
      return (await response.json()) as Focus | null;
    },

    async update(id, patch): Promise<void> {
      await expectOk(
        await apiFetch(`${route}/topics/${encodeURIComponent(id)}`, {
          method: "POST",
          body: JSON.stringify(patch),
        }),
      );
    },

    async ingest(): Promise<IngestReport> {
      // 浏览器这一侧没有 context 的来源——它们来自 PDF Studio 的导出层，走服务端。
      throw new Error("浏览器侧不入库：context 由导出层交给本机 API");
    },

    /** 临时桥，见 `local-api.ts` 里 `sweep` 那段注释。导出层落地后连同它一起删。 */
    async sweep(): Promise<number> {
      const response = await expectOk(await apiFetch(`${route}/sweep`, { method: "POST" }));
      return ((await response.json()) as { added: number }).added;
    },
  };
}

export type { Context, StudioView };

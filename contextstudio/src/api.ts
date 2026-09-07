import type { Context } from "./context";
import { createContextStore, type ContextStore, type IngestReport, type ReaderPatch } from "./context-store";
import { buildGraph, type Graph } from "./graph";
import { cluster, type Clustering } from "./cluster";
import { focusOn, type Focus } from "./focus";

/**
 * 图页面要的全部东西，一次给全。
 *
 * **不做成三个端点**（`/contexts` `/graph` `/clusters`）：图和簇都是从同一批 context
 * 纯函数算出来的，分三次取意味着三次全量读，还可能读到三个不同时刻的库——页面上
 * 就会出现「这条 context 在图里有、在簇里没有」。一次算完，三份必然自洽。
 */
export interface StudioView {
  contexts: Context[];
  graph: Graph;
  clustering: Clustering;
}

/**
 * Context Studio 对外的**唯一入口**。
 *
 * 在这之前这个 context 只有四个互不相识的模块和一堆测试——`ingest → buildGraph →
 * cluster → focusOn` 怎么串，代码里没有一行写着，于是它跑不起来。这个文件就是那根线。
 *
 * 传输无关：HTTP 也好、Electron IPC 也好、直接在进程里调也好，都在这一层之外。
 */
export interface ContextStudio {
  view(): Promise<StudioView>;
  /** 聚焦一条。`null` 表示这条不在库里了——重导之后界面上可能还留着上次选中的 id。 */
  focus(id: string, limit?: number): Promise<Focus | null>;
  /** 读者改主题 / 立场 / 状态。 */
  update(id: string, patch: ReaderPatch): Promise<void>;
  /** 收下一批。定域在 docId 上，见 `ContextStore.ingest`。 */
  ingest(docId: string, incoming: Context[]): Promise<IngestReport>;
}

export function createContextStudio(rootOrStore: string | ContextStore): ContextStudio {
  const store = typeof rootOrStore === "string" ? createContextStore(rootOrStore) : rootOrStore;

  async function view(): Promise<StudioView> {
    const contexts = await store.all();
    const graph = buildGraph(contexts);
    return { contexts, graph, clustering: cluster(graph) };
  }

  return {
    view,
    async focus(id, limit) {
      // 重算一次图而不是缓存：实测 2000 条全量读 44ms、buildGraph 86ms，而聚焦是
      // 点一下才发生的动作。先把「文件是唯一真相」守住，慢了再加缓存（ADR-0004）。
      return focusOn(buildGraph(await store.all()), id, limit);
    },
    update: (id, patch) => store.update(id, patch),
    ingest: (docId, incoming) => store.ingest(docId, incoming),
  };
}

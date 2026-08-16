import type { Embedder } from "../../src/model/embedder";
import type { Progress } from "../../src/app/progress";

/**
 * 主线程这侧的 `Embedder`：把编码请求转给 Worker。
 *
 * 换实现而不动领域代码，正是端口的意义（同 `ClipStore` 换成 HTTP 那次）。
 */
export function createWorkerEmbedder(progress: Progress): Embedder {
  const worker = new Worker(new URL("./embedder.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let nextId = 0;

  worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
    const message = event.data;
    if (message.kind === "progress") {
      progress.set(message.text as string | null);
      return;
    }

    const waiting = pending.get(message.id as number);
    if (!waiting) return;
    pending.delete(message.id as number);
    if (message.kind === "error") waiting.reject(new Error(message.message as string));
    else waiting.resolve((message.kind === "query" ? message.vector : message.vectors) as never);
  });

  // Worker 整个挂掉时（脚本加载失败、内存爆掉）不会有 message 回来。不接这个的话
  // 每个 promise 都永远挂着——界面停在「正在检索」，而且永远不会出错。
  worker.addEventListener("error", (event) => {
    const message = event.message || "本地向量模型的 Worker 挂了";
    progress.set(null);
    for (const [, waiting] of pending) waiting.reject(new Error(message));
    pending.clear();
  });

  const send = <T>(request: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage({ ...request, id });
    });

  return {
    embedQuery: (text: string) => send<Float32Array>({ kind: "query", text }),
    embedDocuments: (texts: string[]) => send<Float32Array[]>({ kind: "documents", texts }),
  };
}

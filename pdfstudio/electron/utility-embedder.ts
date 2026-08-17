import { fork } from "node:child_process";
import path from "node:path";
import type { Embedder } from "../src/model/embedder";

/**
 * 主进程这侧的 `Embedder`：把编码转给一个**纯 Node 子进程**。
 *
 * **不是 utilityProcess，也不是主进程。** onnxruntime-node 的原生模块在 Electron 的
 * 进程里跑不起来——主进程上是 EXC_BREAKPOINT（崩在 CrBrowserMain），utilityProcess
 * 里是同一个信号（退出码 5）。两处都试过。
 *
 * `ELECTRON_RUN_AS_NODE=1` 让 Electron 的二进制当普通 Node 跑，没有 Chromium 的 V8
 * 嵌入环境，原生扩展就正常了。打包应用里也不需要另外带一个 node——用的就是它自己。
 *
 * `Embedder` 是端口，所以换的只是实现。这已经是同一个端口的第四个实现了
 * （Node 进程内、浏览器 WASM Worker、浏览器 HTTP、这个）。
 */
export function createUtilityEmbedder(modelsRoot: string): Embedder {
  const child = fork(path.join(import.meta.dirname, "embedder-host.cjs"), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PDFSTUDIO_MODELS_ROOT: modelsRoot },
    // 子进程的报错默认一个字都看不到，表现是「请求永远没有回音」——最难查的一种。
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let nextId = 0;

  child.on("message", (message: { id: number; dims?: number; data?: string; error?: string }) => {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);

    if (message.error !== undefined || message.data === undefined) {
      waiting.reject(new Error(message.error ?? "向量进程没有返回数据"));
      return;
    }
    // IPC 走 JSON，装不下 Float32Array，所以整块 base64——逐条写十进制是几 MB 文本。
    const bytes = Buffer.from(message.data, "base64");
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const dims = message.dims ?? all.length;
    const vectors: Float32Array[] = [];
    for (let start = 0; start < all.length; start += dims) vectors.push(all.slice(start, start + dims));
    waiting.resolve(vectors as never);
  });

  // 子进程整个挂掉时不会有 message 回来。不接的话每个 promise 都永远挂着——界面停在
  // 「正在建索引」，而且永远不会出错。
  child.on("exit", (code) => {
    for (const [, waiting] of pending) waiting.reject(new Error(`向量进程退出（code ${code}）`));
    pending.clear();
  });

  const send = (kind: "query" | "documents", texts: string[]): Promise<Float32Array[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      child.send({ kind, id, texts });
    });

  return {
    async embedQuery(text: string): Promise<Float32Array> {
      return (await send("query", [text]))[0];
    },
    embedDocuments: (texts: string[]) => send("documents", texts),
  };
}

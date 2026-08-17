/**
 * 向量计算跑在一个**纯 Node 子进程**里（`ELECTRON_RUN_AS_NODE`）。
 *
 * **不是性能优化，是崩溃修复。** onnxruntime-node 的原生模块在 Electron 的进程里跑不
 * 起来：主进程上 EXC_BREAKPOINT（崩在 CrBrowserMain），utilityProcess 里同一个信号
 * （退出码 5）。两处都试过，都是整个应用当场消失、连错误都没有。
 *
 * 顺带也对：几百 MB 权重的加载与前向不该占着 UI 线程——这和当初把 WASM 挪进 Web
 * Worker 是同一个教训。
 */
process.stderr.write(`[embedder] 起来了 node=${process.versions.node} electron=${process.versions.electron ?? "-"}\n`);

import { env } from "@huggingface/transformers";
import { createTransformersEmbedder } from "../src/model/transformers-embedder";

const modelsRoot = process.env.PDFSTUDIO_MODELS_ROOT ?? "";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = `${modelsRoot}/`;
// 关掉文件系统缓存：开着的话它会先去 node_modules 里那个 .cache 找，而打包后那是
// asar 内部——文件不能内存映射，报「system error number 20」，跟路径毫无关系。
env.useFSCache = false;

const embedder = createTransformersEmbedder();

process.on("message", (message: { kind: "query" | "documents"; id: number; texts: string[] }) => {
  void (async () => {
    try {
      const vectors =
        message.kind === "query"
          ? [await embedder.embedQuery(message.texts[0])]
          : await embedder.embedDocuments(message.texts);

      const dims = vectors[0]?.length ?? 0;
      const flat = new Float32Array(dims * vectors.length);
      vectors.forEach((vector, index) => flat.set(vector, index * dims));
      process.send?.({ id: message.id, dims, data: Buffer.from(flat.buffer).toString("base64") });
    } catch (error) {
      // 原因要带回去。子进程里未捕获的异常在父进程只会表现为「没有回音」。
      process.send?.({ id: message.id, error: (error as Error).message });
    }
  })();
});

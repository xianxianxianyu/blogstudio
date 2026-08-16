/// <reference lib="webworker" />
import { env } from "@huggingface/transformers";
import { createTransformersEmbedder } from "../../src/model/transformers-embedder";

/**
 * 权重从我们自己的服务取，不去 HuggingFace。
 *
 * 浏览器的 Cache API 会被回收，几百 MB 的条目尤其容易，而且与 Node 侧 eval 的缓存
 * 是两套——读者的感受就是「下载了很多次」。改成本地路径之后，下一次、之后永远从磁盘
 * 读，离线也能用（ADR-0006 local-first）。
 *
 * `allowRemoteModels = false` 是要害：留着它的话，本地缺文件时会**静默回退到联网下载**
 * ——那正是我们要根除的行为，而且它不会报任何错，只会又慢一次。宁可当场失败，
 * 让设置页告诉读者「还没下载」。
 */
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = "/__models/";

/**
 * 本地向量模型跑在 Worker 里。
 *
 * **不是性能优化，是可用性修复。** ONNX 推理默认就在调用它的那个线程上跑，而建索引
 * 要给整篇论文几十个块逐个前向——放在主线程上，整个页面会锁死几分钟：进度条不动、
 * 按钮点不了、连切到设置页都做不到。实测就是这个症状。
 *
 * `Embedder` 是端口，所以这里换的只是实现：领域代码一行不用动。
 */
const embedder = createTransformersEmbedder({
  onProgress: (event) => {
    if (event.status === "progress" && event.progress !== undefined) {
      post({ kind: "progress", text: `正在下载本地向量模型 ${Math.round(event.progress)}%（只需一次）` });
    } else if (event.status === "ready") {
      post({ kind: "progress", text: "模型就绪，正在给这篇文档建索引…" });
    }
  },
});

type Request =
  | { id: number; kind: "query"; text: string }
  | { id: number; kind: "documents"; texts: string[] };

type Response =
  | { kind: "progress"; text: string | null }
  | { id: number; kind: "query"; vector: Float32Array }
  | { id: number; kind: "documents"; vectors: Float32Array[] }
  | { id: number; kind: "error"; message: string };

const post = (message: Response) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.kind === "query") {
        post({ id: request.id, kind: "query", vector: await embedder.embedQuery(request.text) });
      } else {
        // 建完索引把进度清掉：这一步做完之后 chat 才真正开始生成。
        const vectors = await embedder.embedDocuments(request.texts);
        post({ kind: "progress", text: null });
        post({ id: request.id, kind: "documents", vectors });
      }
    } catch (error) {
      // 原因要带回主线程。Worker 里未捕获的异常在页面上只会变成一句 "error"，
      // 排查时和什么都没有一样。
      post({ id: request.id, kind: "error", message: (error as Error).message });
    }
  })();
});

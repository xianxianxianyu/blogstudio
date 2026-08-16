import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { errorChain } from "../app/error-chain";
import path from "node:path";
import type { ModelSpec } from "./model-files";

/** 下载状态，供设置页显示。`bytes` 是已经落盘的字节数。 */
export interface ModelStatus {
  present: boolean;
  downloading: boolean;
  bytes: number;
  error: string | null;
}

const HF = "https://huggingface.co";

/**
 * 把模型权重下到本地目录，之后由应用自己服务。
 *
 * **先写临时目录再 rename**，同 ClipStore 与 Bookshelf：下到一半断网的话，留下的
 * 半个模型目录会让 transformers.js 报一个和网络毫无关系的解析错误，而读者只会看到
 * 「模型坏了」。要么完整，要么当作没下过。
 */
export function createModelDownloader(root: string) {
  let status: ModelStatus = { present: false, downloading: false, bytes: 0, error: null };

  const dir = (spec: ModelSpec) => path.join(root, spec.id);

  return {
    async check(spec: ModelSpec): Promise<ModelStatus> {
      if (status.downloading) return status;
      const size = (file: string) =>
        stat(path.join(dir(spec), file))
          .then((info) => info.size)
          .catch(() => -1);
      const sizes = await Promise.all(spec.files.map(size));
      // 可选文件也要计入体积：权重都在 `.onnx_data` 里，不算它的话界面会说
      // 「已就绪 21 MB」，而磁盘上躺着 300 MB。
      const extra = (await Promise.all(spec.optional.map(size))).filter((value) => value > 0);
      // 少一个**必需**文件就算没有：残缺的目录比空目录更糟，它会被当成「已就绪」。
      const present = sizes.every((value) => value > 0);
      status = {
        present,
        downloading: false,
        bytes: present ? [...sizes, ...extra].reduce((a, b) => a + b, 0) : 0,
        // **不清掉上一次的失败原因。** 原先这里写死 null，于是下载失败后的第一次轮询
        // 就把错误抹掉了——界面上只剩「没下载」，读者永远看不到为什么。成功了才清。
        error: present ? null : status.error,
      };
      return status;
    },

    /** 开始下载。立即返回，进度靠 `check` 轮询——几百 MB 不该把一个请求挂住。 */
    start(spec: ModelSpec): ModelStatus {
      if (status.downloading) return status;
      status = { present: false, downloading: true, bytes: 0, error: null };

      void (async () => {
        const staging = `${dir(spec)}.tmp`;
        try {
          await rm(staging, { recursive: true, force: true });
          for (const file of [...spec.files, ...spec.optional]) {
            const required = spec.files.includes(file);
            const response = await fetch(`${HF}/${spec.id}/resolve/main/${file}`);
            if (response.status === 404 && !required) continue;
            if (!response.ok || !response.body) throw new Error(`${file}：HTTP ${response.status}`);
            const target = path.join(staging, file);
            await mkdir(path.dirname(target), { recursive: true });

            // 边下边写，不用 arrayBuffer()：那会把几百 MB 整个读进内存，而且进度只能
            // 按文件跳（0 → 300MB），读者看到的是一个几分钟不动的数字。
            let written = status.bytes;
            await pipeline(
              Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
              async function* (chunks: AsyncIterable<Buffer>) {
                for await (const chunk of chunks) {
                  written += chunk.byteLength;
                  status = { ...status, bytes: written };
                  yield chunk;
                }
              },
              createWriteStream(target),
            );
          }
          await rm(dir(spec), { recursive: true, force: true });
          await mkdir(path.dirname(dir(spec)), { recursive: true });
          await rename(staging, dir(spec));
          status = { present: true, downloading: false, bytes: status.bytes, error: null };
        } catch (error) {
          // 半个模型目录留着比没有更糟——它会被当成「已就绪」，然后报一个和网络
          // 毫无关系的解析错误。
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
          // **整条 cause 链**：undici 只给一句 "fetch failed"，真正的原因（连接被重置、
          // 证书、DNS）全在 cause 里。这个教训在识别那条链路上已经付过一次学费。
          status = { present: false, downloading: false, bytes: 0, error: errorChain(error) || "下载失败" };
        }
      })();

      return status;
    },
  };
}

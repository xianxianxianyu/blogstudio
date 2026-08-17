import { spawn } from "node:child_process";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { errorChain } from "../app/error-chain";
import type { EngineAsset, EngineDeps, RunningProcess } from "./local-engine";

/**
 * 用 llama.cpp 跑本地模型：下权重、拉起 `llama-server`、健康检查。
 *
 * **两个引擎共用同一个二进制**：识别（PaddleOCR-VL，ADR-0015）与向量
 * （embeddinggemma）。向量原本走 onnxruntime-node，但它在 Electron 的进程里根本跑
 * 不起来——主进程上 EXC_BREAKPOINT，utilityProcess 里同一个信号。换到这里等于**少一个
 * 推理运行时**，而不是多一个。
 */

const LLAMA_RELEASE = "b10453";

/** 一个引擎要什么权重、怎么起。 */
export interface LlamaSpec {
  /** 权重放在 `<root>/<id>/` 下。 */
  id: string;
  weights: EngineAsset[];
  /** `--model` 之外的参数。 */
  args: string[];
}

export const RECOGNITION_SPEC: LlamaSpec = {
  id: "recognition",
  weights: [
    {
      url: "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF.gguf",
      target: "model.gguf",
      bytes: 892,
    },
    {
      // 视觉投影。**少了它引擎起得来但看不见图**——报的还是一个跟「缺文件」毫无关系
      // 的错，所以它和主权重同等必需。
      url: "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
      target: "mmproj.gguf",
      bytes: 840,
    },
  ],
  args: ["--mmproj", "{dir}/mmproj.gguf"],
};

export const EMBEDDING_SPEC: LlamaSpec = {
  id: "embedding",
  weights: [
    {
      // ggml-org 是 llama.cpp 官方组织，Q8_0 与此前 ONNX 的 q8 同一档。
      url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf",
      target: "model.gguf",
      bytes: 318,
    },
  ],
  args: [
    "--embedding",
    "--pooling",
    "mean",
    // **批量必须调大。** 默认物理批 512，而 600 字符的块在中英混排下能到 885 token，
    // 直接 HTTP 500「input is too large」。onnxruntime 内部按模型上限截断，不报这个。
    "--ctx-size",
    "2048",
    "--batch-size",
    "2048",
    "--ubatch-size",
    "2048",
  ],
};

/**
 * llama.cpp 的二进制，两个引擎共用一份。
 *
 * 先只做 macOS arm64。**没验证过的平台不算支持**（同 ADR-0014 的边界）——与其塞一堆
 * 猜出来的 URL，不如在这里明确报「这个平台还没做」。
 */
function binaryAsset(): EngineAsset {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`本地引擎目前只做了 macOS arm64，当前是 ${process.platform}/${process.arch}。`);
  }
  return {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-macos-arm64.tar.gz`,
    target: "llama.tar.gz",
    bytes: 10,
  };
}

export function llamaEngineDeps(
  root: string,
  spec: LlamaSpec,
  onProgress?: (text: string | null) => void,
): EngineDeps {
  const shared = (name: string) => path.join(root, name);
  const own = (name: string) => path.join(root, spec.id, name);

  return {
    // 二进制排在前面：它 10 MB，先下完就能在权重下载期间知道解包这一步是好的。
    assets: [binaryAsset(), ...spec.weights],
    onProgress,

    async has(target: string): Promise<boolean> {
      // 二进制下完就解包删掉压缩包，所以查的是解出来的可执行文件。
      const probe = target === "llama.tar.gz" ? shared("bin/llama-server") : own(target);
      return stat(probe)
        .then((info) => info.size > 0)
        .catch(() => false);
    },

    async fetch(asset: EngineAsset): Promise<void> {
      const target = asset.target === "llama.tar.gz" ? shared(asset.target) : own(asset.target);
      const response = await fetch(asset.url);
      if (!response.ok || !response.body) throw new Error(`${asset.target}：HTTP ${response.status}`);

      // 先写 .part 再改名：下到一半断网留下的半个文件，下次会被 has() 当成「已就绪」，
      // 然后 llama-server 报一个跟「文件不全」毫无关系的错。
      const staging = `${target}.part`;
      await mkdir(path.dirname(staging), { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        createWriteStream(staging),
      );
      await rename(staging, target);

      if (asset.target === "llama.tar.gz") await unpackLlama(root);
    },

    async spawn(): Promise<RunningProcess> {
      const port = await freePort();
      const args = [
        "--model",
        own("model.gguf"),
        ...spec.args.map((arg) => arg.replace("{dir}", path.join(root, spec.id))),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        // 只服务本机的这一个应用，不需要并发。
        "--parallel",
        "1",
      ];
      const child = spawn(shared("bin/llama-server"), args, { stdio: ["ignore", "pipe", "pipe"] });

      try {
        await waitHealthy(`http://127.0.0.1:${port}/health`, child);
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }

      return {
        baseURL: `http://127.0.0.1:${port}/v1`,
        stop: () => {
          // SIGKILL 而不是 SIGTERM：llama-server 在加载模型时不响应 SIGTERM，留下的
          // 孤儿进程占着几 GB 内存，读者只会觉得电脑变慢却找不到原因。
          child.kill("SIGKILL");
        },
      };
    },
  };
}

async function unpackLlama(root: string): Promise<void> {
  // 官方发布是 tar.gz。用系统 tar，不引第三方解包库——macOS 和 Windows 10+ 都自带。
  await mkdir(path.join(root, "unpacked"), { recursive: true });
  await run("tar", ["-xzf", path.join(root, "llama.tar.gz"), "-C", path.join(root, "unpacked")]);

  // 发布包的目录层级换过几次（build/bin 与 bin 都出现过），所以找出来而不是写死。
  const found = await run("find", [path.join(root, "unpacked"), "-name", "llama-server", "-type", "f"]);
  const binDir = path.dirname(found.trim().split("\n")[0] ?? "");
  if (!binDir) throw new Error("解包后没找到 llama-server");

  await rm(path.join(root, "bin"), { recursive: true, force: true });
  await rename(binDir, path.join(root, "bin"));
  await chmod(path.join(root, "bin", "llama-server"), 0o755);
  await rm(path.join(root, "llama.tar.gz"), { force: true });
  await rm(path.join(root, "unpacked"), { recursive: true, force: true });
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command}: ${err || code}`))));
  });
}

/**
 * 等它真的能服务。
 *
 * 进程起来 ≠ 能用：加载权重要几十秒，这期间端口已经在听但请求会失败。同时盯着子进程
 * 退出——它自己崩了的话（端口占用、权重损坏）不该干等到超时，那会让读者盯着
 * 「正在启动」看两分钟才拿到一个毫无信息的超时。
 */
async function waitHealthy(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-2000)));

  const died = new Promise<never>((_, reject) => {
    child.on("exit", (code) => reject(new Error(`llama-server 退出（code ${code}）：${stderr.trim()}`)));
  });

  const healthy = (async () => {
    for (let attempt = 0; attempt < 240; attempt++) {
      const ok = await fetch(url)
        .then((response) => response.ok)
        .catch(() => false);
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("llama-server 起来了但两分钟内没就绪");
  })();

  try {
    await Promise.race([healthy, died]);
  } catch (error) {
    throw new Error(errorChain(error) || "本地引擎启动失败");
  }
}

/** 让系统分配一个空闲端口，不写死——写死的话开着两个实例就撞车。 */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

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
 * `LocalEngine` 的 Node 实现：下 llama.cpp 与 PaddleOCR-VL 的权重，拉起 `llama-server`。
 *
 * 选型与两个产品决策见 ADR-0015。这里只关心怎么把它跑起来。
 */

const LLAMA_RELEASE = "b10453";
const MODEL_REPO = "PaddlePaddle/PaddleOCR-VL-1.6-GGUF";

/**
 * 先只做 macOS arm64。**没验证过的平台不算支持**（同 ADR-0014 的边界）——
 * 与其塞一堆猜出来的 URL，不如在这里明确报「这个平台还没做」。
 */
function binaryAsset(): EngineAsset {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`本地识别引擎目前只做了 macOS arm64，当前是 ${process.platform}/${process.arch}。`);
  }
  return {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-macos-arm64.tar.gz`,
    target: "llama.tar.gz",
    bytes: 10,
  };
}

const WEIGHTS: EngineAsset[] = [
  {
    url: `https://huggingface.co/${MODEL_REPO}/resolve/main/PaddleOCR-VL-1.6-GGUF.gguf`,
    target: "model.gguf",
    bytes: 892,
  },
  {
    // 视觉投影。**少了它 llama-server 起得来但看不见图**——报的还是一个跟「缺文件」
    // 毫无关系的错，所以它和主权重同等必需。
    url: `https://huggingface.co/${MODEL_REPO}/resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf`,
    target: "mmproj.gguf",
    bytes: 840,
  },
];

export function llamaEngineDeps(root: string, onProgress?: (text: string | null) => void): EngineDeps {
  const at = (target: string) => path.join(root, target);

  return {
    assets: [binaryAsset(), ...WEIGHTS],
    onProgress,

    async has(target: string): Promise<boolean> {
      // 二进制下完就解包删掉压缩包，所以查的是解出来的可执行文件。
      const probe = target === "llama.tar.gz" ? "bin/llama-server" : target;
      return stat(at(probe))
        .then((info) => info.size > 0)
        .catch(() => false);
    },

    async fetch(asset: EngineAsset): Promise<void> {
      const response = await fetch(asset.url);
      if (!response.ok || !response.body) throw new Error(`${asset.target}：HTTP ${response.status}`);

      // 先写 .part 再改名：下到一半断网留下的半个文件，下次会被 has() 当成「已就绪」，
      // 然后 llama-server 报一个跟「文件不全」毫无关系的错。
      const staging = at(`${asset.target}.part`);
      await mkdir(path.dirname(staging), { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        createWriteStream(staging),
      );
      await rename(staging, at(asset.target));

      if (asset.target === "llama.tar.gz") await unpackLlama(root);
    },

    async spawn(): Promise<RunningProcess> {
      const port = await freePort();
      const child = spawn(
        at("bin/llama-server"),
        [
          "--model", at("model.gguf"),
          "--mmproj", at("mmproj.gguf"),
          "--host", "127.0.0.1",
          "--port", String(port),
          // 只服务本机的这一个应用，不需要并发。
          "--parallel", "1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      const baseURL = `http://127.0.0.1:${port}/v1`;
      try {
        await waitHealthy(`http://127.0.0.1:${port}/health`, child);
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }

      return {
        baseURL,
        stop: () => {
          // SIGKILL 而不是 SIGTERM：llama-server 在加载模型时不响应 SIGTERM，
          // 留下的孤儿进程占着几 GB 内存，读者只会觉得电脑变慢却找不到原因。
          child.kill("SIGKILL");
        },
      };
    },
  };
}

async function unpackLlama(root: string): Promise<void> {
  // 官方发布是 tar.gz，解出来是 build/bin/*。用系统 tar，不引第三方解包库
  // ——macOS 和 Windows 10+ 都自带。
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
 * 进程起来 ≠ 能用：加载 1.7 GB 权重要几十秒，这期间端口已经在听但请求会失败。
 * 同时盯着子进程的退出——它自己崩了的话（端口占用、权重损坏）不该干等到超时，
 * 那会让读者盯着「正在启动」看两分钟才拿到一个毫无信息的超时。
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
    throw new Error(errorChain(error) || "本地识别引擎启动失败");
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

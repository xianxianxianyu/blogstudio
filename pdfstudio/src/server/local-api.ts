import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { env } from "@huggingface/transformers";
import sirv from "sirv";
import { createClipStore } from "../clip/clip-store";
import { createBookshelf } from "../bookshelf/bookshelf";
import { createModelDownloader } from "../model/model-download";
import { DEFAULT_EMBEDDING_MODEL } from "../model/model-files";
import { createTransformersEmbedder } from "../model/transformers-embedder";
import { deserialize, serializeClip } from "../clip/clip-wire";
import { createLocalEngine } from "../model/local-engine";
import { llamaEngineDeps } from "../model/llama-server";
import { errorChain } from "../app/error-chain";
import type { Clip } from "../clip/clip";

/**
 * 本机 API：摘录、书架、配置、索引缓存、模型权重、向量计算、模型端点转发。
 *
 * **dev server 与打包应用共用这一份**（ADR-0014）。打包时改用 IPC 的话，每条边界都要
 * 写两份适配器——而这个项目已经反复被「写好了没接上」和「两处各写一份规则」咬过，
 * 两份适配器是同一个形状的陷阱，而且更隐蔽：dev 下全绿，打包后才出问题。
 *
 * 返回一串带前缀的中间件，挂到 vite 的 `server.middlewares` 或裸 `http.Server` 上都行。
 */
export interface LocalApiOptions {
  /** 书架与摘录的根目录：一个文档一个文件夹，摘录住在里面。 */
  libraryRoot: string;
  /** 模型权重目录。 */
  modelsRoot: string;
  /** 配置文件路径（含 apiKey，只在本机流动）。 */
  configFile: string;
}

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface Route {
  prefix: string;
  handler: Handler;
}

export const ROUTES = {
  config: "/__config",
  model: "/__model",
  clips: "/__clips",
  docs: "/__docs",
  index: "/__index",
  models: "/__models",
  embed: "/__embed",
  engine: "/__engine",
} as const;

export function createLocalApi(options: LocalApiOptions): Route[] {
  const engineStatus = () => engine?.status() ?? { running: false, baseURL: null };

  // **先把目录建出来。** 首次运行时它们都不存在，而 sirv 启动时就会去扫模型目录，
  // 扫不到直接抛——窗口还没出现应用就崩了。开发环境一直没暴露这个问题，只是因为
  // 那两个目录早就被下载和导入建好了；换一台机器、全新 clone 就是同样的下场。
  mkdirSync(options.libraryRoot, { recursive: true });
  mkdirSync(options.modelsRoot, { recursive: true });

  const shelf = createBookshelf(options.libraryRoot);
  const store = createClipStore(options.libraryRoot);
  const downloader = createModelDownloader(options.modelsRoot);

  // 向量在这边算：onnxruntime-node 是原生多线程，浏览器那条 WASM 路是单线程，一篇
  // 论文的索引差出一个量级（9.6 秒 vs 几分钟）。权重直接读下好的那份，不再另下一遍。
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = `${options.modelsRoot}/`;
  // 懒建：没人问文档时不该把 300 MB 加载进来。
  let embedder: ReturnType<typeof createTransformersEmbedder> | null = null;

  // 本地识别引擎（ADR-0015）。懒建：没人启用时连它的依赖都不构造——构造函数里就会
  // 因为平台不支持而抛。
  let engine: ReturnType<typeof createLocalEngine> | null = null;
  const engineRoot = path.join(options.modelsRoot, "llama");

  return [
    {
      prefix: ROUTES.engine,
      handler: (request, response) =>
        respond(response, async () => {
          if (request.method === "DELETE") {
            engine?.stop();
            return json({ running: false, baseURL: null });
          }
          if (request.method === "POST") {
            engine ??= createLocalEngine(llamaEngineDeps(engineRoot, (text) => (enginePhase = text)));
            // 1.7 GB 的下载 + 加载，不能把一个请求挂住——立刻返回，进度靠轮询。
            void engine.ensureReady().catch((error: unknown) => {
              enginePhase = errorChain(error) || "本地识别引擎启动失败";
            });
            return json({ ...engineStatus(), phase: enginePhase });
          }
          return json({ ...engineStatus(), phase: enginePhase });
        }),
    },

    { prefix: ROUTES.model, handler: (request, response) => void forwardModel(request, response) },

    {
      prefix: ROUTES.config,
      handler: (request, response) =>
        respond(response, async () => {
          if (request.method === "POST") {
            await writeFile(options.configFile, await readBody(request), "utf8");
            return json({});
          }
          // 文件不存在返回 null 而不是报错：首次运行还没配任何东西是正常状态。
          return { type: JSON_TYPE, data: await readFile(options.configFile, "utf8").catch(() => "null") };
        }),
    },

    {
      prefix: ROUTES.docs,
      handler: (request, response) => {
        const [docId, action] = segments(request);
        respond(response, async () => {
          if (request.method === "POST" && !docId) {
            const filename = decodeURIComponent(String(request.headers["x-filename"] ?? "未命名.pdf"));
            return json(await shelf.import({ filename, bytes: await readBytes(request), at: Date.now() }));
          }
          if (!docId) return json(await shelf.list());
          if (request.method === "DELETE") {
            await shelf.remove(docId);
            return json({});
          }
          if (action === "title") {
            await shelf.rename(docId, await readBody(request));
            return json({});
          }
          return { type: "application/pdf", data: Buffer.from(await shelf.read(docId)) };
        });
      },
    },

    {
      prefix: ROUTES.clips,
      handler: (request, response) => {
        const [docId, clipId] = segments(request);
        respond(response, async () => {
          if (!docId) throw new Error("缺少 docId");
          if (request.method === "POST") {
            await store.save(docId, deserialize<Clip>(await readBody(request)));
            return json({});
          }
          if (request.method === "DELETE" && clipId) {
            await store.delete(docId, clipId);
            return json({});
          }
          return {
            type: JSON_TYPE,
            data: `[${(await store.listByDoc(docId)).map(serializeClip).join(",")}]`,
          };
        });
      },
    },

    {
      // 正文向量缓存，落在这篇文档自己的文件夹里（ADR-0011 的形状）。删文档时跟着
      // 一起没，不需要另外清。
      prefix: ROUTES.index,
      handler: (request, response) => {
        const [docId] = segments(request);
        const file = path.join(options.libraryRoot, docId ?? "", "index-vectors.json");
        respond(response, async () => {
          if (!docId) throw new Error("缺少 docId");
          if (request.method === "POST") {
            await writeFile(file, await readBody(request), "utf8");
            return json({});
          }
          return { type: JSON_TYPE, data: await readFile(file, "utf8").catch(() => "null") };
        });
      },
    },

    {
      prefix: `${ROUTES.models}/__status`,
      handler: (request, response) =>
        respond(response, async () =>
          json(
            request.method === "POST"
              ? downloader.start(DEFAULT_EMBEDDING_MODEL)
              : await downloader.check(DEFAULT_EMBEDDING_MODEL),
          ),
        ),
    },

    {
      // 权重按静态文件服务。**不能用 dev: true**——那个选项专门关掉缓存头，于是每次
      // 刷新都要重新传 300 MB。权重不可变（模型 id + 文件名唯一确定内容），永久缓存。
      prefix: ROUTES.models,
      handler: sirv(options.modelsRoot, { etag: true, maxAge: 31536000, immutable: true }),
    },

    {
      prefix: ROUTES.embed,
      handler: (request, response) =>
        respond(response, async () => {
          embedder ??= createTransformersEmbedder();
          const { kind, texts } = JSON.parse(await readBody(request)) as {
            kind: "query" | "documents";
            texts: string[];
          };
          const vectors =
            kind === "query" ? [await embedder.embedQuery(texts[0])] : await embedder.embedDocuments(texts);

          // 一整块二进制回去，不逐条写 JSON 数组：97 段 × 768 维写成十进制是几 MB 文本。
          const dims = vectors[0]?.length ?? 0;
          const flat = new Float32Array(dims * vectors.length);
          vectors.forEach((vector, index) => flat.set(vector, index * dims));
          return json({ dims, data: Buffer.from(flat.buffer).toString("base64") });
        }),
    },
  ];
}

/** 引擎当前在做什么（下载哪个文件、启动到哪一步），或上一次失败的原因。 */
let enginePhase: string | null = null;

const JSON_TYPE = "application/json";
const json = (data: unknown) => ({ type: JSON_TYPE, data: JSON.stringify(data) });

function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const readBody = async (request: IncomingMessage): Promise<string> =>
  (await readBytes(request)).toString("utf8");

/** 路径切成段，顺带解码——文件名和书名可能是中文。 */
const segments = (request: IncomingMessage): string[] =>
  (request.url ?? "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);

/** 把一条 handler 的成败统一收口，别让异常悄悄变成 200。 */
function respond(
  response: ServerResponse,
  body: () => Promise<{ type: string; data: string | Buffer }>,
): void {
  body()
    .then(({ type, data }) => {
      response.setHeader("content-type", type);
      response.end(data);
    })
    .catch((error: Error) => {
      // 500 + 原因。静默成功会让调用方以为已落盘（内存有、磁盘空）
      // ——ADR-0011 说文件才是唯一真相。
      response.statusCode = 500;
      response.end(error.message);
    });
}

/**
 * 把模型端点转发一道，**目标由调用方在路径里给**：`/__model/<编码过的 baseURL>/...`。
 *
 * 起初这里是写死到配置里默认组的地址。那样一来「每个功能各配各的端点」（ADR-0010）
 * 就是假的——给识别配了本地端点，请求照样发去云端，而设置页的自检还会说「通了」。
 *
 * 为什么需要转发：实测那个端点的 OPTIONS 预检返回 403、也没有任何 access-control-*
 * 头，浏览器直连必被拦在预检那一步。
 */
async function forwardModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const [encoded, ...rest] = (request.url ?? "/").split("?")[0].split("/").filter(Boolean);
    const query = (request.url ?? "").includes("?") ? `?${(request.url ?? "").split("?")[1]}` : "";
    const target = `${decodeURIComponent(encoded ?? "")}/${rest.join("/")}${query}`;

    const upstream = await fetch(target, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers)
          // host 必须去掉，否则上游按它路由会 404；content-length 让 fetch 自己算。
          .filter(([name]) => name !== "host" && name !== "content-length")
          .map(([name, value]) => [name, String(value)]),
      ),
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : new Uint8Array(await readBytes(request)),
    });

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      // 别把上游的 content-encoding 透出去：fetch 已经解过压，再声明一次浏览器会解第二遍。
      if (name !== "content-encoding" && name !== "content-length") response.setHeader(name, value);
    });
    // 流式转发，不整块 buffer：chat 走 SSE，缓冲会把「边生成边显示」变成「转圈半天
    // 然后一次性出现」，而那正是 ADR-0008 选 assistant-ui 要的东西。
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as ReadableStream), response);
    else response.end();
  } catch (error) {
    response.statusCode = 502;
    response.end((error as Error).message);
  }
}

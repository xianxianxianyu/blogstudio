import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import sirv from "sirv";
import { createClipStore } from "../clip/clip-store";
import { createBookshelf } from "../bookshelf/bookshelf";
import { createTagStore } from "../tag/tag-store";
import { createOutlineStore } from "../outline/outline-store";
import { deserialize, serializeClip } from "../clip/clip-wire";
import { createLocalEngine } from "../model/local-engine";
import { EMBEDDING_SPEC, RECOGNITION_SPEC, llamaEngineDeps } from "../model/llama-server";
import { createLlamaEmbedder } from "../model/llama-embedder";
import { createFileEngineRegistry } from "../model/engine-registry-file";
import { errorChain } from "../app/error-chain";
import { authorize } from "./guard";
import type { Clip } from "../clip/clip";
import type { Embedder } from "../model/embedder";
import { createContextStudio } from "../../../contextstudio/src/api";
import type { Context } from "../../../contextstudio/src/context";
import { createDraftStore } from "../../../blogstudio/src/draft-store";
import { createRevisionStore } from "../../../blogstudio/src/revisions";
import type { Draft } from "../../../blogstudio/src/draft";

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
  /**
   * 写保护的令牌，每次启动新生成。空串 = 不设防。
   *
   * **必填而不是可选**：可选的话，忘了接线的那天没有任何东西会提醒，而后果是
   * 任何网页都能改掉模型端点（见 `guard.ts` 里那段实测）。要不设防，就得显式写空串。
   */
  token: string;
  /** 书架与摘录的根目录：一个文档一个文件夹，摘录住在里面。 */
  libraryRoot: string;
  /** 模型权重目录。 */
  modelsRoot: string;
  /** 配置文件路径（含 apiKey，只在本机流动）。 */
  configFile: string;
  /**
   * pdf.js 随包静态资源的根（含 `cmaps/`、`standard_fonts/`、`wasm/`、`iccs/`）。
   *
   * **必填**：少了它，不嵌字体的中文书 `getTextContent()` 直接返回空串，而且不报错
   * （见 `src/pdf/assets.ts`）。做成可选的话，忘了接线的那一天没有任何东西会提醒。
   *
   * dev 下指 `node_modules/pdfjs-dist`；打包应用里 node_modules 整个不进包，指的是
   * 构建时拷进 `dist/pdfjs/` 的那份。
   */
  pdfjsRoot: string;
  /**
   * 算向量的实现。省略就在本进程里跑（dev server 下没问题）。
   *
   * 打包应用必须传一个跑在别处的——onnxruntime-node 的原生模块在 Electron 主进程上
   * 加载并推理会直接 EXC_BREAKPOINT，整个应用当场消失，连错误都没有。
   */
  embedder?: Embedder;
}

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface LocalApi {
  routes: Route[];
  /**
   * 停掉所有本地引擎。**应用退出时必须调用。**
   *
   * 不调用的后果量过：`llama-server` 是 `spawn()` 出来的子进程，父进程一没它就被系统
   * 收养继续跑，一个占 3 GB。重启五次留下四个孤儿、14 GB、机器卡死。
   *
   * 这里是正常退出那条路；被 SIGKILL 或者崩溃时它跑不到，那种情况靠下次启动收尸
   * （`engine-registry.ts`）。两条都要有，缺一条就有一类退出方式在漏。
   */
  shutdown(): void;
}

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
  tags: "/__tags",
  outline: "/__outline",
  models: "/__models",
  pdfjs: "/__pdfjs",
  embed: "/__embed",
  engine: "/__engine",
  contexts: "/__contexts",
  drafts: "/__drafts",
} as const;

export function createLocalApi(options: LocalApiOptions): LocalApi {
  const engineStatus = () => engine?.status() ?? { running: false, baseURL: null };

  // **先把目录建出来。** 首次运行时它们都不存在，而 sirv 启动时就会去扫模型目录，
  // 扫不到直接抛——窗口还没出现应用就崩了。开发环境一直没暴露这个问题，只是因为
  // 那两个目录早就被下载和导入建好了；换一台机器、全新 clone 就是同样的下场。
  mkdirSync(options.libraryRoot, { recursive: true });
  mkdirSync(options.modelsRoot, { recursive: true });

  const shelf = createBookshelf(options.libraryRoot);
  const store = createClipStore(options.libraryRoot);
  const tags = createTagStore(options.libraryRoot);
  const outlines = createOutlineStore(options.libraryRoot);

  // Context Studio 的库与书架**并列**，不在书架里面：一条 context 可以来自任何一本书，
  // 甚至将来来自网页，塞进某本书的文件夹就等于宣布它属于那本书（ADR-0002）。
  const studio = createContextStudio(path.resolve(options.libraryRoot, "../contexts"));

  // 稿子与书架、context 库**三者并列**，同一个道理：一篇稿子不属于任何一本书。
  // 目录里就是一堆 `.md`，外面的编辑器打开就能改（`blogstudio/src/draft-store.ts`）。
  const draftsRoot = path.resolve(options.libraryRoot, "../drafts");
  const drafts = createDraftStore(draftsRoot);
  // 历史版本住在 `drafts/.revisions/` 里——同一个根，隐藏目录，不混进稿子架
  // （`blogstudio/src/revisions.ts`）。
  const revisions = createRevisionStore(draftsRoot);


  // 懒建：没人问文档时不该把 300 MB 加载进来。
  let embedder: Embedder | null = options.embedder ?? null;

  // 两个本地引擎，共用一份 llama.cpp 二进制：识别（ADR-0015，可选）与向量（问文档要用）。
  // 懒建：没人用时连依赖都不构造——构造函数里就会因为平台不支持而抛。
  let engine: ReturnType<typeof createLocalEngine> | null = null;
  let vectorEngine: ReturnType<typeof createLocalEngine> | null = null;
  const engineRoot = path.join(options.modelsRoot, "llama");

  // 上一次没退干净留下的引擎，开机先收掉（`engine-registry.ts`）。
  const registry = createFileEngineRegistry(path.join(engineRoot, "running.json"));
  // **拉起新引擎之前必须等它做完。** 收尸是「读账本 → 杀 → 清空」，中间新记的一条会被
  // 那次清空吞掉——于是这个新引擎再没人认得，下次启动收不到它。
  const reaped = registry
    .reap()
    .then((count) => {
      if (count > 0) console.error(`[engine] 收掉 ${count} 个上次没退干净的 llama-server`);
    })
    .catch(() => undefined);

  const routes: Route[] = [
    {
      prefix: ROUTES.engine,
      handler: (request, response) =>
        respond(response, async () => {
          if (request.method === "DELETE") {
            engine?.stop();
            return json({ running: false, baseURL: null });
          }
          if (request.method === "POST") {
            await reaped;
            engine ??= createLocalEngine(
              llamaEngineDeps(engineRoot, RECOGNITION_SPEC, (text) => (enginePhase = text), registry),
            );
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
      // 标签表落在书架根上，不在某本书里——「存疑」在这篇和那篇是同一件事。
      prefix: ROUTES.tags,
      handler: (request, response) => {
        respond(response, async () => {
          if (request.method === "POST") {
            await tags.save(JSON.parse(await readBody(request)));
            return json({});
          }
          return json(await tags.load());
        });
      },
    },

    {
      // 生成的目录，落在这本书自己的文件夹里（同摘录，删书就跟着没）。
      prefix: ROUTES.outline,
      handler: (request, response) => {
        const [docId] = segments(request);
        respond(response, async () => {
          if (!docId) throw new Error("缺少 docId");
          if (request.method === "POST") {
            await outlines.save(docId, JSON.parse(await readBody(request)));
            return json({});
          }
          if (request.method === "DELETE") {
            await outlines.remove(docId);
            return json({});
          }
          return json(await outlines.load(docId));
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
      prefix: ROUTES.contexts,
      handler: (request, response) => {
        // 前缀已被剥掉（vite middlewares 与 electron 那边都守这个约定）。
        const [action, id] = segments(request);
        respond(response, async () => {
          if (request.method === "POST" && action === "topics" && id) {
            await studio.update(id, JSON.parse(await readBody(request)) as { topics: string[] });
            return json({});
          }
          // 临时桥：把书架里已入库（promoted）的摘录扫成 context。
          //
          // **这不是 ADR-0002 说的那条导出层**，那条归 PDF Studio、还在另一条线程手里
          // （`.scratch/knowledge-graph/issues/01`）。在它落地之前，知识库拿不到任何真实
          // 数据，图页面就只是一张白纸——所以先有这个。落地之后**删掉这一段**。
          //
          // 它守住了 ADR-0002 的两条硬要求：id 由 `(docId, clipId)` 派生所以重扫幂等；
          // 不填 topics，主题由读者在这一侧定。
          if (request.method === "POST" && action === "sweep") {
            let added = 0;
            for (const doc of await shelf.list()) {
              const clips = await store.listByDoc(doc.id);
              const contexts: Context[] = clips
                .filter((clip) => clip.state === "promoted" && clip.sourceText !== null)
                .map((clip) => ({
                  id: `${doc.id}__${clip.id}`,
                  sourceClipId: clip.id,
                  source: { docId: doc.id, title: doc.title, locator: `p.${clip.region.page}` },
                  claim: clip.title,
                  evidence: clip.sourceText ?? "",
                  stance: null,
                  status: "pending",
                  sourceClipDeleted: false,
                  topics: [],
                }));
              added += (await studio.ingest(doc.id, contexts)).added;
            }
            return json({ added });
          }
          if (action === "focus" && id) return json(await studio.focus(id));
          return json(await studio.view());
        });
      },
    },

    {
      prefix: ROUTES.drafts,
      handler: (request, response) => {
        const [id, what, which] = segments(request);
        respond(response, async () => {
          // 版本：`/<id>/revisions` 列一下、`/<id>/revisions/<n>` 取一版、POST 追加一版。
          if (what === "revisions") {
            if (!id) throw new Error("缺少稿子的 id");
            if (request.method === "POST") {
              const one = JSON.parse(await readBody(request)) as { markdown: string; why: string; at: number };
              return json(await revisions.append(id, one));
            }
            return json(which ? await revisions.read(id, Number(which)) : await revisions.list(id));
          }
          if (request.method === "POST") {
            await drafts.save(JSON.parse(await readBody(request)) as Draft);
            return json({});
          }
          if (request.method === "DELETE") {
            if (!id) throw new Error("缺少稿子的 id");
            await drafts.remove(id);
            return json({});
          }
          // 不给 id 就是要整个稿子架；给了就是要这一篇的正文。
          return json(id ? await drafts.load(id) : await drafts.list());
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
            // 同 `tag-store` / `outline-store`：**写之前保证目录在**，不靠上面那句
            // 启动时的 `mkdirSync`。这一处是四个里唯一没有自己 store 的——向量缓存
            // 就一个 JSON，不值得为它抽一层，所以 mkdir 只能写在这儿。
            // 失败的样子最不响：索引存不下去，读者每次开这本书都要重算一两分钟，
            // 而没有任何一处会说这是为什么。
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, await readBody(request), "utf8");
            return json({});
          }
          return { type: JSON_TYPE, data: await readFile(file, "utf8").catch(() => "null") };
        });
      },
    },


    {
      // 权重按静态文件服务。**不能用 dev: true**——那个选项专门关掉缓存头，于是每次
      // 刷新都要重新传 300 MB。权重不可变（模型 id + 文件名唯一确定内容），永久缓存。
      prefix: ROUTES.models,
      handler: sirv(options.modelsRoot, { etag: true, maxAge: 31536000, immutable: true }),
    },

    {
      // pdf.js 的 CMap / 标准字体 / wasm / ICC。走本机 API 而不是相对路径：打包后页面
      // 是 file://，没有 origin 可依（同 api-base.ts 的理由）。
      // 内容随 pdf.js 版本固定，永久缓存。
      prefix: ROUTES.pdfjs,
      handler: sirv(options.pdfjsRoot, { etag: true, maxAge: 31536000, immutable: true }),
    },

    {
      prefix: ROUTES.embed,
      handler: (request, response) =>
        respond(response, async () => {
          if (!embedder) {
            // 向量走 llama-server，不再走 onnxruntime-node——后者在 Electron 的进程里
            // 根本跑不起来（主进程 EXC_BREAKPOINT，utilityProcess 同一个信号）。
            // 首次会下 318 MB 权重并加载，进度经 enginePhase 报出去。
            await reaped;
            vectorEngine ??= createLocalEngine(
              llamaEngineDeps(engineRoot, EMBEDDING_SPEC, (text) => (enginePhase = text), registry),
            );
            const { baseURL } = await vectorEngine.ensureReady();
            embedder = createLlamaEmbedder(baseURL);
          }

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

  return {
    // **在收口处统一挡，不逐条路由加。** 逐条加就是「漏一条就默认开门」，
    // 而这类洞会一直长出来（同 `clip.ts` 里 GUARDS 那张表的理由）。
    routes: routes.map((route) => ({
      prefix: route.prefix,
      handler: (request, response) => {
        if (!authorize(request.method, request.headers, options.token)) {
          response.statusCode = 403;
          response.end("需要令牌。");
          return;
        }
        route.handler(request, response);
      },
    })),
    shutdown(): void {
      // 两个都要停。此前 `vectorEngine` 连一条 stop 的路径都没有——问过一次文档之后，
      // 那 300 MB 会一直挂到关机，而没有任何界面提到它的存在。
      engine?.stop();
      vectorEngine?.stop();
    },
  };
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
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await readBytes(request));

    const upstream = await fetch(target, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers)
          // host 必须去掉，否则上游按它路由会 404；content-length 让 fetch 自己算。
          .filter(([name]) => name !== "host" && name !== "content-length")
          .map(([name, value]) => [name, String(value)]),
      ),
      body,
    });

    // 上游自己返的错要留痕。**「502 是我们抛的还是上游返的」在外面根本分不清**——
    // 两边都叫 Bad Gateway，而 SDK 只报状态行、不报响应体，于是界面上永远是同一句话。
    // 只记方法、路径、body 大小和状态：**不记 header**，Authorization 就在里面。
    if (!upstream.ok) {
      console.error(
        `[__model] 上游 ${upstream.status} ${new URL(target).pathname} body=${body?.byteLength ?? 0}B`,
      );
    }

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
    // **要整条链**：undici 把一切都叫 `fetch failed`，真正的原因（`ECONNRESET`、
    // 证书、DNS）只活在 `cause` 里。只回那五个字的时候，界面上就只剩「模型调用失败」，
    // 从那儿是查不下去的——这一条真的挡了一次目录识别。
    const why = errorChain(error) || (error as Error).message;
    // 也写一份到主进程日志：SDK 只把状态行（"Bad Gateway"）往上报，响应体它不看，
    // 所以光靠回给浏览器的这段文字，界面上还是什么都看不到。
    console.error(`[__model] 转发失败 ${why}`);
    response.end(why);
  }
}

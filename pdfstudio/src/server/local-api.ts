import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
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
import type { Clip } from "../clip/clip";
import type { Embedder } from "../model/embedder";
import type { Context } from "../../../contextstudio/src/context";
import { JSON_TYPE, guarded, json, readBody, readBytes, respond, segments, type Route } from "./http";
import { WRITING_ROUTES, createWritingApi } from "./writing-api";

export type { Handler, Route } from "./http";


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

export const ROUTES = {
  ...WRITING_ROUTES,
  clips: "/__clips",
  docs: "/__docs",
  index: "/__index",
  tags: "/__tags",
  outline: "/__outline",
  models: "/__models",
  pdfjs: "/__pdfjs",
  embed: "/__embed",
  engine: "/__engine",
  sites: "/__sites",
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

  /**
   * 写作那一半（`writing-api.ts`）：配置、模型、context、文章、Loop、同步。
   * 它单独也能起——`research.moyutianzun.com/write` 上就只有它。这里把书架那条桥
   * 递过去：把已入库的摘录扫成 context（`/__contexts/sweep`）。
   */
  const writing = createWritingApi({
    dataRoot: path.resolve(options.libraryRoot, ".."),
    configFile: options.configFile,
    /**
     * 临时桥：把书架里已入库（promoted）的摘录扫成 context。
     *
     * **这不是 ADR-0002 说的那条导出层**，那条归 PDF Studio、还在另一条线程手里
     * （`.scratch/knowledge-graph/issues/01`）。在它落地之前，知识库拿不到任何真实
     * 数据，图页面就只是一张白纸——所以先有这个。落地之后**删掉这一段**。
     *
     * 它守住了 ADR-0002 的两条硬要求：id 由 `(docId, clipId)` 派生所以重扫幂等；
     * 不填 topics，主题由读者在这一侧定。
     */
    async contextSweep(studio) {
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
      return { added };
    },
  });

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

    {
      /**
       * 允许在应用内加载的站点（`web/allow.ts`）。
       *
       * **不做「任意网站」的默认开放**——Electron 里 Safe Browsing 与 Certificate
       * Transparency 都是关的，官方自己说「要显示网站，浏览器是更安全的选择」。
       * 所以这是一份读者显式加进来的白名单，落在书架根上（跟标签一份，它是读者的
       * 习惯，不属于某一本书）。
       */
      prefix: ROUTES.sites,
      handler: (request, response) =>
        respond(response, async () => {
          const file = path.join(options.libraryRoot, "sites.json");
          if (request.method === "POST") {
            await writeFile(file, await readBody(request), "utf8");
            return json({});
          }
          // 没有这个文件是正常状态：还没加过任何站点。
          return { type: JSON_TYPE, data: await readFile(file, "utf8").catch(() => "[]") };
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
    routes: guarded([...routes, ...writing.routes], options.token),
    shutdown(): void {
      // 两个都要停。此前 `vectorEngine` 连一条 stop 的路径都没有——问过一次文档之后，
      // 那 300 MB 会一直挂到关机，而没有任何界面提到它的存在。
      engine?.stop();
      vectorEngine?.stop();
      writing.shutdown();
    },
  };
}

/** 引擎当前在做什么（下载哪个文件、启动到哪一步），或上一次失败的原因。 */
let enginePhase: string | null = null;

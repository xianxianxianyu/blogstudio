/**
 * PDF Studio 界面（React）。旧的裸 DOM 页面 `/index.html` 仍然可跑——迁移期它是唯一的
 * 回归基准（`.scratch/pdfstudio-ui/spec.md`）。
 *
 *   npm run dev:pdfstudio   然后打开 /react.html
 */
import { createRoot } from "react-dom/client";
import * as pdfjs from "pdfjs-dist";
// @ts-expect-error ——`?url` 是 Vite 的产物，TS 不认识这种导入
import worker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { createWorkspace } from "../../src/app/workspace";
import { createRecognizer } from "../../src/recognizer/recognizer";
import { createChat } from "../../src/chat/chat";
import { createFixedPromptRecognitionClient } from "../../src/model/fixed-prompt-recognition";
import { bindConversation, createConversation } from "../../src/app/conversation";
import { createProgress } from "../../src/app/progress";
import { apiUrl, apiFetch } from "../api-base";
import { createHttpEmbedder } from "../http-embedder";
import { createHttpIndexCache } from "../http-index-cache";
import { createModelClient } from "../../src/model/openai-compatible";
import { createLiveClient } from "../../src/model/live-client";
import type { ModelClient } from "../../src/model/model-client";
import { parseConfig, resolveEndpoint, type Capability } from "../../src/config/config";
import { createHttpClipStore } from "../http-clip-store";
import { createHttpTagStore } from "../http-tags";
import { createHttpOutlineStore } from "../http-outline";
import { createHttpBookshelf } from "../http-bookshelf";
import { createHttpSiteStore } from "../http-sites";
import { createHttpPublishing } from "../http-publish";
import { createHttpBlog } from "../http-blog";
import { createHttpContextStudio } from "../http-context-studio";
import { createHttpLoopReader } from "../http-loops";
import { createHttpDraftStore } from "../http-drafts";
import { createWriter } from "../../../blogstudio/src/writing";
import { createRecaller } from "../../../blogstudio/src/recall";
import { createWriterChat } from "../../../blogstudio/src/writer-chat";
import { createWritingTalk } from "../../../blogstudio/src/conversation";
import { createHttpConfigStore } from "../http-config";
import { createSettings } from "../../src/app/settings";
import { App } from "./App";
import { createPdfHost } from "./pdf-host";

pdfjs.GlobalWorkerOptions.workerSrc = worker as string;

const configStore = createHttpConfigStore(apiUrl("/__config"));
let appConfig = await configStore.load().catch(() => parseConfig(null));

const settings = createSettings({
  load: () => configStore.load(),
  save: (next) => configStore.save(next),
  // 自检就是拿这组端点真打一次最小的调用——「地址能不能连」和「这个 key 加这个模型名
  // 能不能用」是两回事，只有真打一次才分得清。
  probe: async (endpoint) => {
    await createModelClient({ fetch: apiFetch, ...endpoint, baseURL: viaProxy(endpoint.baseURL) }).complete({
      messages: [{ role: "user", content: "ping" }],
    });
  },
});
await settings.load();
settings.subscribe(() => {
  // 云端那几个客户端都是 `live()` 建的，每次调用现读这份配置——改完 key 立刻生效，
  // 已经打开的书、正在写的稿子都不用重开。本地识别引擎那条路例外：它的地址来自
  // 引擎进程，不来自这份配置。
  appConfig = settings.config;
});

/**
 * 走 dev server 转发而不是直连：实测那个端点的 OPTIONS 预检返回 403，浏览器过不去。
 * 打包应用里没有这一层（ADR-0006），所以这段是开发页面专属的。
 *
 * **目标编在路径里**，不是写死一个。写死的话「每个功能各配各的端点」（ADR-0010）
 * 在浏览器里就是假的：给识别配了本地端点，请求照样发去云端。
 *
 * **必须是绝对 URL**：SDK 会拿 baseURL 去构造 URL 对象，相对路径直接抛。
 */
function viaProxy(baseURL: string): string {
  return `${apiUrl("/__model")}/${encodeURIComponent(baseURL)}`;
}

function endpoint(capability: Capability) {
  const resolved = resolveEndpoint(appConfig, capability);
  return { ...resolved, baseURL: viaProxy(resolved.baseURL) };
}

/**
 * 某个能力的云端客户端，**每次调用现读配置**（`live-client.ts`）。
 *
 * 不这么做的话，设置页改了 key 之后，写作助手和问文档用的还是启动时那把——
 * 而且不报错。设置页头上写着「改动立刻保存」，那就得真的立刻生效。
 */
const live = (capability: Capability): ModelClient =>
  createLiveClient(() => createModelClient({ ...endpoint(capability), fetch: apiFetch }));

// 缓存里记着它：换了模型向量就作废，不同模型的向量不在同一个空间里，混用不报错，
// 只会让检索悄悄返回不相干的段落。
const EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX@q8";

const progress = createProgress();

/**
 * 识别这一档怎么构造：本地还是云端（ADR-0015）。
 *
 * **本地档是降级档**：PaddleOCR-VL 只认六个固定 prompt、不做翻译，所以
 * `translation` 显式给 null——类型上它是必填的，正是为了让「这一档没有译文」成为一个
 * 写出来的决定，而不是某处漏接的后果。
 */
async function recognitionTier() {
  if (!settings.config.localRecognition) {
    return {
      recognition: live("recognition"),
      // 翻译是独立配置的（ADR-0010）。漏掉它译文永远不出现，那个 bug 真的发生过一次。
      translation: live("translation"),
    };
  }

  const status = (await apiFetch(apiUrl("/__engine"), { method: "POST" }).then((r) => r.json())) as {
    baseURL: string | null;
  };
  if (!status.baseURL) throw new Error("本地识别引擎还没就绪——去设置里看进度。");

  return {
    // 专用识别模型看不懂我们的 JSON 契约，套一层把它翻译成 `OCR:`。
    recognition: createFixedPromptRecognitionClient(
      createModelClient({ fetch: apiFetch, baseURL: viaProxy(status.baseURL), apiKey: "-", model: "paddleocr-vl" }),
    ),
    translation: null,
  };
}
// 向量交给 dev server 算（onnxruntime-node 原生多线程），浏览器这侧只发请求。
// 此前走的是 Worker + WASM：不卡界面，但建一篇论文的索引要几分钟，而且每次页面加载
// 都要往 WASM 里塞 300 MB 权重。打包后主进程正是这么跑（ADR-0006）。
const embedder = createHttpEmbedder(apiUrl("/__embed"), progress);
const conversation = createConversation();

// pdf.js 的文档句柄归视图，Workspace 不认识它——它只要一个依赖都接好了的 Recognizer。
const host = createPdfHost();

const ws = createWorkspace({
  shelf: createHttpBookshelf(apiUrl("/__docs")),
  store: createHttpClipStore(apiUrl("/__clips")),
  tags: createHttpTagStore(apiUrl("/__tags")),
  outlines: createHttpOutlineStore(apiUrl("/__outline")),
  async openDocument(bytes, doc, clips, tags) {
    const document = await host.open(bytes);
    const chat = createChat({
      document,
      docId: doc.id,
      model: live("chat"),
      // 本地 embedding：不接的话中文问英文论文是**零召回**（关键词那一路抽不出中文词元）。
      // 权重是首次真正检索时才下载的，开一本书不会触发。
      embedder,
      // 摘录进检索池：文本层在公式和图上是空的，那两处只有摘录里有。
      clips,
      // 标签名也进摘录块：量过，退化的分类问句 0/4 → 3/4，别的指标一个没动。
      tags,
      // 正文向量缓存到这本书的文件夹里。不缓存的话每次打开都要重算一遍整篇论文，
      // 浏览器 WASM 里要一两分钟——读者每次开书都得先等着才能问第一句。
      indexCache: createHttpIndexCache(apiUrl("/__index"), doc.id, EMBEDDING_MODEL),
    });
    const recognizer = createRecognizer({ document, ...(await recognitionTier()) });
    return { recognizer, chat };
  },
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
  // 读函数而不是快照：读者随时会在设置里改天数或点「知道了」，钉死快照会让改动不生效
  // 且不报错。
  retention: () => settings.config.retention,
});

bindConversation(ws, conversation);

/**
 * 写这一侧（ADR-0004）。三样东西接在一起：稿子怎么存、怎么召回材料、怎么说话。
 *
 * 与 Book 那侧共用的只有两个**端口**：模型客户端与向量服务。领域上两边不认识对方
 * ——Blog Studio 只从知识库读 `context` 那一个形状（`CONTEXT-MAP.md`）。
 */
const contextStudio = createHttpContextStudio(apiUrl("/__contexts"));
const loops = createHttpLoopReader(apiUrl("/__loops"));
const writer = createWriter({
  store: createHttpDraftStore(apiUrl("/__drafts")),
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
});
const talk = createWritingTalk({
  chat: createWriterChat({
    // 写作与问文档是两件事，各配各的端点（ADR-0010 的口径；能力清单见 config.ts）。
    model: live("writing"),
    // 现取而不是钉一份快照：刚在 Context Studio 那边收了一批，这边就该召回得到。
    materials: async () => (await contextStudio.view()).contexts,
    // 用与问文档同一个向量服务：同一个模型、同一个空间，省掉第二份权重。
    recaller: createRecaller({ embed: embedder }),
  }),
  // 每次发问现取正文——稿子一直在变，钉住快照就是在答上一版。
  draft: () => writer.text(),
});

/**
 * 认扫描版目录页用的模型。**每次现建**而不是建好一个传进去：读者随时可能在设置里
 * 换端点，钉死一个实例就会让改完的配置不生效，而且不报错（`settings.subscribe` 那边
 * 已经为同样的理由踩过一次）。
 */
const tocModel = () => live("recognition");

/**
 * 认扫描版目录页用的**本地** OCR。
 *
 * 优先走本地，云端只当退路——不是为了省钱，是因为**云端那条路对这个任务不可靠**：
 * 实测同一张图同一个提示词，一批 3/3 成功、另一批 3/3 在 16 秒被网关掐断，成败不是
 * 我们输入的函数（纯文本请求一直正常）。本地引擎没有网关，每栏 22 秒稳定出结果。
 *
 * 这里要的是**裸的** ModelClient，不套 `createFixedPromptRecognitionClient`——那层把
 * 输出包成 Recognizer 的 JSON 契约，而目录这条路要的就是 OCR 原文。
 *
 * 返回 null = 本地档没开或引擎还没就绪，调用方退回云端。
 */
async function localTocOcr(): Promise<ModelClient | null> {
  if (!settings.config.localRecognition) return null;
  const status = (await apiFetch(apiUrl("/__engine"), { method: "POST" }).then((r) => r.json())) as {
    baseURL: string | null;
  };
  if (!status.baseURL) return null;
  return createModelClient({ fetch: apiFetch, baseURL: viaProxy(status.baseURL), apiKey: "-", model: "paddleocr-vl" });
}

/**
 * **先渲染，再上架、再开书。**
 *
 * 这三步原本是渲染之前的顶层 await，于是任何一步抛错都会让 React 根本没机会跑——
 * 界面直接白屏，主进程日志里什么都没有。实际踩到的是：读者开着本地识别档，重启后引擎
 * 要几十秒加载权重，这期间 `recognitionTier()` 抛「还没就绪」，整个应用就打不开了。
 *
 * 开机自动打开一本书是**锦上添花**，它失败最多是「停在书架上」，绝不该是「应用没了」。
 */
createRoot(document.querySelector("#root")!).render(
  <App
    ws={ws}
    host={host}
    settings={settings}
    conversation={conversation}
    progress={progress}
    tocModel={tocModel}
    localTocOcr={localTocOcr}
    loops={loops}
    publishing={createHttpPublishing(apiUrl("/__publish"))}
    blog={createHttpBlog(apiUrl("/__blog"))}
    siteStore={createHttpSiteStore(apiUrl("/__sites"))}
    contextStudio={contextStudio}
    writer={writer}
    talk={talk}
    contexts={async () => (await contextStudio.view()).contexts}
  />,
);

void (async () => {
  try {
    await ws.refresh();
    if (ws.state.docs.length > 0) await ws.openDoc(ws.state.docs[0].id);
  } catch (error) {
    // 停在书架上，读者自己点那本书时会拿到一条能看的错（见 App 的 openDoc）。
    console.warn("开机自动打开失败", error);
  }
})();

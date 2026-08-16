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
import { createTransformersEmbedder } from "../../src/model/transformers-embedder";
import { bindConversation, createConversation } from "../../src/app/conversation";
import { createModelClient } from "../../src/model/openai-compatible";
import { parseConfig, resolveEndpoint } from "../../src/config/config";
import { createHttpClipStore } from "../http-clip-store";
import { createHttpBookshelf } from "../http-bookshelf";
import { createHttpConfigStore } from "../http-config";
import { createSettings } from "../../src/app/settings";
import { App } from "./App";
import { createPdfHost } from "./pdf-host";

pdfjs.GlobalWorkerOptions.workerSrc = worker as string;

const configStore = createHttpConfigStore("/__config");
let appConfig = await configStore.load().catch(() => parseConfig(null));

const settings = createSettings({
  load: () => configStore.load(),
  save: (next) => configStore.save(next),
  // 自检就是拿这组端点真打一次最小的调用——「地址能不能连」和「这个 key 加这个模型名
  // 能不能用」是两回事，只有真打一次才分得清。
  probe: async (endpoint) => {
    await createModelClient({ ...endpoint, baseURL: viaProxy(endpoint.baseURL) }).complete({
      messages: [{ role: "user", content: "ping" }],
    });
  },
});
await settings.load();
settings.subscribe(() => {
  // 改完设置后新建的 Recognizer 要用新配置。已经打开的文档不重建——它的
  // Recognizer 是打开时接好的，换端点得重新打开这本书。
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
  return `${location.origin}/__model/${encodeURIComponent(baseURL)}`;
}

function endpoint(capability: "recognition" | "translation" | "chat") {
  const resolved = resolveEndpoint(appConfig, capability);
  return { ...resolved, baseURL: viaProxy(resolved.baseURL) };
}

const embedder = createTransformersEmbedder();
const conversation = createConversation();

// pdf.js 的文档句柄归视图，Workspace 不认识它——它只要一个依赖都接好了的 Recognizer。
const host = createPdfHost();

const ws = createWorkspace({
  shelf: createHttpBookshelf("/__docs"),
  store: createHttpClipStore("/__clips"),
  async openDocument(bytes, doc, clips) {
    const document = await host.open(bytes);
    const chat = createChat({
      document,
      docId: doc.id,
      model: createModelClient(endpoint("chat")),
      // 本地 embedding：不接的话中文问英文论文是**零召回**（关键词那一路抽不出中文词元）。
      // 权重是首次真正检索时才下载的，开一本书不会触发。
      embedder,
      // 摘录进检索池：文本层在公式和图上是空的，那两处只有摘录里有。
      clips,
    });
    const recognizer = createRecognizer({
      document,
      recognition: createModelClient(endpoint("recognition")),
      // 翻译是独立配置的（ADR-0010）。类型上必填——漏掉它译文永远不出现。
      translation: createModelClient(endpoint("translation")),
    });
    return { recognizer, chat };
  },
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
});

bindConversation(ws, conversation);
await ws.refresh();
if (ws.state.docs.length > 0) await ws.openDoc(ws.state.docs[0].id);

createRoot(document.querySelector("#root")!).render(<App ws={ws} host={host} settings={settings} conversation={conversation} />);

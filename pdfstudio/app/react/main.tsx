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
import { createModelClient } from "../../src/model/openai-compatible";
import { parseConfig, resolveEndpoint } from "../../src/config/config";
import { createHttpClipStore } from "../http-clip-store";
import { createHttpBookshelf } from "../http-bookshelf";
import { App } from "./App";
import { createPdfHost } from "./pdf-host";

pdfjs.GlobalWorkerOptions.workerSrc = worker as string;

const appConfig = parseConfig(
  await fetch("/__config")
    .then((response) => response.json() as Promise<unknown>)
    .catch(() => null),
);

function endpoint(capability: "recognition" | "translation") {
  const resolved = resolveEndpoint(appConfig, capability);
  // 走 dev server 转发而不是直连：那个端点的 OPTIONS 预检返回 403，浏览器过不去。
  // 打包应用里没有这一层（ADR-0006）。**必须是绝对 URL**，SDK 会拿它构造 URL 对象。
  return { ...resolved, baseURL: `${location.origin}/__model` };
}

// pdf.js 的文档句柄归视图，Workspace 不认识它——它只要一个依赖都接好了的 Recognizer。
const host = createPdfHost();

const ws = createWorkspace({
  shelf: createHttpBookshelf("/__docs"),
  store: createHttpClipStore("/__clips"),
  async openDocument(bytes) {
    const document = await host.open(bytes);
    return createRecognizer({
      document,
      recognition: createModelClient(endpoint("recognition")),
      // 翻译是独立配置的（ADR-0010）。类型上必填——漏掉它译文永远不出现。
      translation: createModelClient(endpoint("translation")),
    });
  },
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
});

await ws.refresh();
if (ws.state.docs.length > 0) await ws.openDoc(ws.state.docs[0].id);

createRoot(document.querySelector("#root")!).render(<App ws={ws} host={host} />);

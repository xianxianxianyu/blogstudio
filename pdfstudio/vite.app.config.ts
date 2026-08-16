import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { createClipStore } from "./src/clip/clip-store";
import { createBookshelf } from "./src/bookshelf/bookshelf";
import type { Clip } from "./src/clip/clip";
import { deserialize, serializeClip } from "./app/clip-wire";

const CONFIG_ROUTE = "/__config";
const PROXY_PREFIX = "/__model";
const CLIPS_ROUTE = "/__clips";
const DOCS_ROUTE = "/__docs";
const INDEX_ROUTE = "/__index";

/**
 * 书架落在这里，摘录住在各文档文件夹的 `clips/` 下——**同一个 root**。
 * 已 gitignore：这是你的书和阅读记录，不是仓库内容。
 */
const LIBRARY_ROOT = path.join(import.meta.dirname, ".library");

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
function respond(response: ServerResponse, body: () => Promise<{ type: string; data: string | Buffer }>) {
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

const json = (data: unknown) => ({ type: "application/json", data: JSON.stringify(data) });

/**
 * 把模型端点转发一道，**目标由调用方在路径里给**：`/__model/<编码过的 baseURL>/...`。
 *
 * 起初这里是 vite 的 server.proxy，写死到 config.json 默认组的地址。那样一来
 * 「每个功能各配各的端点」（ADR-0010）在浏览器里根本不生效——给识别单独配一个本地
 * 端点，请求照样发去云端，而设置页的自检还会说「通了」。**自检说通的不是你配的那个**，
 * 这比没有自检更坏。
 *
 * 为什么需要转发：实测那个端点的 OPTIONS 预检返回 403、响应里也没有任何
 * access-control-* 头，浏览器直连必被拦在预检那一步。ADR-0006 说最终是 local-first
 * 打包应用，主进程直接发请求，没有 CORS 这一层——转发只是开发页面才需要的东西。
 */
async function forwardModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const [encoded, ...rest] = (request.url ?? "/").split("?")[0].split("/").filter(Boolean);
  const query = (request.url ?? "").includes("?") ? `?${(request.url ?? "").split("?")[1]}` : "";
  const target = `${decodeURIComponent(encoded ?? "")}/${rest.join("/")}${query}`;

  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      // 只带该带的。host 必须去掉，否则上游按它路由会 404；其余业务头原样透传。
      ...Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name]) => name !== "host" && name !== "content-length")
          .map(([name, value]) => [name, String(value)]),
      ),
    },
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
  // 流式转发，不整块 buffer：chat 走 streamComplete（SSE），缓冲会把「边生成边显示」
  // 变成「转圈半天然后一次性出现」，而那正是 ADR-0008 选 assistant-ui 要的东西。
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as ReadableStream), response);
  else response.end();
}

// 开发用的框选竖切页面（`pdfstudio/app/`），与仓库根那个 Blog Studio 应用无关。
// PDF Studio 最终是 local-first 打包应用（ADR-0006），不住在 Cloudflare 那套里。
export default defineConfig({
  root: path.join(import.meta.dirname, "app"),
  publicDir: path.join(import.meta.dirname, "eval"),
  build: {
    // 两个入口：新的 React 界面与旧的裸 DOM 页面。迁移期旧的必须一直能跑
    // ——它是唯一的回归基准（.scratch/pdfstudio-ui/spec.md）。
    rollupOptions: {
      input: {
        react: path.join(import.meta.dirname, "app/react.html"),
        legacy: path.join(import.meta.dirname, "app/index.html"),
      },
    },
  },
  server: { port: 5174 },
  plugins: [
    react(),
    {
      name: "pdfstudio-dev-config",
      // 浏览器读不了文件系统，所以由 dev server 把 config.json 递过去。
      // **只挂在 configureServer 上**——它不存在于构建产物里，key 不会被打包
      // （ADR-0005：真实 key 绝不进源码或构建产物）。这个页面本来也只是开发竖切。
      configureServer(server) {
        server.middlewares.use(PROXY_PREFIX, (request, response) => {
          forwardModel(request, response).catch((error: Error) => {
            response.statusCode = 502;
            response.end(error.message);
          });
        });

        const configFile = path.join(import.meta.dirname, "config.json");
        server.middlewares.use(CONFIG_ROUTE, (request, response) => {
          respond(response, async () => {
            if (request.method === "POST") {
              // 写回配置。**这条路由只挂在 configureServer 上**，不存在于构建产物里
              // ——ADR-0005：真实 key 绝不进源码或构建产物。
              await writeFile(configFile, await readBody(request), "utf8");
              return json({});
            }
            return {
              type: "application/json",
              data: await readFile(configFile, "utf8").catch(() => "null"),
            };
          });
        });

        // 真正的落盘。浏览器那侧的 ClipStore 只是把调用转发到这儿——渲染进程不碰
        // 文件系统，这条边界在打包应用里是 IPC（ADR-0006）。
        // 书架与摘录共用一个 root：一个文档一个文件夹，摘录住在里面。
        const shelf = createBookshelf(LIBRARY_ROOT);
        server.middlewares.use(DOCS_ROUTE, (request, response) => {
          const [docId, action] = segments(request);
          respond(response, async () => {
            if (request.method === "POST" && !docId) {
              const filename = decodeURIComponent(String(request.headers["x-filename"] ?? "未命名.pdf"));
              return json(
                await shelf.import({ filename, bytes: await readBytes(request), at: Date.now() }),
              );
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
        });

        // 正文向量缓存，落在这篇文档自己的文件夹里（ADR-0011 的形状：一个文档一个
        // 文件夹）。删文档时它跟着一起没，不需要另外清。
        server.middlewares.use(INDEX_ROUTE, (request, response) => {
          const [docId] = segments(request);
          const file = path.join(LIBRARY_ROOT, docId ?? "", "index-vectors.json");
          respond(response, async () => {
            if (!docId) throw new Error("缺少 docId");
            if (request.method === "POST") {
              await writeFile(file, await readBody(request), "utf8");
              return json({});
            }
            return { type: "application/json", data: await readFile(file, "utf8").catch(() => "null") };
          });
        });

        const store = createClipStore(LIBRARY_ROOT);
        server.middlewares.use(CLIPS_ROUTE, (request, response) => {
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
              type: "application/json",
              data: `[${(await store.listByDoc(docId)).map(serializeClip).join(",")}]`,
            };
          });
        });
      },
    },
  ],
});

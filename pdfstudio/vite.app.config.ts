import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClipStore } from "./src/clip/clip-store";
import { createBookshelf } from "./src/bookshelf/bookshelf";
import type { Clip } from "./src/clip/clip";
import { deserialize, serializeClip } from "./app/clip-wire";

const CONFIG_ROUTE = "/__config";
const PROXY_PREFIX = "/__model";
const CLIPS_ROUTE = "/__clips";
const DOCS_ROUTE = "/__docs";

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
 * 把模型端点转发一道。
 *
 * 实测那个端点的 OPTIONS 预检返回 403、响应里也没有任何 `access-control-*` 头
 * ——浏览器直连必被拦在预检那一步，POST 根本发不出去。
 *
 * **这不是产品设计问题。** ADR-0006 说最终是 local-first 打包应用，Electron/Tauri
 * 的主进程或原生运行时直接发请求，没有 CORS 这一层。转发只是这个开发页面跑在浏览器
 * 里才需要的东西，不进产品形态。
 */
function modelTarget(): string {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "config.json"), "utf8"),
    ) as { baseURL?: string; default?: { baseURL?: string } };
    return raw.default?.baseURL ?? raw.baseURL ?? "";
  } catch {
    return "";
  }
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
  server: {
    port: 5174,
    proxy: modelTarget()
      ? {
          [PROXY_PREFIX]: {
            target: modelTarget(),
            changeOrigin: true,
            rewrite: (url: string) => url.replace(PROXY_PREFIX, ""),
          },
        }
      : undefined,
  },
  plugins: [
    react(),
    {
      name: "pdfstudio-dev-config",
      // 浏览器读不了文件系统，所以由 dev server 把 config.json 递过去。
      // **只挂在 configureServer 上**——它不存在于构建产物里，key 不会被打包
      // （ADR-0005：真实 key 绝不进源码或构建产物）。这个页面本来也只是开发竖切。
      configureServer(server) {
        server.middlewares.use(CONFIG_ROUTE, (_request, response) => {
          readFile(path.join(import.meta.dirname, "config.json"), "utf8")
            .then((text) => {
              response.setHeader("content-type", "application/json");
              response.end(text);
            })
            .catch(() => response.end("null"));
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

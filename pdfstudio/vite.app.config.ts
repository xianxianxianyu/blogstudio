import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const CONFIG_ROUTE = "/__config";
const PROXY_PREFIX = "/__model";

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
      },
    },
  ],
});

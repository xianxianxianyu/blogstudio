import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { createLocalApi } from "./src/server/local-api";

// 开发用的界面（`pdfstudio/app/`），与仓库根那个 Blog Studio 应用无关。
// PDF Studio 是 local-first 打包应用（ADR-0006/0014），不住在 Cloudflare 那套里。
export default defineConfig({
  root: path.join(import.meta.dirname, "app"),
  publicDir: path.join(import.meta.dirname, "eval"),
  build: {
    // 两个入口：React 界面与旧的裸 DOM 页面。迁移期旧的必须一直能跑
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
      name: "pdfstudio-local-api",
      /**
       * 本机 API 与打包应用**共用同一份实现**（ADR-0014）——两份适配器是
       * 「写好了没接上」的同一个形状，而且更隐蔽：dev 下全绿，打包后才出问题。
       *
       * **只挂在 configureServer 上**：它不存在于构建产物里，含 apiKey 的配置路由
       * 不会被打包（ADR-0005：真实 key 绝不进源码或构建产物）。
       */
      configureServer(server) {
        for (const route of createLocalApi(paths())) {
          server.middlewares.use(route.prefix, route.handler);
        }
      },
    },
  ],
});

/** 开发形态下这些东西都放在 `pdfstudio/` 里；打包应用用系统的应用数据目录。 */
function paths() {
  const here = import.meta.dirname;
  return {
    libraryRoot: path.join(here, ".library"),
    modelsRoot: path.join(here, ".models"),
    configFile: path.join(here, "config.json"),
  };
}

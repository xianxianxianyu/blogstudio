import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalApi } from "./src/server/local-api";
import { PDFJS_ASSET_DIRS } from "./src/pdf/assets";

/** 用 import.meta.resolve 而不是从这里往上数 `../..`：包管理器的目录布局不归我们管。 */
const PDFJS_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/build/pdf.mjs"))),
);

// 开发用的界面（`pdfstudio/app/`），与仓库根那个 Blog Studio 应用无关。
// PDF Studio 是 local-first 打包应用（ADR-0006/0014），不住在 Cloudflare 那套里。
export default defineConfig({
  root: path.join(import.meta.dirname, "app"),
  // **相对 base**：打包后页面走 `file://`，绝对路径的 /assets/... 会解析到文件系统
  // 根目录，于是窗口起来了、白屏，控制台里一片 404。此前只验过 dev server 那条路
  // （http 下绝对路径当然没问题），file:// 那条一次都没真跑过。
  base: "./",
  // **不设 publicDir。** 曾经指向 eval/ 是为了让旧页面能取 /papers/xxx.pdf，而书架
  // 做好之后 PDF 从 .library/ 走，那条路早就没人用了。留着它会把三篇论文、19 张样本
  // 和 eval 脚本一起打进应用——25 MB 的评测语料跟着产品分发出去。
  publicDir: false,
  server: { port: 5174 },
  plugins: [
    react(),
    {
      /**
       * 把 pdf.js 的 CMap / 标准字体 / wasm / ICC 拷进 `dist/pdfjs/`。
       *
       * 拷而不是让它留在 node_modules 里：`electron-builder.yml` 把整棵 node_modules
       * 排除在安装包之外（不排的话 Blog Studio 那套依赖会一起进来，280 MB 涨到 526 MB）。
       *
       * 拷到 `dist/` 而不是 `dist/renderer/`：`app:pdfstudio` 与 `dist:pdfstudio` 两条
       * 路径都从 `app.getAppPath()` 找它，位置必须只有一个。
       */
      name: "pdfstudio-pdfjs-assets",
      apply: "build",
      closeBundle() {
        const target = path.join(import.meta.dirname, "dist", "pdfjs");
        for (const dir of PDFJS_ASSET_DIRS) {
          cpSync(path.join(PDFJS_ROOT, dir), path.join(target, dir), { recursive: true });
        }
      },
    },
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
    // dev 下直接指包里那份，不用拷。
    pdfjsRoot: PDFJS_ROOT,
  };
}

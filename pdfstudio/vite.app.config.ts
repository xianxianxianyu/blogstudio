import { defineConfig } from "vite";
import path from "node:path";

// 开发用的框选竖切页面（`pdfstudio/app/`），与仓库根那个 Blog Studio 应用无关。
// PDF Studio 最终是 local-first 打包应用（ADR-0006），不住在 Cloudflare 那套里。
export default defineConfig({
  root: path.join(import.meta.dirname, "app"),
  publicDir: path.join(import.meta.dirname, "eval"),
  server: { port: 5174 },
});

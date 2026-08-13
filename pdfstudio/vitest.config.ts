import { defineConfig } from "vitest/config";

// pdfstudio 自带 vitest 配置，避免继承仓库根的 vite.config.ts（Cloudflare 插件）。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

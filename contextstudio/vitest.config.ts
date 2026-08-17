import { defineConfig } from "vitest/config";

// knowledge 自带 vitest 配置，理由同 pdfstudio：避免继承仓库根的 vite.config.ts
// （Cloudflare 插件）。它是第三个 context，测试也自己跑自己的。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

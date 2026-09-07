import { defineConfig } from "vitest/config";

// 自带 vitest 配置，理由同 pdfstudio 与 contextstudio：别继承仓库根的 vite.config.ts
// （Cloudflare 插件）。第三个 context，测试也自己跑自己的。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

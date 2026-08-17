/**
 * 给打包目录写一份自己的 package.json。
 *
 * **这是为了让 electron-builder 碰不到仓库根部的那份。** 此前 `directories.app` 用
 * 项目根，于是它反复改写仓库的 package.json——scripts 整段删掉（`npm run eval:*` 全
 * 没了，还被提交进去过一次），main 被重算成某个依赖包里的路径（asar 根部的
 * package.json 竟然是 `ai` 那个包的，于是入口指向不存在的 ./dist/index.js：进程活着、
 * 没有窗口、没有任何日志）。
 *
 * 主进程现在全量打包（只有 electron 是外部），所以这个目录里**不需要 node_modules**
 * ——一个入口、一份渲染产物，干干净净。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const repo = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8"));

writeFileSync(
  path.join(here, "..", "dist", "package.json"),
  `${JSON.stringify(
    {
      name: "pdf-studio",
      productName: "PDF Studio",
      version: repo.version,
      description: "本地优先的论文阅读与摘录工具",
      author: repo.author ?? "PDF Studio",
      type: "module",
      main: "main.mjs",
    },
    null,
    2,
  )}\n`,
);

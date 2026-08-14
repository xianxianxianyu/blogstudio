# 本地 RAG 栈研究 — 打包应用里的 embedding 运行时、模型体积与 SQLite/FTS5

- **范围：** ADR-0006 把 PDF Studio 定为 local-first 跨平台打包应用（Mac/Windows/手机），并明确「ADR-0003/0004 里的 Cloudflare 假设在打包落地时改成 local 形态（SQLite FTS5、本地或用户配的 embedding）」。本文研究这个 local 形态的四件事：① bge-m3 级多语言 embedding 在本地 TypeScript 应用里怎么跑；② bge-m3 的体积/量化在打包应用里是否现实、更小的候选有什么公开数据；③ 本地 SQLite 选型与 FTS5 / 中文 trigram / sqlite-vec hybrid；④ 每条路线的包名、版本、star、维护、许可、是否原生编译。
- **不推翻的约束：** ADR-0003（embedding = bge-m3，理由是唯一有第一方多语言/中文证据）、ADR-0004（存储 = FTS5 + trigram，不引入专门向量库）、ADR-0006（local-first 打包）、ADR-0007（Agent/Model 基础层 = Vercel AI SDK）。技术栈 TypeScript / React / Node 22+，仓库已有 `pdfjs-dist`、`ai`、`@ai-sdk/openai-compatible`。
- **关键用例：** 读者用**中文**提问、文档是**英文**学术论文。**跨语言检索（zh query → en passage）是硬需求**，这一条会淘汰掉大部分「小而快」的候选。
- **方法：** 仅用一手来源——npm registry 元数据（`registry.npmjs.org`）、GitHub REST API（star / 最近 push / archived / license）、HuggingFace Hub API（模型文件的**实测字节数**）、模型卡原文、Node.js 官方 API 文档、`sqlite.org` 官方文档、各仓库 README 与源码。没有第三方博客总结，没有基准聚合站。
- **检索时间：** 2026-08-13。npm 版本、star 数、最近 push 时间均为该日实测值。
- **引用键：** `[S1]…` 对应 [Sources](#sources)。没有引用的论断是我自己的分析，不是一手来源事实。

> ⚠️ 一手来源的可得性说明：`arxiv.org` 在本次检索环境中不可达（TLS 连接被拒），因此 BGE-M3 论文（arXiv 2402.03216）与 mE5 技术报告（arXiv 2402.05672）的**表格数字无法直接引用**。BGE-M3 模型卡把 MIRACL / MKQA / MLDR 结果全部放成**图片**（`imgs/miracl.jpg`、`imgs/mkqa.jpg`、`imgs/long.jpg`），文本里没有数字 `[S20]`。凡是我拿不到原文数字的地方，本文一律写「无公开数据（本次不可达）」，不转述二手数字。可引用的替代一手源是 MTEB 官方结果仓库 `embeddings-benchmark/results` 的逐任务 JSON。

---

## 问题 1 — bge-m3 级 embedding 在本地 TypeScript 应用里怎么跑

（本节稍后补全）

---

## 问题 2 — bge-m3 的体积与量化，以及更小的多语言候选

（本节稍后补全）

---

## 问题 3 — 本地 SQLite、FTS5、中文 trigram 与 sqlite-vec hybrid

（本节稍后补全）

---

## 问题 4 — 各路线的包名 / 版本 / star / 维护 / 许可 / 原生编译

（本节稍后补全）

---

## Sources

（稍后补全）

# ADR-0004：一条 context 一个 markdown 文件

## 状态

Accepted（2026-08-17）

## 背景

PDF Studio 的 ADR-0011 明确把知识库的存储**留白**，还给了理由：`Context` 全是文本字段、
没有多模态资源，套「markdown + .asset」那套结构对它是多余的。现在要定了。

候选两个：**一条 context 一个 markdown 文件**（frontmatter 放结构化字段），
或者**一个 JSONL**（整库一个文件）。

`.scratch/knowledge-graph/issues/03` 当初说「倾向 markdown，但等知道全量读一次要多久
再写这条 ADR」。量完了。

## 决策

**一条 context 一个 markdown 文件。** `<root>/<contextId>.md`，frontmatter 放结构化字段，
正文放 claim 与 evidence。

## 量出来的数

| N | md 全量读 | jsonl 全量读 | **改一条要写** |
|---|---|---|---|
| 320 | 7ms | 1ms | md 377B vs jsonl 128KB |
| 2000 | 40ms | 4ms | md 377B vs jsonl 799KB |
| 10000 | 195ms | 19ms | md 377B vs jsonl **3998KB** |

## 为什么

**JSONL 读快 10 倍，但改一条要重写整个库——而改一条是高频操作。**

每条 context 入库都要定主题（ADR-0003），之后读者还会改主题、判 stance、改 status。
写不是偶发的，是主循环。JSONL 的单条写代价随库线性增长，10000 条时是 4MB，
这条曲线的方向就是错的。markdown 是恒定的 377B。

**决定性的是补救路径的不对称：**

- markdown 的弱点（全量读慢）**事后能补**——加一层索引缓存，文件仍是真相。
  这正是 ADR-0011 已经走通的那条路：「文件是唯一真相，数据库是可重建的缓存」。
- JSONL 的弱点（单条写重写整库）**补不了**，它是格式本身的性质。

而且 markdown 的读在真实量级上根本不是问题：2000 条 40ms，一次页面加载都算不上卡。
195ms 那一档要到 10000 条，那时再加缓存不迟——**现在加就是为一个还没发生的问题做设计**。

**顺带的好处**（不是决策依据，但是真的）：可 grep、可 git diff、可手改、Obsidian 直接能开。
知识库的读者不只有应用，还有 agent 和读者本人。

## 布局：扁平，不按文档分目录

`<root>/<contextId>.md`，`docId` 放在 frontmatter 里。

不按 `<root>/<docId>/` 分，尽管 `ingest` 是按 docId 定域的、分目录会让它只读一个子目录。
理由是概念上的：**知识库是跨文档的**，按来源文档分目录会把书架的结构漏进知识库里，
而 `pdfstudio/CONTEXT.md` 特意把「书架」和「知识库」定义成两回事。

代价是 `ingest` 要读全量再按 docId 过滤。在实测量级内可接受。

**而且这个代价是可以反悔的**——布局不在 `ContextStore` 的接口里
（`docs/context-store-interface.md`），改成分目录、或者加索引，调用方一行都不用动。
这正是把接口压到三个方法换来的东西。

## 代价

1. **原子性**：写文件不是事务。沿用 ADR-0011 的做法——临时文件再 `rename`（同一文件系统上
   原子），一条一条落。一批导入中途失败会留下部分写入的库，靠 `ingest` 幂等重跑修复。
2. **frontmatter 要 schema 版本号**。它是内部存储格式，不是跨产品的传输格式，
   所以不与 `docs/adr/0002` 的「没有 formatVersion」冲突——那条讲的是**交接**的形状，
   这条讲的是**落盘**的形状，两码事。
3. **文件可被手改，绕过不变量**（比如 evidence 的逐字性）。对 local-first 的个人工具
   这更像特性，但要写明：读到手改过的文件时不校验、不修复，按现状加载。

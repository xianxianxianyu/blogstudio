# Context Map

## Contexts

- [PDF Studio](./pdfstudio/CONTEXT.md) — 阅读并理解 PDF；通过把摘录（Clip）入库来产出 context
- [Context Studio](./contextstudio/CONTEXT.md) — 跨 PDF、跨文章的 context 聚合；对人的形态是一张图
- [Blog Studio](./docs/workflow.md) — 一个 agent 写文章的工作台；从知识库消费 context（目前只有设计文档 + 原型，尚无术语表）

## Relationships

- **PDF Studio → Context Studio**：**交接，不是共写**。PDF Studio 的导出层交出一批 `Context`，Context Studio 收下、定主题、落盘（见 `docs/adr/0002-handover-not-shared-writes.md`）。**导出不带主题**——主题必须对着 Context Studio 已有的主题池提议才不会分叉（`contextstudio/docs/adr/0003`）。
- **Context Studio → Blog Studio**：Blog Studio 把 context 当作素材读取；draft 的 provenance 指向 context id。
- **Context Studio 是第三个系统**：两个产品都不拥有它（见 `docs/adr/0001-shared-knowledge-base.md`）。ADR-0001 原话是「都读写它」，ADR-0002 把这句收窄了：**写库的只有 Context Studio 自己**，PDF Studio 只负责交出去。两侧的接口就是 `context` 这一个形状，除此之外不共享任何东西。
- **共享术语**：`context (Context Item)` 起源于 Blog Studio 的领域，PDF Studio 在入库时产出它，知识库存放它。三方对它的定义必须一致。

## 跨 context 的同名词

一个词在不同 context 里指不同东西时，在这里裁定归属，各自的 `CONTEXT.md` 只写自己那一份。

| 词 | 归谁 | 指什么 |
|---|---|---|
| **主题 (topic)** | Context Studio | 一条 context 讲什么。多个，自由词，知识图的边由它产生 |
| **标记 (tag)** | PDF Studio | 阅读态的颜色分类（要点/存疑…）。一条摘录最多一个，**不进知识图** |
| **标签 (label)** | PDF Studio | 摘录在页面上的可视形态：圆点 ⇄ 小窗 |
| **原文 (source text)** | PDF Studio | 摘录被截区域的逐字文本 |
| **证据 (evidence)** | Context Studio | 支撑断言的逐字引文；入库时由原文拷贝而来，此后不随摘录变化 |

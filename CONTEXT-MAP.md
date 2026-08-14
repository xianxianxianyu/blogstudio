# Context Map

## Contexts

- [PDF Studio](./pdfstudio/CONTEXT.md) — 阅读并理解 PDF；通过把摘录（Clip）入库来产出 context
- [Blog Studio](./docs/workflow.md) — 一个 agent 写文章的工作台；从知识库消费 context（目前只有设计文档 + 原型，尚无术语表）

## Relationships

- **PDF Studio → Blog Studio**：单向的摘录流转——PDF Studio 把摘录入库到共享知识库；Blog Studio 把这些 context 当作素材读取。摘录的 markdown 正文直接映射到 Blog Studio 的 markdown block（无需格式转换）。
- **共享存储**：知识库是**第三个系统**，两个产品都不拥有它、都读写它（见 `docs/adr/0001-shared-knowledge-base.md`）。两侧的接口就是 `context` 这一个形状——PDF Studio 交出去、Blog Studio 读进来，除此之外不共享任何东西。
- **共享术语**：`context (Context Item)` 起源于 Blog Studio 的领域，PDF Studio 在入库时产出它。

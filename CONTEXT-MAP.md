# Context Map

## Contexts

- [PDF Studio](./pdfstudio/CONTEXT.md) — 阅读并理解 PDF；通过把摘录（Clip）入库来产出 context
- [Context Studio](./contextstudio/CONTEXT.md) — 跨 PDF、跨文章的 context 聚合；对人的形态是一张图
- [Blog Studio](./blogstudio/CONTEXT.md) — 一个 agent 写文章的工作台；从知识库消费 context，产出稿子。设计文档见 [`docs/workflow.md`](./docs/workflow.md)，代码里现在真的存在的那一层见它自己的 `CONTEXT.md`

## Relationships

- **PDF Studio → Context Studio**：**交接，不是共写**。PDF Studio 的导出层交出一批 `Context`，Context Studio 收下、定主题、落盘（见 `docs/adr/0002-handover-not-shared-writes.md`）。**导出不带主题**——主题必须对着 Context Studio 已有的主题池提议才不会分叉（`contextstudio/docs/adr/0003`）。
- **Context Studio → Blog Studio**：Blog Studio 把 context 当作**素材**读取（只读，不写库）；回答里引用哪条就摆出哪条，写成 `[ctx:<id>]`。代码上的表现是：`blogstudio/` 只 import `contextstudio/src/context` 的类型，与 PDF Studio 之间一条 import 都没有（共用的两样都是端口：模型客户端与向量服务，靠结构类型接上）。
- **Context Studio 是第三个系统**：两个产品都不拥有它（见 `docs/adr/0001-shared-knowledge-base.md`）。ADR-0001 原话是「都读写它」，ADR-0002 把这句收窄了：**写库的只有 Context Studio 自己**，PDF Studio 只负责交出去。两侧的接口就是 `context` 这一个形状，除此之外不共享任何东西。
- **共享术语**：`context (Context Item)` 起源于 Blog Studio 的领域，PDF Studio 在入库时产出它，知识库存放它。三方对它的定义必须一致。

## 外壳 (Shell)

装着 Book、Context 与 Writer 三侧的那一个窗口。**它不属于任何一个 context**——它不持有
任何一边的领域状态，只负责「现在看哪一边、手边开着什么」（见 `docs/adr/0003`、`docs/adr/0004`）。

**根 (Root)**:
外壳左上角那几个：**Book**、**Context**、**Writer**、**Loop**、**发布**。
读、想、写、发四件事，一侧一个根（Loop 是第五件：**不在场时替你干活**），
永远在、不可关闭。**它们与案头上的条目是同一类东西**——都是「可以活着的一样」，只是根永远在。
**设置也是一个根**（`docs/adr/0005` 决策 3），钉在这一列最下面——它不是盖在内容上的一层，
它有自己的子页和自己的来路。放在下面只因为它不是日常主路径，不因为它特殊。
_Avoid_: 活动栏、模式、页签（没有「模式」这一层，见 `docs/adr/0003` 决策 3）

**设置块 (Settings block)**:
设置某一子页上的一段，比如「默认组」「标记」「这本书的目录」。归属表在
`pdfstudio/src/app/settings-map.ts` 里，带测试，守着一条硬约束：**一块可以不出现，
但绝不允许出现在两页上**——出现两次的那一刻，两处就会开始各自漂移。
_Avoid_: 分组（`默认组` 已经是端点那一组的名字）、块（检索那边的 chunk 也叫块）

**能力 (Capability)**:
需要模型的一件事：识别、翻译、问文档、写作助手。**按任务切，不按产品切**
（`pdfstudio/docs/adr/0010`）——所以它们落在三侧，配置却是同一份、同一个默认组回退。
进这份表的门槛只有一条：**配了就真的生效**（`docs/adr/0005` 决策 1）。
_Avoid_: 功能、模块、模型（模型是端点上那个名字，能力是用它干的那件事）

**案头 (Desk)**:
三个根下面那一列：**现在手边开着什么**。与**书架**、**稿子架**（一共有什么）是一对——
架子是库存，案头是工作面。**书和稿子混在同一列里，不按类型分组**（`docs/adr/0004` 决策 2
——分组就等于把被否掉的「模式」又装回来）。**同一时刻只有一项是活的**（`docs/adr/0003` 决策 2）。
_Avoid_: 标签页（`标签` 已经是摘录在页面上的形态、`标记` 是颜色分类，三个词共用一个
字头必然混淆）、工作区（`Workspace` 在代码里已经是应用层那个状态持有者）

**在读 (Active)**:
案头上当前活着的那一项。切换它＝换手上这一样东西，不是切标签页——**换书要重新读 PDF、
摘录和目录；换稿子要重新读文件、换一场对话**。
_Avoid_: 选中（那是摘录的选中态）

### 退休的词

**Reader**（2026-08-21 退休）：它同时指过两样东西——**读书那一侧**（书架 + 打开的书），
以及**渲染一页 PDF 的那个组件**。而它对前者**名不副实**：那一侧只装书，装不下网页，
「Reader」这个名字却把整个「阅读」都占了。

现在前者叫 **Book**（名副其实：它装的就是书），后者叫 `PageView`（它渲染的就是一页）。
见 `docs/adr/0006-reader-renamed-to-book.md`。**ADR-0003/0004/0005 里仍然写着 Reader，那是
当时的记录，不改**——改了就是篡改历史。

## 跨 context 的同名词

一个词在不同 context 里指不同东西时，在这里裁定归属，各自的 `CONTEXT.md` 只写自己那一份。

| 词 | 归谁 | 指什么 |
|---|---|---|
| **主题 (topic)** | Context Studio | 一条 context 讲什么。多个，自由词，知识图的边由它产生 |
| **标记 (tag)** | PDF Studio | 阅读态的颜色分类（要点/存疑…）。一条摘录最多一个，**不进知识图** |
| **标签 (label)** | PDF Studio | 摘录在页面上的可视形态：圆点 ⇄ 小窗 |
| **原文 (source text)** | PDF Studio | 摘录被截区域的逐字文本 |
| **案头 (desk)** | 外壳 | 现在开着哪些书、哪些稿子。不是书架（库存），不是 `Workspace`（代码里的状态持有者） |
| **稿子 (draft)** | Blog Studio | 一篇正在写的文章，磁盘上就是一份 `.md`。不叫「文档」——那在 PDF Studio 指一本书 |
| **素材 (material)** | Blog Studio | 写作时从知识库召回的那几条 context。是 context 的一个用途，不是新东西 |
| **证据 (evidence)** | Context Studio | 支撑断言的逐字引文；入库时由原文拷贝而来，此后不随摘录变化 |
| **能力 (capability)** | 外壳 | 需要模型的一件事（识别/翻译/问文档/写作助手）。三侧共用同一份配置，按任务切不按产品切 |

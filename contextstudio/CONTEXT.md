# Context Studio

PDF Studio 与 Blog Studio 之间的第三个系统（`docs/adr/0001-shared-knowledge-base.md`）：
跨 PDF、跨文章的 context 聚合。两个产品都不拥有它，都读写它。

它对人的形态是**一张图**——节点是断言，边是共享的主题。

## Language

### 库里的东西

**context (Context Item)**:
知识库的原子单元，也是与 PDF Studio、Blog Studio 共享的类型：一条带来源的断言。
PDF Studio 通过入库产出它，Blog Studio 把它当作素材消费。
_Avoid_: 材料、material、source、条目、卡片

**断言 (Claim)**:
一句话，说明这条 context 能支撑什么。**一条 context 只承载一个断言**——判据是能不能被
单独 approve 或 reject，不能就说明该拆。
_Avoid_: 观点、结论、summary、摘要

**来源 (Source)**:
一条 context 出自哪里：哪份文档、标题、回跳的定位。**三样都要**——跨 PDF 的知识库里，
不带文档名的页码等于没有出处，而「可回跳」是 context 的硬标准之一。
_Avoid_: 出处（那是 provenance，指的是反方向：一段正文引用了哪几条 context）、引用、locator

**证据 (Evidence)**:
支撑断言的逐字原文。**不允许改写**——转述发生在消费端，不在入库端。
_Avoid_: 引文、原文（「原文」在 PDF Studio 专指摘录被截区域的文本）、quote

**立场 (Stance)**:
这条证据对它的断言是 support、refute 还是 background。**refute 尤其要留**——只收支持性
材料，写出来像宣传稿。
_Avoid_: 倾向、极性、sentiment

**状态 (Status)**:
`pending` → `approved` / `rejected` / `disputed`。知识库不是收藏夹，条目会被推翻。
_Avoid_: 审核态、审批、flag

**主题 (Topic)**:
这条 context 讲的是什么。自由词，一条可以有多个，跨 PDF 复用。**边由它产生**。
`docs/workflow.md` §2.1 里那个 `tags` 字段说的就是它。
_Avoid_: **tag、标签、标记**（这三个词在 PDF Studio 已各有所指，见下）、分类、keyword

**孤儿 (Orphan)**:
不与任何其他 context 共享主题的节点。**它不是脏数据，是新主题的种子**——
呼应 `docs/workflow.md` ③「哪些材料不属于任何一节 → 往往是新章节的种子」。
_Avoid_: 孤立点、噪声、未分类

### 图

**知识图 (Knowledge graph)**:
知识库面向人的形态：全部 context 作为节点，共享主题的节点之间连边。
_Avoid_: 图谱、知识网络、mind map

**节点 (Node)**:
就是一条 context。**不是一篇文档**——这是它与 Obsidian 最本质的差别
（`contextstudio/docs/adr/0001-node-is-a-claim.md`）。
_Avoid_: 笔记、页面、卡片、文档

**边 (Edge)**:
两条 context 至少共享一个主题。无向，并且**记住共享的是哪几个主题**——
点开一条边必须能说出它为什么连，否则图就只是一团好看的线。
_Avoid_: 链接、link、关联、双链

**聚焦 (Focus)**:
把图收窄到某个节点及其邻居的视图状态。断言粒度下全局图必然过密，聚焦是常态而非例外。
_Avoid_: 过滤、筛选、zoom、下钻

## 不属于这个 context 的词

这三个词看起来都像「给东西打标」，但在这个仓库里各有主人，**不要混用**：

| 词 | 归谁 | 指什么 |
|---|---|---|
| **主题 (topic)** | 知识库 | 这条 context 讲什么。多个，自由词，边的来源 |
| **标记 (tag)** | PDF Studio | 阅读态的颜色分类（要点/存疑…）。一条摘录最多一个，**不进图** |
| **标签 (label)** | PDF Studio | 摘录在页面上的可视形态：圆点 ⇄ 小窗 |

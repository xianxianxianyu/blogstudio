# ADR-0002：交接，而不是两边共写

## 状态

Accepted（2026-08-17）。**细化 ADR-0001，不推翻它。**

## 背景

ADR-0001 定了「共享知识库，而非导出」，并说两个产品「都读写它」。这句话在两条开发线
并行推进时立刻出了问题：PDF Studio 的入库路径（`clip.ts` 的 `promote`）和 Context Studio
的存储与图，是两个人在两条线上同时改同一批文件。

## 决策

**PDF Studio 不写 Context Studio 的库。** 它有一个导出层，交出一批 `Context`；
Context Studio 收下、定主题、落盘。

这**不是**引入一种传输格式——那正是 ADR-0001 否掉的东西。交出去的就是
`contextstudio/src/context.ts` 里那个 `Context` 类型，PDF Studio 直接 import 它。
**没有 `formatVersion`，没有序列化契约，没有兼容层**：类型变了两边一起改，
因为两个产品仍然住在同一个仓库里——ADR-0001 的那条前提没有变。

变的只有一句：ADR-0001 说「都读写它」，现在**写库的只有 Context Studio 自己**。

## 为什么

**耦合的成本不在数据模型上，在文件上。** 两条线程同时改 `clip.ts`，冲突是天天发生的；
而「谁写库」这件事一旦定死在一侧，两边就能各自排期。交接点是一个函数签名，
不是一个共享的写入口。

**而且这个边界正好和主题的归属对齐。** `contextstudio/docs/adr/0003` 定了主题必须
**对着已有的主题池**提议，否则会分叉——原型量过，AI 提议但不看池会丢掉 4 条边
（「一致 ≠ 对齐」）。池子在 Context Studio 这边，所以主题只能在这边定。

于是导出层反而更薄：**它根本不需要知道「主题」这个概念存在。**

## 契约上的三条硬要求

**① id 稳定，导入幂等。** id 由 `(docId, clipId)` 派生，导入是 upsert 不是 append。
重新导出一次不能产生第二份 context——`docs/workflow.md` §8 把 draft 的 provenance 比作
lockfile，id 一变，所有引用它的段落全断，**而且不报错**。这是最容易漏、代价最大的一条。

**② 导出不带 `topics`。** 见上。导出层交出 `{ id, sourceClipId, source, evidence, claim?, stance? }`，
`topics` 由 Context Studio 在收下时提议并填上。

**③ evidence 是导出那一刻的快照，此后不对齐。** PDF Studio 现在靠 `promoted` 状态冻结原文
（`clip.ts` 的 `fix-source` 守卫：「已入库，原文是 context 的 evidence，不能再改」）。
如果导出取代了 promote，那条守卫就失效了——导出层必须自己保住同样的冻结，
否则摘录改一次错字，两份就分叉。

**Context Studio 不负责回头同步。** ADR-0001 担心的「一份需要对齐的第二份拷贝」就是它：
这里正面接受这个代价，并明确写死**不对齐**——摘录被删只标记来源没了
（`markSourceDeleted`），摘录被改则两份各走各的。

## 代价

导出是一个显式动作，所以**会有没导出的摘录**。「读者以为入库了其实没有」是这个设计
新引入的失败模式；PDF Studio 侧需要让「已交出 / 未交出」在界面上看得见。
共享写入口没有这个问题——那是它换来的东西。

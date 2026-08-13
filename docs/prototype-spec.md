# Blog Studio 界面原型 Spec

> 配套文档：[`workflow.md`](./workflow.md)
> 实现：`public/blog-studio-prototype.html` · 源在 scratchpad 的 `proto/`，`node build.mjs` 组装

---

## 0. 一条总原则

> **打开一篇文章，第一件事是看到文章本身，不是它的运行状态。**

一切「机器」——提交历史、review、检查、执行图——都不常驻，
它们退到两个可召唤的位置：**Git mode** 和 **Loom 抽屉**。

写作和 Git 显式分离成两个页面，但底子是同一个东西：
人、多 agent 和文章用 git 协同。

---

## 1. 信息架构

```
顶层实体（顶栏切换）
├─ Blog      文章列表 / Inbox
├─ Context   材料库 + 闸门 A
└─ Public    选一个 branch 发布

进入一篇文章
├─ Draft   ← 主页面。正文 + TOC + composer
│            左上：标题 + branch 名
│            右上：Loom 按钮
├─ Git mode  ← 点 branch 名进入。review + 提交历史 + 确定性检查
└─ Loom 抽屉 ← 右上按钮滑出。预设图 / 执行图 / 重构记录

全局 Overlay：Sync Talk（可从任意位置升级上来）
```

顶栏两种形态：

| 位置 | 顶栏内容 |
|---|---|
| 顶层实体 | `Blog Studio` + `Blog / Context / Public` 切换 + 头像 |
| 一篇文章内 | `←` + 文章标题 + **branch 胶囊** + `Loom` 按钮 + 头像 |

**branch 胶囊是模式开关**：写作态显示 `写作中`（中性），点击进入 Git mode
后变成实心蓝并显示 `Git mode`，再点回到写作。

---

## 2. 页面

### Draft（主页面 · 人机协同）

**布局**：左 TOC(224px) + 正文(最宽 720px) + 底部悬浮 composer。整页无卡片、无工具条。

- **TOC 朴素**：序号 + 标题。没有状态、没有 review 计数、没有圆点。
- **正文**：衬线体，16.5px / 1.85，block 化。选中的 block 左侧一条 accent 竖线。
- **确定性检查直接落在正文里**：无 provenance 的断言画红色波浪线，
  引用 disputed 材料的画橙色虚线，hover 出说明。
- **composer**：底部悬浮，宽度对齐正文。上沿一行状态：
  `你持笔中 · loop 已暂停` + 右侧显示锁定的 block。

#### block 展开面板

**最小编辑单位是一个 block，所以一个 block 的全部信息装在一处。**
点正文任意段落 → 面板在它正下方展开（并自动滚进可视区，避免被 composer 挡住）。
再点一次收起。正文平时**没有任何标记或按钮**。

面板从上到下三段：

| 段 | 内容 |
|---|---|
| 头 | `b8` + 右侧 `N 条 review · 去 Git mode →`（无则显示「无待处理 review」） |
| **最新一次 diff** | `rev 3 · write agent · 41 分钟前` + 右侧一句改动理由；下面 `−` 旧文（红底删除线）/ `+` 新文（绿底）。本轮未改则一行 `本轮未修改 · 最后一次改动在 rev 1` |
| **context 索引** | 一行一条小点：stance 色圆点 + claim + `ctx_xxxx`；disputed 的标红并挂 `disputed`。点击进 Context 库。无来源时红点 + `无来源` + 「标记 authored」 |

**已删除**：右侧 revision 栏、Compare 按钮、Run eval 按钮、工具条背景色、
以及原来悬停才出现的三个 gutter 按钮（改由这个面板整合）。

### Git mode（commit / review）

点 branch 胶囊进入。内容是原 Review 页 **加上从 Draft 搬来的提交历史**。

- 顶部汇总：`rev 3 · score 7.2 (↑0.8) · verdict iterate · 4 open / 2 resolved`
- 主栏：eval judgement 卡片（锚点引文 / issue / **instruction** / Accept·Dismiss·Reply·升级同步）
- 底部固定：pending 栏 + `Submit review`（agent loop 的唯一触发器）
- 侧栏：**提交历史**（rev 1→3，最佳打标，附 Decision 记录）· 确定性检查 · 迭代曲线

### Context（材料库 + 闸门 A）

顶层实体。覆盖度报告 + context 卡片逐条 approve / reject / dispute +
底部 pending → Submit。disputed 材料展示连锁影响（3 个段落引用了它 → 待重审）。

### Public（发布）

顶层实体，**只做一件事：选一个 branch 合并到 main**。

- 待发布 branch 列表：单选，显示 rev / score / 检查状态
- 选中后展开：`main ← post/agent-boundary` + metadata + 发布按钮
- 检查未过时按钮不出现，代之以阻断说明 + `去 Git mode 处理 →`
- 侧栏：已发布列表

### Loom 抽屉

右上 `Loom` 按钮滑出（宽 1080px，遮罩，Esc 关闭）。内容见 §3。

### Sync Talk（全局 Overlay）

整体暖色。顶部三枚硬约束徽章：`不能修改 branch` `不能 commit` `唯一产出物是一条 Decision`。
左对话区 + 右只读参照栏，底部主按钮 `记录 Decision`。

---

## 3. Loom（任务即图）

对应 [`workflow.md` §9](./workflow.md)。三模式切换：

| | 显示什么 |
|---|---|
| **预设图** | loom 模板声明的结构。不含重构新增节点，无实例数 |
| **执行图** | 实际跑出来的。状态着色 + 实例数 `×3` + 未走过的边虚线 |
| **对照** | 执行图 + 每节点下方的偏离标注（默认） |

**节点状态色**：`done` 绿点 · `blocked` 红 · `pending` 虚线淡化 ·
`escalated`（gate 升级成 Talk）**琥珀** · `added`（重构新增）accent 虚线。

**图与 branch 是同一件事**（[`workflow.md` §9.6](./workflow.md)）：
会写 branch 的节点实例就是一个 commit。所以这一屏同时是 agent 工作台。

**顶部 live 条**：现在有几个 agent 在跑 —— agent 名 · 节点 · 在干什么 · 已运行多久。
点击定位到图上对应节点。图上运行中的节点有呼吸光晕，有未提交产出的节点右上角一个实心点。

**侧栏四块**：

1. **待提交**（staging）—— 跑完但没落到 branch 的产出。显示 agent / task /
   变更清单，两个按钮：`提交为 rev 4` 和 `先看 CoT`。
2. **节点详情** —— 点节点后变成**实例列表**。展开某个实例可见：
   `task` · `输入` chips · **chain of thought**（分步，每步一句结论加一句细节）·
   `产出`（关联的 commit 或 report）。pending 的实例在这里也能直接 commit。
3. **偏离度** —— 9→10 节点 / 15 实例 / 回边 2‑2 / gate 升级 1‑2 / 重构 1 次
4. **重构记录** —— 暖色，含 cause 与 mutation，`a3f1c2 → 7d90e4`

---

## 4. 视觉系统

| 语义 | 用途 |
|---|---|
| `--accent` 蓝 | 主操作、当前状态、Git mode |
| `--sync` 琥珀 | Sync Talk、Decision、gate 升级、New post |
| `--support` 绿 / `--refute` 砖红 / `--danger` 红 / `--warn` 黄 | stance 与检查状态 |
| 中性灰阶 | 一切结构 |

- **Draft 没有模式色** —— 它是文章本身，不是关于文章的元信息
- `--refute` 必须与 `--sync` 拉开色相，否则 stance 色会稀释「暖色 = 同步」
- 正文衬线、ID / branch / instruction 等宽；light / dark 跟随系统

---

## 5. Mock 数据

**#12「为什么 Agent 的边界不是权限开关」** · `post/agent-boundary` · rev 3 · score 7.2

12 个 block（5 节）· 34 条 context（1 条 disputed 被 3 段引用）·
6 条 review（1 条已驳回并进 style anchor）· 8 项检查（1 项 fail 阻断）·
loom run #1（eval ×3 / revise ×2 / gate B 升级 / 1 次图重构新增 n7b）

列表页另有 4 篇：#15 开题中 · #14 待你确认材料 · #13 研究中 · #11 已发布。
**只有 #12 铺了完整数据**，点其他行会明确提示而不是静默显示 #12。

# Blog Studio 写作工作流

> 界面原型见 [`prototype-spec.md`](./prototype-spec.md)，实现在 `public/blog-studio-prototype.html`。

---

## 0. 一句话

给一个 topic 和一份 TOC 草稿，让 agent 去找资料、判定相关性、结构化入库，
然后在互相隔离的执行单元里完成 **生成 → 评审 → 修改** 的迭代，
每一轮的产物都是可回退的版本，人在两个关键闸门上做判断。

整个过程是**一张图**：任务即图，图可调度、可执行、可重构。见 §9。

---

## 1. 核心原则

### 1.1 状态在库里，不在 session 里

每个阶段的产物都是**持久化对象**（context item / draft revision / eval report），
session 只是执行器。session 可以随时丢弃重开，artifact 不能。

如果状态藏在对话历史里，第 3 轮迭代想回退到第 1 轮的版本就做不到了。

### 1.2 谁持笔

同一时刻，一个 branch 只有一个持笔人。三种模式按持笔人划分：

| 模式 | 你在看什么 | 谁持笔 | 产出 |
|---|---|---|---|
| **Talk** | 一场对话 | 没人 | 一条 Decision |
| **Studio** | 文章本身 | **你** | 你的 commit |
| **Loop** | review 列表 | write agent | agent 的 commit |

Talk 和 Loop 都是**在谈论文章**，Studio 是**在文章里**。

### 1.3 agent 写文本的唯一规则

> **agent 只有在两种情况下能动文本：改动当场被人看见，或者改动会进入 review。
> 中间地带不存在。**

- Talk 里你盯着对话框，agent 改正文你看不见 → **禁止写**
- Studio 里你盯着正文，agent 改一个词你立刻看到 → **这本身就是 review**，不需要 Diff
- Loop 里没人在场 → 必须留下可审阅的 Diff

这条规则解释了为什么 Talk 的 agent 不能写、Studio 的 agent 反而应该能写。

### 1.4 一切非当面的修改先成为可审阅的 Diff

沿用 concepts 文档已定的规则（"Agent 结果先进入 Diff"），
并扩展到 agent 之间：**agent 互相修改也必须经过 Diff，不能原地覆盖。**

### 1.5 每个断言要么有 provenance，要么标记 authored

由 context 生成的段落携带 provenance（引用了哪几个 context item）。
你在 Studio 里手写的观点没有出处，也不该有 —— 标记为 `authored`。

确定性检查的规则是：**不存在既无 provenance 又未标记 authored 的断言。**

Studio 里 agent 最有价值的工作就是实时盯这个：
「这句没来源 —— 标成你的观点，还是我去找材料？」

---

## 2. 数据模型

### 2.1 Context Item

研究阶段的产物。**存的不是"这条资料相关"，而是"它能支撑哪一句断言"。**

```jsonc
{
  "id": "ctx_01H...",
  "source": { "url": "...", "title": "...", "locator": "第 3 节 / p.12" },
  "claim": "一句话：这条材料能支撑什么",
  "evidence": "原文摘录，不允许改写",
  "stance": "support | refute | background",
  "tags": ["agent-design", "eval"],
  "section_hint": "toc-node-3",
  "confidence": 0.0,
  "status": "pending | approved | rejected | disputed"
}
```

**`evidence` 必须是原文摘录。** 一旦在入库阶段就转述，幻觉就在最上游进来了，后面全是复利。

**`stance: refute` 尤其要留。** 好文章的说服力恰恰来自正面处理反例。
只收集支持性材料写出来的东西，读着像宣传稿。

### 2.2 Draft / Revision

```jsonc
{
  "draft_id": "...",
  "revision": 3,
  "parent_revision": 2,
  "toc": [...],
  "blocks": [
    {
      "block_id": "b8",
      "type": "section",
      "markdown": "...",
      "provenance": ["ctx_01H...", "ctx_02K..."],   // 或 "authored"
      "author": "write agent | you"
    }
  ],
  "eval_score": 7.2,
  "created_by": "node n7 / instance 2"    // 指向执行图节点，见 §9
}
```

Revision 是**线性追加**的，不覆盖。任何一轮都能被取回。

### 2.3 Eval Report

```jsonc
{
  "revision": 3,
  "deterministic": { "toc_coverage": [...], "unsourced_claims": [...], ... },
  "judgements": [
    { "block_id": "b8", "issue": "...", "instruction": "...", "severity": "high" }
  ],
  "score": 7.2,
  "verdict": "iterate | ship | restructure"
}
```

---

## 3. 三种模式

### 3.1 Talk（想）

不碰文本。唯一产出物是一条 **Decision**。

Decision 写进 issue 时间线，由 Loop 异步执行。
现实里也是这样：Slack 讨论架构，结论写进 issue，然后有人去实现 —— Slack 不能改代码。

Talk 不是独立入口，是**从 Loop 升级上来的**：
在 review 某条意见时觉得"文字说不清楚"，带着那条意见的上下文开 Talk，
聊完产出的 Decision 自动回填成那条意见的 resolution。

### 3.2 Studio（写）—— 持笔锁

Studio 就是 Draft 页加上一把锁。

```
┌ Loop 持笔 ─────────────────┐      ┌ 你持笔（Studio）──────────┐
│ agent 可以 commit          │ 接管 │ Loop 暂停（run paused）    │
│ 你只能留 review comment    │ ───► │ 你直接编辑                 │
│                            │ ◄─── │ agent 随叫随到，可当面改   │
└────────────────────────────┘ 提交 └────────────────────────────┘
```

同一时刻只有一个持笔人 —— 散文的自动 merge 无解，所以用锁绕开它。

两条附加规则：

- **你的 commit 同样要过 eval。** 松锁之后下一轮照批评你的段落。
  否则 Studio 就成了绕过质量循环的后门。
- **Studio 不占 Talk 的次数配额**（§7）。配额管的是"决定"，不是"写"。

**Studio 里没有 chat 面板。** 一个悬浮 composer，回答落回正文对应位置
（沿用 concepts 文档的 Answer / Diff / Thread / Artifact 四种形态）。
chat 是个动词，不是个地方 —— 做成常驻面板它就会变成第二个文档。

### 3.3 Loop（改）

无人在场时运行。eval 产出 judgement，revise 按 judgement 改 branch。

**Submit review 是 Loop 的唯一触发器。** 先攒一批 pending comment，
点 Submit 才发出去 —— 否则写了半条 review 去吃饭，agent 立刻拿半成品去改。

### 3.4 权限表

| | Talk | Studio | Loop |
|---|---|---|---|
| 人能做 | 讨论、决定删/换/补 | 编辑正文、commit、指挥 agent 当面改 | review、accept/dismiss、批量处理 |
| 人不能做 | 编辑正文、commit | — | 直接改（要先接管） |
| Agent 能做 | 说话、检索、反驳你 | **当面改文本**、实时校验 provenance | 写 branch、跑 eval、commit |
| Agent 不能做 | **写任何东西** | 背着你改 | 自己 merge |
| 产出物 | Decision | 你的 commit | agent commit + eval report |

### 3.5 同一批对象，两个视图

eval 产出的 anchored comment 是**一批对象**，出现在两个地方：

```
   Review 列表                          Studio 页边批注
   ├ 你不在时积攒的                     ├ 你持笔时就地看到
   ├ 可筛选 / 排序 / 批量                ├ 挨着它评论的那一段
   └ pending → submit                    └ 就地回复、就地接受
```

像 Google Docs：批注既在页边也有列表。不是两个功能，是一个对象的两个视图。
页边只放标记，点开才展开；几十条的批量处理仍然回 Review 页。

### 3.6 agent 之间的对话是过程，不是产物

> 默认折叠成结论，需要时才展开。

如果你得读完每一场 agent 讨论，你什么也没省下 ——
只是把阅读从"文章"搬到了"agent 们聊文章"，而后者字数更多。

多 agent 讨论只在**有分歧时**出现，且只出结论：

```
⚠ 这一段上 eval 与 research 有分歧      [展开 3 轮]
   结论：材料支持保留，但表述需要限定条件
```

也可以主动召唤：选中一段问"这段该不该留"，让两个 agent 各说一句。
**按需、有界、就地** —— 不是常驻的环境音。

---

## 4. 阶段

### ① 开题 · Talk

聊出 TOC → 创建选题 issue → 从它开 branch。

### ② 研究 · Loop

输入 topic + TOC，产出 context items。

**相关性判定不是二元的。** 该问的不是"这条资料和 topic 相关吗"，
而是"它能支撑 TOC 的哪个节点、哪一句断言"。答不上第二个问题的不该入库。

### ③ 覆盖度报告 → 闸门 A

出一份 **TOC ↔ context 覆盖度报告**：

- 哪些节材料充足
- 哪些节是空的（→ 补研究，或这节本来就不该存在）
- 哪些材料不属于任何一节（→ **往往是新章节的种子**）

TOC 在这一步允许被改。先定死 TOC 再硬填，写出来会很勉强。

### ④ 生成 · Loop

按 TOC 逐节生成。

**检索时不按 tag 查。** 纯 tag 匹配在库大了以后召回率差，tag 体系还会漂移。
应该拿**当前 section 的标题 + 写作意图**做语义召回，tag 只做硬过滤。

### ⑤ 闸门 B：角度对不对

默认异步，点一下 approve。觉得不对才升级成 Talk。

### ⑥ eval ⇄ revise 循环

见 §5、§6。**独立执行单元，不给 eval 看生成过程** ——
evaluator 看过生成推理就会去辩护而不是挑刺。

### ⑦ 发布

确定性检查全绿才能 merge。

---

## 5. Eval 规则

> 迭代能不能收敛，完全取决于 eval 的质量。**这部分不能"以后再定"。**

### 5.1 确定性检查（不用 LLM）

| 检查 | 失败策略 |
|---|---|
| TOC 覆盖度：每节都有内容 | 阻断 |
| 每个断言有 provenance 或 authored 标记 | 阻断 |
| provenance 指向的 context 真实存在 | 阻断 |
| 引用了 disputed 状态的 context | 标记 |
| 链接可达 | 标记定位 |
| Frontmatter schema | 阻断 |
| 段落重复 / 表述雷同 | 标记 |
| 长度分布 | 标记 |

### 5.2 判断类（LLM as judge）

只评代码算不出来的：论点是否成立、**有没有自己的观点还是只在复述资料**、
是否处理了 refute 材料、语气是不是本人的。

两个硬性要求：

**(a) 必须给出可执行的修改指令。** 定位到具体 block + 具体改什么。
"可以更具体一些"等于没有 —— revise 拿到它只能瞎改。

**(b) judge 需要参照物。** 喂 3–5 篇本人旧文作为 style anchor，**对比着评**。
凭空评"文笔好不好"的 judge 只会给趋中的安全分。

**驳回要沉淀。** 每次 dismiss 必须填理由，理由进 style anchor ——
否则每写一篇都要跟 agent 吵一样的架。这是系统唯一能自我改进的机制。

---

## 6. 停止条件

- 每轮 eval 打分，**分数不再提升就停**
- 最多 3 轮
- 收工取**历史最佳 revision**，不一定是最后一轮

最后一条很重要：线性覆盖的思路默认"最新 = 最好"，但迭代是会退步的。

---

## 7. 人的闸门

### 闸门 A — context 入库后

后面所有内容都建立在这批材料上。garbage in, garbage out。
这里扫一眼的成本，比第 3 轮才发现材料有问题低一个数量级。

### 闸门 B — 第一版 draft 出来后

判断"这篇文章的角度对不对"。这是 eval 最难替代的判断。
**角度错了，迭代 10 轮也只是把错的东西打磨得更光滑。**

### Talk 次数是诊断指标

一篇文章正常总共 2 次 Talk。
**超过 3 次说明选题本身没想清楚** —— 回到 ① 重开，而不是继续在循环里磨。

---

## 8. Git 模型

**一篇文章 = 一个 branch。Merge 到 main = 发布到 public。**

| 工作流 | Git |
|---|---|
| 选题 | Issue |
| 一篇文章 | Branch |
| Revision | Commit |
| 发布 | Merge PR |
| 确定性检查 | CI / Checks |
| Eval judgement | PR review comment（锚定到 block） |
| 人闸门 | Review approval |
| 持笔锁 | 工作区所有权 |
| Draft 的 provenance | Lockfile —— 声明它依赖哪些 context |

Context 库不像源码，更像**依赖**：独立演进、被多篇共享、有自己的版本。

### 两种 issue，生命周期完全不同

| | 选题 Issue | Review Comment |
|---|---|---|
| 数量 | 一篇一个 | 每轮几条到几十条 |
| 寿命 | 贯穿整篇 | 处理完就关 |
| 锚点 | 整个 branch | 某 revision 的某 block |
| 作用 | 这篇文章的"宪法" | 一次具体修改的依据 |

### 映射不上的部分

1. **Git 的 diff 是行级的，散文的语义单位是 block。** 需要 block 级语义 diff。
2. **Git 的 auto-merge 对散文无效。** 用持笔锁绕开（§3.2）。
3. **Branch 好用，但 merge 回来必须人选。** 并行写三个角度可以，但"哪个更好"没法自动判定。

---

## 9. Loom —— 任务即图

> 名字暂定 **Loom**（织机：经线是结构，纬线是内容）。一个词，随时可改。

### 9.1 一个 task 一个 graph

上面 §4 的七个阶段不是流程图的比喻，**它就是一张图**。
每个 task 启动时实例化一张图，图的执行状态就是 task 的状态。

抽象出来只有四件常规的事：**多 agent 图、定时任务、图执行、图重构。**
不发明新东西，只是把它显式化。

### 9.2 节点类型是封闭集合

**不开放自定义逻辑结构。** 节点类型是预设的、领域特定的：

| 类型 | 做什么 | 阻塞人 |
|---|---|---|
| `research` | 扫来源 → context items | |
| `coverage` | TOC ↔ context 覆盖度报告 | |
| `gate` | 等人裁决（闸门 A / B） | ✓ |
| `draft` | 按 TOC 生成 revision | |
| `eval` | 评审 → report + judgements | |
| `revise` | 按 judgement 改 branch | |
| `checks` | 确定性检查 | |
| `publish` | merge 到 main | |
| `scan` | 定时扫源，只入库不写文章 | |

新增节点类型 = 改这份文档，**不是用户配置**。
只要节点保持是领域词，它就永远是一个带调度的写作工具，
而不是一个附赠博客功能的编排平台。

### 9.3 三种图

这是本节的核心，也是后续研究的对象。

| | 是什么 | 何时确定 |
|---|---|---|
| **预设图** | loom 模板声明的结构：该跑哪些节点、怎么连 | task 启动时 |
| **执行图** | 实际跑出来的：谁真的跑了、跑了几次、谁被跳过、gate 怎么解的 | 运行中持续追加 |
| **重构图** | 运行中**图本身被改写**后的新预设 | 每次重构时 |

三者必须是**可对齐、可 diff 的第一类对象**，而不是日志。
执行图的节点实例携带 `node_id`，指回预设图的同一个节点，
所以「预设 vs 实际」的偏离可以直接算出来。

预设图（loom 模板，进 repo，改它是一个 commit）：

```jsonc
// .loom/researched-essay.loom
{
  "id": "researched-essay",
  "trigger": "manual",
  "nodes": [
    { "id": "n1", "type": "research" },
    { "id": "n2", "type": "coverage" },
    { "id": "n3", "type": "gate", "gate": "A" },
    { "id": "n4", "type": "draft" },
    { "id": "n5", "type": "gate", "gate": "B" },
    { "id": "n6", "type": "eval" },
    { "id": "n7", "type": "revise" },
    { "id": "n8", "type": "checks" },
    { "id": "n9", "type": "publish" }
  ],
  "edges": [
    { "from": "n1", "to": "n2" },
    { "from": "n2", "to": "n3" },
    { "from": "n3", "to": "n4" },
    { "from": "n4", "to": "n5" },
    { "from": "n5", "to": "n6" },
    { "from": "n6", "to": "n7", "when": "verdict != 'ship'" },
    { "from": "n7", "to": "n6", "guard": "score_improved && round < 3" },  // 回边
    { "from": "n6", "to": "n8", "when": "verdict == 'ship' || !score_improved || round >= 3" },
    { "from": "n8", "to": "n9", "when": "checks_all_pass" }
  ]
}
```

执行图节点实例：

```jsonc
{
  "node_id": "n6", "instance": 3, "type": "eval",
  "status": "done", "attempts": 1,
  "in": ["rev3"], "out": ["evalreport_3"],
  "started": "...", "ended": "..."
}
```

gate 实例要记**怎么解的**，这是执行图最有信息量的字段之一：

```jsonc
{
  "node_id": "n5", "type": "gate", "status": "done",
  "resolution": "escalated",        // approved | escalated | rejected
  "talk": "talk_2", "decision": "dec_1"
}
```

### 9.4 图重构必须记录 cause

**这是让研究成立的关键约束。**

一条 Decision 可以改变后续结构。例如 mock 里那次：
「第 4 节合并进第 3 节」→ TOC 变了 → 后续 eval / revise 的作用范围也变了。
这时候图本身被改写。

每次重构必须留下一条带**因果**的记录，否则事后无法解释执行图为什么偏离预设图：

```jsonc
{
  "at": "...",
  "cause": { "kind": "decision", "id": "dec_1", "from": "talk_2" },
  "mutation": [
    { "op": "toc.merge",  "args": ["t4", "t3"] },
    { "op": "node.add",   "node": { "id": "n7b", "type": "revise", "scope": ["b8", "b9"] } }
  ],
  "graph_before": "sha256:...", "graph_after": "sha256:..."
}
```

`cause` 的取值是封闭的：`decision`（来自 Talk）/ `gate`（人在闸门上改了 TOC）/
`eval`（verdict = restructure）/ `human`（Studio 里直接改了结构）。

于是可研究的量就有了：

- **偏离度** —— diff(预设图, 执行图)：多跑了几轮、哪些节点被跳过、哪些 gate 被升级
- **重构频次与成因分布** —— 哪一类 cause 最常导致改图
- **预设图的质量** —— 一个 loom 模板如果每次跑都被重构，说明它设计得不对

### 9.5 调度

`trigger` 三种：`manual` / `cron` / `event`。

定时任务不是另一套东西，就是**一个 cron 触发的 loom**。
`weekly-scan.loom` 只有一个 `scan` 节点，不挂任何文章，跑完往 context 库入料。

不同文章跑不同 loom：短评论用 `quick-take`（跳过 research），
考据长文用 `researched-essay`。文章声明自己跑哪一个。

### 9.6 图与 branch 是同一件事

> **执行图就是带因果结构的 git log。git log 是它的线性投影 —— 丢掉了「为什么」。**

| 图 | Git |
|---|---|
| **会写 branch 的节点实例** | **一个 commit** |
| 不写 branch 的节点（`eval` / `checks` / `coverage`） | CI run |
| `gate` 节点 | review approval |
| 回边经过一次 | 一轮迭代 |
| 图重构 | 无对应物 —— 这是 git 没有的东西（见 §9.4） |

对照本文的 run：`n4#1 → rev 1`、`n7#1 → rev 2`、`n7#2 → rev 3`。
`git log` 只会告诉你有三个 commit；执行图还告诉你 rev 2 是因为 `verdict=restructure`、
rev 3 是因为 5 条 accepted instruction。

### 9.7 Staging：根据过程决定 commit

节点跑完不等于产出已经进 branch。中间有一个 staging 状态：

```
节点实例跑完 → 产出 pending → 人看 task + CoT → commit 或丢弃
```

这正是 git 的 working tree → index → commit，只是暂存的是 agent 的产出。

每个实例必须留下三样东西，否则「看过再决定」无从谈起：

- **task** —— 交给它的指令与输入
- **chain of thought** —— 它怎么想的（压缩成几步，不是原始 token 流）
- **产出** —— 结果，以及它对应哪个 commit

什么时候进 staging、什么时候直接 commit：

| 情形 | 行为 |
|---|---|
| 异步 loop 自动跑（你不在场） | 直接 commit —— 它本来就会走 Review 流程 |
| 由一条 Decision 触发的重构节点 | **进 staging** —— 图刚被改过，产出值得先看 |
| 你持笔时触发的节点 | 进 staging —— 你在场，顺手就看了 |

### 9.8 执行语义

- 节点状态：`pending` / `running` / `blocked` / `done` / `skipped` / `failed`
- `gate` 节点的 `blocked` 就是"在等人"，这是本图区别于普通 cron pipeline 的地方
- **持笔锁 = run 被 pause**（§3.2）。你接管时整张图暂停
- 停止条件在图上的表达就是那条回边的 `guard`（§6）
- 一次 run 的 `round` 由回边经过次数决定

---

## 10. 页面

界面原型见 [`prototype-spec.md`](./prototype-spec.md)。

一条总原则：

> **打开一篇文章，第一件事是看到文章本身，不是它的运行状态。**

所以「机器」不常驻，退到两个可召唤的位置：

```
Draft（主页面）      正文 + TOC + composer，别的什么都没有
  ├─ 点 branch 名 → Git mode    commit / review / 确定性检查
  └─ 点 Loom 按钮 → 抽屉滑出     预设图 / 执行图 / 重构记录
```

写作（§3.2 Studio）和 Git（§3.3 Loop）**显式分离成两个页面**，
但底子是同一件事：人、多 agent 和文章用 git 协同。
branch 名本身就是这两个模式之间的开关。

顶层实体三个：**Blog**（文章列表）· **Context**（材料库）· **Public**（选 branch 发布）。

Draft 页面的两条细则：

- **默认隐藏一切标记**。provenance、本轮改动、review 计数只在
  鼠标移到该 block 上时从右侧淡入 —— 阅读态必须干净。
- **TOC 不带状态**。它是目录，不是仪表盘。

---

## 11. 待定

- [ ] Loom 的最终命名
- [ ] Eval 的评分维度和权重
- [ ] Style anchor 用哪几篇
- [ ] Context 库跨文章共享的粒度
- [ ] Block 级语义 diff 的表示形式
- [ ] 图偏离度的具体度量方式（编辑距离？节点覆盖率？）
- [ ] 并行 branch（多角度探索）在图上怎么表达

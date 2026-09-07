# Loop engineering：定时、agent 循环、隐式图，在一个不常驻的桌面应用里

- **「loop engineering」现在是个模糊词**，它至少指三件基础设施完全不同的东西：**(A) 定时任务** / **(B) agent 循环** / **(C) 步骤之间的图**。这份文档先把三者分开回答，最后才说怎么合。
- **方法：一手来源。** macOS 的结论直接来自本机 `man` 页（macOS 15.7.9 / 24G830，检索日 2026-08-21）；Electron 与 Vercel AI SDK 的结论直接来自 `node_modules/` 里的 `.d.ts` 与 `src/`，标到行号；候选库的结论来自 `npm pack` 下来的实际发行包与 GitHub API 取回的真实数字，不引二手博客。
- **凡是我自己跑出来/读出来的，标 实测。凡是没人量过的，进 §9 单列，不用猜测填空。**
- 引用键：`[L…]` 本仓库源码与文档 / `[M…]` 本机实测 / `[E…]` 外部一手来源。见 [Sources](#sources)。

> **写作状态**：**§0–§9 全部定稿。** 少数几处仍标 `> TODO` 的是**未能核实的细节**，不是缺失的论证——**没有一处结论建立在它们之上**。所有未确认项另在 §9.2 集中列出。

---

## 0. 结论先行

**一句话：决策者要的几乎肯定是 (C)+(B)，而这个仓库的设计文档里早就写好了它，名字叫 Loom（`docs/workflow.md` §9）。三条最该记住的结论是——(B) 用已有的 `ai` 就够，实测停在审批点的 loop 只有 372 字节且可从文件续跑；(C) 的边必须**声明**而不是从数据依赖**推导**，因为 Bazel 靠沙箱、Nix 靠求值器保证「声明是真的」，这两样我们都没有；而最该先回答的问题不是「怎么画图」，是「上一次跑到一半，下一次到点了怎么办」——Windows 任务计划程序和 Temporal 各自独立地把默认定成了「跳过」。**

| 问题 | 结论 | 强度 |
| --- | --- | --- |
| 决策者说的「loop 的 node」是什么 | **`docs/workflow.md` §9.2 那张封闭节点表**（research/coverage/gate/draft/eval/revise/checks/publish/scan）。原型里已经画出来了，324 处 `loom` | 仓库内证据 `[L1][L2][L3]` |
| 这三种 loop 在设计文档里是不是已经分开了 | ✅ 已经分开且分得比问题本身更清楚：`trigger: cron` 是 (A)、`eval⇄revise` 回边是 (B)、Loom 图是 (C) | `[L1]` §9.5 / §6 / §9.3 |
| 代码里现在有多少 | **零。** 全仓 `setInterval` 计 0（除测试）；`blogstudio/src/` 里没有 loop / eval / graph / scheduler | **实测** `[M1]` |
| agent loop 要落地，最小的代码代价 | **`ModelClient` 端口必须改**——它现在只有 `complete` / `streamComplete`，没有 tool-calling | `[L4]` |
| 仓库已依赖的 AI SDK 够不够当 (B) | **循环本身够，durable 完全不够。** `stopWhen` / `timeout.totalMs` / `maxRetries` / 工具审批都在；**没有任何 checkpoint 或 resume** | **实测源码** `[M2]` |
| `generateText` 默认循环几步 | **1 步——默认根本不循环。** `stopWhen = isStepCount(1)` | **实测** `[M2]` `ai@7.0.64` |
| `ToolLoopAgent` 默认循环几步 | **20 步。** `stopWhen: … ?? isStepCount(20)` | **实测** `[M2]` |
| OpenAI Agents JS 默认几轮 | **10 轮。** `DEFAULT_MAX_TURNS = 10` | **实测** `[M3]` `@openai/agents-core@0.17.0` |
| LangGraph 默认递归上限 | **JS 是 25，Python 是 10007。** 同一个产品，差 400 倍，而且 Python 那个还能被环境变量改 | **实测** `[M4]` + `[E41]` |
| Anthropic 官方 `tool_runner` 默认几轮 | **无上限**（`max_iterations=None`），而且超限**不抛异常、静默退出** | `[E15][E16]` |
| 谁有 token / 花钱预算 | **只有 Pydantic-AI**（`request_limit` 默认 **50**，token 与 cost 上限默认全关） | `[E17]` |
| token 预算能不能拦住超额那一次 | **不能。** token 是后置检查——那次请求已经发了、已经计费了 | `[E17]` |
| 「跑到一半」能不能交出去 | **能，但只在审批点。** `ai` 的暂停态就是 `ModelMessage[]`，**实测 372 字节可往返、续跑不重放**。OpenAI Agents JS 是任意点都能（代价见下一行） | **实测** `[M14][M3]` |
| 代价：序列化一个半成品 agent loop | **你从此拥有一个会churn的格式。** OpenAI 的 `RunState` schema 已经迭代到 **1.19**，20 个版本全部还要支持 | **实测** `[M3]` |
| macOS 上「睡过去错过了」怎么办 | **两个 API 相反**：`StartCalendarInterval` 醒来补跑且**多次合并成一次**；`StartInterval` **直接丢** | **实测 man 页** `[M5]` |
| 「补跑还是跳过」有没有更好的问法 | **有，而且这是本文最该记住的一条。** Zotero 让这个问题消失了：真正的待办是「哪些还没做」这个**状态**，不是「错过了一次约会」 | `[E43]` |
| 同类桌面应用怎么选 | **obsidian-git 补跑**，理由是「不补 = 对只开一会儿的用户功能失效」——正是我们的读者 | `[E42]` |
| 「上一次还没跑完」的默认该是什么 | **跳过。** Windows 任务计划程序默认 `IgnoreNew`、Temporal 默认 `Skip`——两个毫无交集的系统同一个默认 | `[E8][E9]` |
| 「接着跑」属于哪一层 | **执行层，不是调度层。** Temporal 六个 overlap policy 里一个 resume 都没有——那是另一层的事 | `[E9]` |
| durable execution 该抄哪一支 | **记忆化，不是 replay。** replay 把代码变成 schema：**换两行顺序，在飞的 run 全部失败** | `[E27][E29]` |
| Temporal 的四个 activity 超时默认值 | **全是 ∞**，官方自己写「strongly recommend」你去设 Start-To-Close | `[E30]` |
| 步骤日志该先写还是后写 | **先写。** git 的 `done` 是「开始处理之前」就追加的——宁可漏做一步让人看见，也不要重复副作用 | `[E14]` |
| 续跑前还要检查什么 | **前置条件的指纹。** git 的 `amend` 文件存的是「世界还是不是我离开时那样」 | `[E14]` |
| 真实系统对「补跑」的默认选择 | **DBOS 默认不补**（`automaticBackfill ?? false`）；开了就**每个错过的时刻各补一次**（不合并），靠确定性 workflow id 去重 | **实测源码** `[M6]` |
| Electron 自己有没有调度 | **一个 API 都没有。** 43.4.0 的 `electron.d.ts` 全文无调度相关物 | **实测** `[M7]` |
| 该不该做可视化图编辑器 | **不做**（决策者已定）。查到的五个成熟系统里图全是**只读派生视图**；唯一的撤退案例（Jenkins Blue Ocean）正是从「编辑」退回「渲染」；连画布优先的 n8n 都承认 **"The Git repository acts as the source of truth"** | `[E49][E50]` |
| 「连成图」和「按输入跳过」是不是一件事 | **不是。** GitHub Actions 把图做全了、内容跳过**一点没做**——所以档 3 可以只做图 | `[E36][E37]` |
| 线性列表够不够 | ❌ **不够，但也别过度设计。** n8n 官方模板 799 个随机样本：**69.3% 非线性**，7–10 节点规模只剩 **35%** 线性（Loom 正好 9 个）；**但真正需要多分叉的只有约 1/3** | **实测** `[M15]` |
| 图里有环时该怎么办 | **硬报错，而且要把环整条打印出来**（Bazel 的做法）。别学 Make——它丢掉一条边、照跑、**退出码 0** | **实测** `[M12]` + `[E20]` |
| 缓存/跳过的 key 里该放什么 | **所有会影响输出的东西**——Bazel 连 `timeout` 都进 key，理由是「否则就是拿不该命中的缓存把 bug 藏起来」。对我们：模型、prompt、温度都得进 | `[E21]` |
| 本仓库能不能走完整的「数据依赖推导图」 | **能做但不值得。** Bazel 靠沙箱、Nix 靠求值器保证「声明是真的」，两条我们都没有；第三条路（Nx 的默认过度包含）让它变安全，却也让收益归零——**那就直接写成声明式的边** | `[E23][E25][E52]` |
| 「这一步能不能跳过」该按什么判 | **别按时间戳。** 实测复现出两类静默错误：同秒修改漏掉、mtime 倒退给出过期结果 | **实测** `[M12]` |
| 「一步消费什么」能不能让人手写 | **不能。** GNU Make 手册用一整节承认手写会漏，代价是静默的过期结果。**默认要多跑，不要少跑**——两类错误代价严重不对称 | `[E3][E52]` |
| 图作为什么是对的 | **作为视图，不作为约束。** Prefect：「Workflow graphs are great! **You don't need to define a DAG, though, to create a workflow graph.**」 | `[E47]` |
| 边该怎么写 | **别逐条画。** Turborepo 的 `^build` 是「跨越一张已有的图的规则」——对我们，那张已有的图是稿子的大纲 | `[E39]` |
| Loom 的边现在少了一样东西 | **边要分两种**：「先后」与「失效」。Make 用 order-only prerequisite 分了，§9.3 的图没分 | `[E5]` + `[L1]` |
| 「跑到一半」最小要存多少 | **两千字节。** git rebase 的完整中断态实测 **2110 bytes**，全是纯文本小文件 | **实测** `[M13]` |
| 停在审批点的 agent loop 能不能存成文件 | ✅ **372 字节的普通 JSON**，读回来续跑不重放、工具不重跑 | **实测** `[M14]` |
| 那份存档用两次会怎样 | **副作用发生两遍。** 幂等归外层——而外层能不能兑现，见下两行 | **实测** `[M14]` |
| Anthropic API 有没有 idempotency key | ❌ **没有。** 三条独立证据：Header 列表里没有、384 个文档页全量 grep 无命中、两个 SDK 的相关字段是**从未赋值的死代码** | `[E54]` |
| 而 SDK 默认还会自动重试 | **2 次**（408/409/429/≥500/连接错误），只带 `X-Stainless-Retry-Count`。**一次 429 重试就可能付两次钱，两边都不知道** | `[E54]` + **实测** `[M2]` |
| 那怎么办 | **先记意图、再执行**：调用前原子写 `.intent.json`，拿到结果写 `.json`。**只有 intent 没有结果 = 可能已经花过钱，摆给读者看，别静默重跑** | `[E55]` |
| 预设图 vs 执行图怎么存 | **一对此消彼长的文本列表**（`git-rebase-todo` / `done`），差就是偏离度 | **实测** `[M13]` |
| 该不该上 cron 表达式 | **不上。** DST 写在 `crontab(5)` 的 **BUGS** 底下；2015/2016/2019/**2026** 四次跨库复发；而最像我们的 Raycast 用的是时长不是表达式 | `[M8][E33][E34][E35]` |

---

## 1. 先把三件事分开

决策者说「类似 Codex 的已安排功能」+「loop 的 node」。这两个短语指向的东西不一样：

| | 是什么 | 基础设施 | 在本仓库里已有的名字 |
|---|---|---|---|
| **(A) 定时/周期任务** | 到点跑一次 | 触发器 + 「错过了怎么办」的语义 | `docs/workflow.md` §9.5 的 `trigger: "cron"` `[L1]` |
| **(B) agent 循环** | 模型调工具、看结果、再调 | 预算信封 + 停止条件 + 中间态 | §6「停止条件」、§4⑥ 的 `eval ⇄ revise` `[L1]` |
| **(C) 步骤之间的图** | 若干步骤连起来 | 边从哪来 + 崩溃恢复 | §9 Loom `[L1]` |

**它们不是一个「工作流引擎」。** 分开的理由很实在：(A) 可以单独做且几乎免费；(B) 已经有现成库；(C) 是唯一需要自己设计数据模型的那一件。把它们捆成一个词，最可能的结果是先做了最贵的 (C) 的 UI，而最便宜的 (A) 和最值钱的「崩溃恢复」一样都没有。

### 1.1 推断依据：决策者说的是 (C)，而且他已经看过图

不是猜的，仓库里有直接证据：

1. **`docs/workflow.md` §9.2「节点类型是封闭集合」** —— 九种节点，原话是「**新增节点类型 = 改这份文档，不是用户配置**。只要节点保持是领域词，它就永远是一个带调度的写作工具，而不是一个附赠博客功能的编排平台。」`[L1]`
2. **§9.3 已经写出了预设图的 JSON**（`.loom/researched-essay.loom`），九个节点、十条边，含一条回边 `n7 → n6`，guard 是 `score_improved && round < 3`。`[L1]`
3. **`public/blog-studio-prototype.html` 里已经把这张图画出来了**：`loom` 出现 324 次，`预设图` 8 次、`执行图` 7 次、`重构图` 1 次、`偏离度` 2 次；`loom_EDGE_LABEL` 里赫然写着 `"n7>n6": "回边 · 分数提升 且 round<3"`。**实测** `[M1][L3]`
4. **`docs/prototype-spec.md` §3** 定义了 Loom 抽屉的三种模式与侧栏四块。`[L2]`

所以「loop 的 node」= §9.2 那张表里的节点，**不是**「agent loop 里的一轮」。

**不确定的部分（明写）**：「类似 Codex 的已安排功能」这半句指向的是 (A)——一个能自己定时跑的东西。§9.5 已经把它归进 (C)（「定时任务不是另一套东西，就是一个 cron 触发的 loom」），但**决策者是不是同意这个归并，没有直接证据**。如果他真正想要的只是「每周自动扫一次源」，那 (C) 一整套都不必先做——见 §8 的档 1。

---

## 2. 定时任务：在一个不常驻的桌面应用里

### 2.1 真正的问题不是「补跑还是跳过」

原始问题是「应用没开的时候到点了怎么办」。但这一次的「一次任务」不是跑一个命令，而是**触发一张图、可能跑几分钟到几十分钟、中途可能因为关应用/睡眠/崩溃而停在半路**。所以问题要换成：

> **上一次跑到一半没跑完，下一次到点了该怎么办？**

**先说结论：这个问题被两个完全独立的系统认真做过，而它们给出了同一个默认值——跳过。**

| 语义 | 谁这么做 | 默认？ | 出处 |
|---|---|---|---|
| **跳过**（上一次没结束就不触发） | Windows 任务计划程序 `IgnoreNew`；Temporal Schedule `Skip` | ✅ **两家都是默认** | `[E8][E9]` |
| **排队**（等旧的跑完再跑） | Windows `Queue`；Temporal `BufferOne` / `BufferAll` | | `[E8][E9]` |
| **杀掉重来** | Windows `StopExisting`；Temporal 拆成 `CancelOther` / `TerminateOther` | | `[E8][E9]` |
| **并行**（不管） | Windows `Parallel`；Temporal `AllowAll`；Vixie cron 就是这个 | | `[E8][E9]` |
| **报错等人** | Temporal 的 `pause-on-failure`，**opt-in** | ❌ 默认不停 | `[E9]` |
| **接着跑**（resume） | **不在上面任何一个枚举里**——见 §2.1.2 | | |

**Windows 那条的原文**（XML schema 页的 Restricted Values，`IgnoreNew` 那行自带 "Default."）`[E8]`：

> - Parallel: Starts a new instance while an existing instance is running.
> - Queue: Starts a new instance of task after all other instances of the task are complete.
> - **IgnoreNew: Default.** Does not start a new instance if an existing instance of the task is running.
> - StopExisting: Stops an existing instance of the task before it starts a new instance.

**Temporal 那条的原文** `[E9]`，它对问题的陈述比问题本身还准：

> "The Overlap Policy controls what happens when it is time to start a Workflow Execution but a previously started Workflow Execution is still running."
>
> - "`Skip`: **Default.** Nothing happens; the Workflow Execution is not started."
> - "`BufferOne`: Starts the Workflow Execution as soon as the current one completes. The buffer is limited to one. If another Workflow Execution is supposed to start, but one is already in the buffer, **only the one in the buffer eventually starts**."
> - "`CancelOther`: Cancels the running Workflow Execution, and then starts the new one **after the old one completes cancellation**."
> - "`TerminateOther`: Terminates the running Workflow Execution and starts the new one **immediately**."

一个是 1990 年代末的桌面 OS 服务、装机量以十亿计，一个是 2020 年代的分布式 workflow 引擎，面向的人群毫无交集，**默认值一样**。这不像巧合，更像这个问题的正确答案：**不知道用户要什么的时候，不要开第二个。**

#### 2.1.1 三条可以直接抄的细节

**① `CancelOther` 和 `TerminateOther` 的区别对我们是要命的。** Windows 只有一个 `StopExisting`，Temporal 把它拆成了「礼貌取消、等旧的收尾完」和「直接杀、不等」。**如果我们的 run 在磁盘上留状态，那就只能是 cancel 语义**——terminate 会留下一个写到一半的 `steps/` 目录，而下一次启动分不清那是「跑到一半」还是「写坏了」。

**② `BufferOne` 的丢弃语义是对的：「最多欠一次」。** 缓冲区满了之后**后来的直接丢**。对周期任务这几乎总是对的——错过三次和错过一次，要补的东西是同一份。这和 launchd 的 coalesce（§2.2）是同一个判断。

**③ 「报错等人」要分清是谁干的。** Temporal 的 pause-on-failure 原文 `[E9]`：

> "If this policy is set, a Workflow Execution started by a Schedule that ends with a **failure or timeout (but not Cancellation or Termination)** causes the Schedule to automatically pause."

**只对「它自己坏了」生效，不对「人主动取消」生效。** 逻辑很干净：人自己干的事不需要再通知人一次。**对我们直接可用——读者退出应用导致的中断不是失败**，不该报错，不该停用调度，更不该下次启动弹一个红色的东西。

#### 2.1.2 最重要的一条：这些枚举里都没有「resume」

Temporal 六个值、Windows 四个值，**没有一个是「接着旧的往下跑」**。这不是遗漏，是**分层**：Temporal 的 workflow 本身就是可恢复的（event sourcing + replay），resume 是**执行层**的属性；调度层只决定「要不要 take an Action」。

**这个分层要抄。** 「上一次没跑完怎么办」实际上是两个独立问题：

- **(a) 调度层**：这次到点了，动不动手？（skip / buffer / cancel-then-start）
- **(b) 执行层**：动手之后，从零开始还是从磁盘上的断点接着来？

**把它们混进一个开关就是设计错误**——那会造出「跳过 + 从断点续」这种没人想要的组合，以及「重跑 + 但保留了上次的半成品」这种会静默出错的组合。

Windows 那一侧的反证也在：它的重试（`RestartOnFailure` / `RestartCount` / `RestartInterval`）**粒度是整个 task 重来**，不是从失败那一步续 `[E10]`。因为 Windows 的模型里一个 task 是一个不可分割的进程——**没有执行层，所以也就没有 resume 这个选项**。

#### 2.1.3 补跑窗口：两家的默认完全相反，而理由说得很清楚

| | 默认补跑吗 | 窗口 | 补跑延迟 |
|---|---|---|---|
| **Windows** `StartWhenAvailable` | ❌ **默认 `false`** | — | 开了之后**进队列延迟 10 分钟**才跑 |
| **Temporal** Catchup Window | ✅ | **默认一年**（最小 10 秒） | — |

Windows 的原文 `[E11]`：

> "If True, the property indicates that the Task Scheduler can start the task at any time after its scheduled time has passed. **The default is False.**"
>
> "Tasks that are started after the scheduled time has passed … are queued in the Task Scheduler service's queue of tasks and they are started after a delay. **The default delay is 10 minutes.**"

那 10 分钟不是随便定的：**开机/唤醒那一刻是系统最忙的时候**，一堆错过的任务同时冲进来会把机器压死。（注意别和 trigger 上的 `RandomDelay` 混淆，那个默认 `PT0M`、是用来打散整点惊群的，不是补跑逻辑。**「补跑那 10 分钟本身带不带随机抖动」没能确认。**）

Temporal 的原文 `[E9]`：

> "**The default is one year, meaning Actions will be taken unless over one year late.**　If your Actions are more time-sensitive, you can set the Catchup Window to a smaller value (**minimum ten seconds**)…"

**默认一年 = 实际上「永远补」。** 两家相反，但理由都成立：Temporal 假设你跑的是业务关键的东西，宁可迟到也不能不到；Windows 假设你跑的是碎片整理这类维护任务，**迟到一年的碎片整理毫无意义**。

**我们的场景更像 Windows。** 一个本地 pipeline 迟三个月才跑没有意义——读者早就手动跑过了，或者早就不关心了。

还有一条 UI 上的要求，Temporal 的排障文档把「没跑」分成了两类原因 `[E12]`：

> "the Action was either **skipped intentionally** (paused, overlap policy, end time reached) or the Temporal Service **could not take the Action** within the Catchup Window."

**这两类必须在界面上分得开**，否则读者只会看到「它没跑」然后来问你。

#### 2.1.4 卡住的 run 不能永远挡着后面

Windows 给了一个兜底 `[E13]`：

> "**By default, a task will be stopped 72 hours after it starts to run.**　You can change this by changing this setting."
>
> "A value of PT0S will enable the task to run indefinitely."

**这条对我们直接有用**：如果调度层的默认是「上一次还在跑就跳过」，那么一个卡死在某一步的 run 会**永久地**挡掉之后所有的触发，而现象是「它再也不跑了」，没有任何报错。必须有一个「超过多久就认定它死了」的兜底——Windows 选了 72 小时，具体数字我们要自己定（见 §9.2 未量过项）。

对照 §4.1：`ai` 的 `timeout.totalMs` 正是执行层的同一件事。**两层各要一个超时，不能只有一个。**

### 2.2 macOS：launchd 对同一个问题给了两个相反的答案（实测）

本机 `man 5 launchd.plist`（Darwin，man 页日期 30 July 2019；系统 macOS 15.7.9 / 24G830）`[M5]`：

**`StartCalendarInterval` —— 补跑，而且多次合并成一次：**

> "Unlike cron which skips job invocations when the computer is asleep, launchd will start the job the next time the computer wakes up. **If multiple intervals transpire before the computer is woken, those events will be coalesced into one event upon wake from sleep.**"

**`StartInterval` —— 直接丢，而且理由是实现限制：**

> "If the system is asleep during the time of the next scheduled interval firing, that interval will be missed **due to shortcomings in kqueue(3)**. **If the job is running during an interval firing, that interval firing will likewise be missed.**"

同一份 man 页还明说这两者互不知道：

> "Note that StartInterval and StartCalendarInterval are not aware of each other. They are evaluated completely independently by the system."

**这一对是整份调研里最有信息量的事实**：同一个系统、同一份文档，对「错过了怎么办」给了两个相反的答案，并且分别写明了理由（日历语义值得补、间隔语义补不起）。它直接支持 §8 的结论：**「按日历」和「每隔 N 小时」不是同一个功能，别用一套机制糊过去。**

顺带三条同样来自这份 man 页、对我们有用的：

- **`ThrottleInterval`**：默认 "jobs will not be spawned more than once every 10 seconds"。系统自己就带一个最小间隔。
- **`RunAtLoad`**：默认 false，且 "**This key should be avoided**, as speculative job launches have an adverse effect on system-boot and user-login scenarios."
- **`WatchPaths`**（靠文件变化触发）：">**Use of this key is highly discouraged**, as filesystem event monitoring is highly race-prone, and it is entirely possible for modifications to be missed."—— 「监听文件变化来触发」这条路，系统作者自己劝退。

### 2.3 macOS 上 cron 本身：官方说法是「已经被 launchd 吸收」

`man 1 crontab`（本机实测 `[M8]`）：

> "(Darwin note: Although cron(8) and crontab(5) are officially supported under Darwin, **their functionality has been absorbed into launchd(8)**, which provides a more flexible way of automatically executing commands.)"

`man 5 crontab` 里，DST 那段写在 **BUGS** 这个标题底下（不是 NOTES，不是 CAVEATS）：

> "If you are in one of the 70-odd countries that observe Daylight Savings Time, jobs scheduled during the rollback or advance will be affected. **In general, it is not a good idea to schedule jobs during this period.**"

`man 8 cron`：cron 由 launchd 在看到 `/etc/crontab` 或 `/usr/lib/cron/tabs` 时拉起，然后「每分钟醒一次，扫全部 crontab」。

#### 2.3.1 cron 表达式在本地应用里值不值得：**不值得**，而且证据不是「用户会配错」

**先说清楚：「用户配错 cron 的比例」没有公开数据，我没找到，不编。**

但配错率不是唯一的证据。有三类**可查证的一手证据**，指向同一个方向。

**证据一：没有一个真实系统能兑现 cron 字面上承诺的精确度。**

GitHub Actions 的 `schedule` 文档原文 `[E32]`：

> "The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs. **High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped.** To decrease the chance of delay, schedule your workflow to run at a different time of the hour."

**你给了用户一个能精确写「每天 0:00」的输入框，然后文档告诉他别写整点。** 这是表达能力和真实保证之间的落差，而用户不可能知道。同一页还有两条同样没人会读到的规则：公开仓库里「60 天无活动自动停用」，以及 **`@daily` / `@hourly` 这类写法根本不支持**。

Raycast 那边同样 `[E33]`：

> "the actual scheduling is not exact and might vary within a tolerance level. **macOS determines the best time for running the command in order to optimize energy consumption**, and scheduling times can also vary when running on battery."

**给用户一个能表达秒级精度的输入框，本身就是在撒谎。**

**证据二：DST 是持续十余年、跨库复发的真实故障源，而且我们控制不了。**

- `node-schedule` #267（2016）把六个重复 issue（#11 / #131 / #132 / #214 / #208）合并到一起，报告者原话 `[E34]`：「**This issue has caused downtime for us two years running now**」；根因是 `nextInvocationDate()` 里的 `while (true)`——「it will increment one minute at a time… `00:58:00`, `00:59:00`… but then jumps back to `00:00:00` because `01:00:00` does not exist on the night of daylight savings time」。同一条里还写着：修了好几个大版本，「I've just upgraded to `1.1.0` and it's **STILL** broken! Daylight savings time… the endless source of bugs :(」
- `node-schedule` #132（2015）：「Last night at exactly 3AM … **the CPU went to 100% and nothing worked anymore.**」`[E34]`
- `node-cron` #509（**2026-03**，今年）：DST 切换那一小时里日志无限刷、「**CPU usage spiked, causing cascading failures**」，3 点一到自己好了 `[E35]`。
- `node-cron` #174（2019）指出杀伤范围 `[E35]`：**即使用户选的目标时区不过 DST（比如 `Asia/Tokyo`），只要系统时区过 DST 就出错。** 桌面应用面对的是全世界的系统时区，**这个组合我们控制不了**。

**2015、2016、2019、2026，同样的 bug，不同的库。** 而当前维护良好的 `node-cron` 也只是在文档里把它讲清楚，而不是解决它——已合并的 PR #604 的做法是记录「fall-back 那一小时会跑一次、`*/15` 这类会暂停最多一个 DST 位移」，并建议用 `timezone: 'UTC'` 绕开 `[E35]`。

这与本机 man 页的态度一致：**DST 那段写在 `crontab(5)` 的 BUGS 标题底下**（§2.3），连 Temporal 都要专门写一句建议用 UTC `[E9]`。

**证据三：最接近我们形态的那个产品没有用 cron。** Raycast 的扩展 manifest 里写的是 `"interval": "10m"`——**一个时长，不是表达式**，最小 10 秒 `[E33]`。

**净结论**：给「每 N 小时 / 每天几点 / 每周几」三个下拉，**不上表达式**。读者要表达的东西这三个装得下；cron 换来的表达力对应的是运维场景，而代价是一类我们控制不了、且十年没被解决的故障。

### 2.4 真实系统的默认：DBOS 默认**不**补跑（实测源码）

`@dbos-inc/dbos-sdk@4.26.10`，`npm pack` 下来读的实际发行包 `[M6]`：

- **默认是跳过**：`automaticBackfill: options.options?.automaticBackfill ?? false`（`dist/src/dbos.js:1705`，`dist/src/client.js:506` 同）。
- **开了之后是「每个错过的时刻各补一次」，不合并**（`dist/src/scheduler/scheduler.js:252-277`）：

  ```js
  async function backfillSchedule(systemDatabase, serializer, name, start, end) {
    // …
    let current = start.getTime();
    while (current < end.getTime()) {
      const next = timeMatcher.nextWakeupTime(current);
      // …
      const workflowID = `sched-${name}-${next.toISOString()}`;
      await enqueueScheduledWorkflow(systemDatabase, serializer, sched, workflowID, next, context);
      current = next.getTime();
    }
  }
  ```

- **去重靠一个确定性的 id**：`sched-${name}-${next.toISOString()}`，然后 `initWorkflowStatus` 用它当主键。**「补跑」和「幂等」在这里是同一个机制**——不是先判断有没有跑过，而是让「跑过」这件事本身由 id 决定。
- 调度循环里还有一条工程细节：sleep 时加抖动，`maxJitter = Math.min(sleepTime / 10, 10000)`，注释写 "Apply jitter to prevent thundering herd"。

**和 launchd 正好相反**：launchd 把错过的多次**合并成一次**，DBOS 把错过的每一次**都补一遍**。两个都是认真做过的系统，选择相反，说明**这件事没有普适正确答案，必须按语义决定**：
- 「扫一遍源、入库」这种**幂等且只关心最新状态**的任务 → 合并成一次（launchd 语义）就对。
- 「为每个周期生成一份报告」这种**每个周期都有独立产物**的任务 → 每次都补（DBOS 语义）才对。

对本仓库的 `scan` 节点（`weekly-scan.loom`，「跑完往 context 库入料」`[L1]`）：**它是前者**，合并成一次是对的。

### 2.5 Electron 自己有什么：没有调度，但有睡眠信号（实测）

`node_modules/electron/electron.d.ts`，Electron **43.4.0** `[M7]`：

- **全文件搜 `cron` / `schedule`：没有任何调度 API。** 命中的只有 `scheduleFrame`（重绘）和纸张尺寸的 `Letter`。**Electron 不提供调度，这一档必须自己做或者交给系统。**
- `app.setLoginItemSettings(settings)`（`:1771`），`@platform darwin,win32`。文档原话：
  > "For more information about setting different services as login items on macOS 13 and up, see `SMAppService`."
- `Settings` 接口（`:23598+`）：
  - `openAtLogin` 默认 `false`；
  - `openAsHidden` 标了 **`@deprecated`**，且 "This setting is not available on MAS builds or **on macOS 13 and up**"——**「开机静默启动」这条路在新系统上已经没了**；
  - `type?: 'mainAppService' | 'agentService' | 'daemonService' | 'loginItemService'`，"Only available on macOS 13 and up"。**`agentService` / `daemonService` 就是通往 launchd 的口子。**
  - `path` / `args` 只在 win32 有。
- `powerMonitor` 有 `suspend`（"Emitted when system is suspending"）、`resume`（"Emitted when system is resuming"）、`shutdown`（linux/darwin，可 `preventDefault()` 延迟关机）、`user-did-become-active`、`lock-screen` / `unlock-screen`；还有 `getSystemIdleState(idleThreshold)` → `'active' | 'idle' | 'locked' | 'unknown'` 和 `getSystemIdleTime()`。

**净结论**：Electron 给的是**信号**（睡了、醒了、要关机了、人闲着），不是**调度**。所以「应用开着时的定时」只能自己写循环；而 `resume` 事件正是「醒来后检查一次该不该补跑」的挂点——这与 launchd 的 `StartCalendarInterval` 语义是同一个形状，只是要自己实现。

### 2.6 Raycast：唯一一个把这件事写进官方文档的同类产品

Raycast 是本次调研里**形态最接近我们的**——macOS 桌面应用，允许扩展声明周期性后台任务，而且**把规则写进了开发者文档** `[E33]`。它的每一条选择我们都该照抄或至少认真反驳。

| 它的选择 | 原文 / 依据 | 对我们 |
|---|---|---|
| **用时长不用 cron**：`"interval": "10m"`，最小 `10s` | "The interval specifies that the command should be launched in the background every X seconds (s), minutes (m), hours (h) or days (d)." | 照抄（§2.3.1） |
| **不承诺准时**，理由是省电与电池 | "the actual scheduling is not exact… macOS determines the best time… scheduling times can also vary when running on battery" | 照抄：**UI 上不显示「下次执行 14:30:00」** |
| **不允许重叠，靠超时保证** | "**To prevent overlapping background launches of the same command, commands are terminated after a timeout that is dynamically adjusted to the interval.**" | 见下 |
| **默认关闭** | "background refresh is initially _disabled_… **(This is to avoid automatically running commands in the background without the user being aware of it.)**" | 照抄，理由充分 |
| **后台出错不弹窗** | "users will also see a warning icon on the root search command and a tooltip with a hint to show the error" | 照抄：通知人，但不打断人 |
| **承认自己会留下半成品** | "Raycast auto-terminates the command if it exceeds its maximum execution time. **If your command saves some state that is shared with other commands, make sure to use defensive programming**… if the stored state is incomplete or inaccessible." | 见下 |

**「超时随周期动态调整」这一手很聪明**：它不需要判断「上一次跑完没有」，因为它**保证**上一次一定结束了——超时就杀。`interval` 越短，允许的执行时间越短。对照 Windows 那个固定 72 小时 `[E13]`，Raycast 让上限跟着周期走，更合理。

**但它也因此排除了我们的用法。** 一个跑几十分钟的 pipeline 在 Raycast 的模型里是非法的。**所以我们不能照抄「超时保证不重叠」，只能回到「上一次还在跑就跳过」+ 一个独立的死亡判定**（§8 档 1 那张表）。

**最后一条最诚实**：Raycast 在文档里直接承认它会在任意时刻杀掉你，你留在磁盘上的东西可能是半截的。**这和 git 的 `done`「先记后做」是同一类觉悟——半成品是常态，不是异常。**

**一条未能确认**：文档**没有正面回答**「机器睡着时会不会补跑」。有一条间接证据指向**不补**——它存并展示「上次运行时间」（`Extension Diagnostics` 里能看到每个命令上次何时跑的），但**通篇没提过「错过的运行」**。一个会补跑的系统需要向用户解释「为什么现在连跑了三次」；Raycast 不需要解释。**这是推断，不是文档。**

> **GitHub Actions `schedule` 的延迟与丢弃**见 §2.3.1 证据一。**job 默认超时（360 分钟）未核实。**

---

### 2.7 两个同类桌面应用，两条相反的路——而后一条更值得走

#### obsidian-git：**它补跑，而理由对我们完全成立**

`Vinzent03/obsidian-git` 是形态最接近我们的东西：一个装在用户机器上、随时被关掉的应用里的周期任务。它**选择补跑**，并把这件事写成产品承诺 `[E42]`：

> "**The interval works across Obsidian sessions to ensure opening Obsidian only for short times doesn't prevent running commit-and-sync.** For example, if you set a 15 minutes interval, you don't have to keep Obsidian open for 15 minutes. **If you close Obsidian before the interval end, the commit-and-sync will automatically run the next time you start Obsidian.**"

**理由是：不补跑，等于对「只开一会儿」的用户功能失效。** 这正是我们的读者。

实现只有十行（`src/automaticsManager.ts` 的 `diff()`）`[E42]`：

```ts
private diff(setting: number, lastAuto: Date) {
    if (isNaN(lastAuto.getTime())) return setting;   // 首次：不立刻跑
    const now = new Date();
    const diff = setting - Math.round((now.getTime() - lastAuto.getTime()) / 1000 / 60);
    return Math.max(0, diff);                         // 早就过了：立刻跑
}
```

**`Math.max(0, diff)` —— 补跑只补一次，没有 backlog 计数器。** 至此，**四个独立实现给出了同一个决定**：launchd 的 coalesce `[M5]`、Temporal 的 `BufferOne` `[E9]`、obsidian-git 的 `Math.max(0, …)`、以及我们自己的判断（§2.4）。

还有三条工程细节直接可抄 `[E42]`：

1. **last-run 时间戳存在 per-vault 的 `localStorage`，不是会同步的 `data.json`。** 因为配置会同步到别的设备，而**别的设备的时钟会污染本机调度**。→ **「上次什么时候跑的」是机器本地状态，不是可同步的配置。**
2. **改设置不触发补跑**（`reload()` 的注释明说不计算与上次的差值）。
3. **重叠在结构上不可能**：用一次性 `setTimeout`，在完成回调里才重新上闹钟；外加一个 FIFO 队列（手动命令与自动任务共用）。加上一条纯工程坑，该文件里出现三次：`if (time > 2147483647) time = 2147483647;`——**JS `setTimeout` 的 32 位上限约 24.8 天，超过会立即触发。** 「每月一次」这种间隔一不小心就踩到。

#### Zotero：**它让「补跑」这个问题根本不存在**——这是本节最该记住的一条

Zotero 同步没有「周期」这个概念。触发源有五个：数据变更（3 秒 debounce）、空闲一小时、从空闲回到活跃、启动时、以及服务端推送 `[E43]`。而对用户，官方文档只说一句话：

> "By default, Zotero will sync your local data with the Zotero servers **whenever changes are made**." "changes will be synced **within a few seconds** of being made."

**五个触发源全部藏起来了。** 这本身就是一条产品结论：**别把调度机制暴露给用户。**

但真正的关键在于「补跑」在它这里为什么不存在：`lastSyncTime` 确实存着（SQLite 的 `version` 表），但**全代码库唯一的消费者是渲染那个 tooltip**——**没有任何代码读它来决定要不要同步** `[E43]`。真正的待办是**数据库里 `synced = 0` 的那些行**。

> **「还没做」是一个状态，不是一个错过的约会。**

**这条直接改写了 §8 档 1 的形状。** 我们的 `scan` 节点要问的不是「上次是什么时候跑的、错过了几次」，而是——**「有哪些源还没扫过？」** 这个问题的答案在磁盘上，跟应用开没开、时钟准不准、错过了几次全都无关。

Zotero 的中断续跑也是同一个思路的延伸：它不存「当前第几步」，而是**用两个独立推进的版本号**（`libraryVersion` 与 `storageVersion`），不相等就说明后一阶段还欠着 `[E43]`。源码注释直接对着我们的问题写的：

> "even if Zotero is closed or interrupted between a data sync and a file sync, we know that file syncing has to be performed for any files marked for download during data sync"

**比存「当前步骤索引」高明**：崩在任何位置都自洽。

（顺带两个可抄的数字：重叠时它 skip 且**每条 skip 都有独立的 debug 日志**说明原因；失败对象的退避是一张手写的表 `[0.5, 1, 4, 16, 16, …, 64]` 小时——16 小时的意思是「明天这个时候再试」。）

#### 净结论：先问一个问题，再写代码

> **我们的 pipeline 能不能改写成幂等的「把状态推进到目标」，而不是「执行第 N 次任务」？**

如果能——而 `scan` **几乎肯定能**，因为入库本来就幂等（§6.2 ④）——那么：
- **错过触发不再是问题**（待办还在磁盘上）；
- **「上次没跑完」退化成纯并发问题**，skip 就够；
- **resume 也不需要专门实现。**

git rebase 和 Zotero 都是这么做的。**这个问题应该在写第一行代码之前问。**

## 3. 隐式图：边由什么决定

**决策者已定：不做可视化图编辑器。图存在于数据结构里，读者不画它。** 于是真正的问题变成——边从哪来。

两种可能：

- **(a) 声明顺序**：就是一个列表，前一步喂后一步。这是**线性流水线**，不是图。
- **(b) 数据依赖**：每一步声明自己**消费什么、产出什么**，边**从这两者推导出来**。这是一张真图，但没人画它。

Make 见 §3.2，Bazel 见 §3.3，Nix 见 §3.4，GitHub Actions 见 §3.5，Turborepo 见 §3.6，Nx 见 §3.7；实测数据见 §3.9，最小字段集见 §3.8。

### 3.1 已确认：编排型系统的边全是**画出来的**，不是推导的

| 系统 | 边怎么来 | 类别 |
|---|---|---|
| **Make** | 规则里写 `target: prereq`，图由名字对齐浮现 | **(b)**，但声明靠手写 `[E3]` |
| **Bazel** | 「某个属性值里出现了另一个 target 的 label」，扫属性得到 | **(b)** `[E19]` |
| **Nix** | `inputs` 字段必须显式列全，系统不扫 | **(b)**，声明由上层求值器生成 `[E25]` |
| **Turborepo** | `dependsOn: ["^build"]` —— 一条**跨越已有包依赖图的规则** | **(b) 的最省力形态** `[E39]` |
| **GitHub Actions** | `needs: [job1]`，job id 字符串 | **其实是 (a)**：见下 `[E36]` |
| **LangGraph** | 代码里显式 `addEdge` / `addConditionalEdges` | **(a)**：边是画的，不是推的 **实测** `[M4]` |
| **n8n** | `connections[源节点名][类型][输出序号] = [目标…]` | **(a)**：显式连线 **实测** `[M15]` |

**分水岭是 `outputs`，不是 `deps`。** GitHub Actions 有 `needs`，看着像 (b)，但**它的 `jobs.<id>.outputs` 是边上流动的数据，不是连边的依据**——边仍然是人手画的。所以严格说它是 (a) 的多分支变体，只是分支写成了依赖的样子。

**判据很简单：一个节点声明的「我产出什么」，有没有参与决定边？** Make / Bazel / Nix / Turborepo 是；GitHub Actions / LangGraph / n8n 不是。

**结论：编排类系统（LangGraph / n8n / GitHub Actions）的边全是画出来的；只有构建类系统（Make / Bazel / Nix / Turborepo）是推导的。** 而推导的那一档要么靠沙箱强制、要么靠求值器生成（§3.3 ⑤、§3.4）——**两样我们都没有**，所以本仓库落在编排类那一档：**边由声明给出**，就像 `docs/workflow.md` §9.3 现在写的那样。这不是退让，是和 LangGraph / n8n / GitHub Actions 同一档的选择。

### 3.2 Make：边是推导的，但「跳过」的判据弱得可以复现出错（本机实测）

Make 是 (b) 最老、部署最广的实现，也是最值得先看的，因为它的**跳过判据是时间戳**——而时间戳作为身份是有洞的。这一节的数字全部是在本机跑出来的 `[M12]`：**GNU Make 3.81**（macOS 15.7.9 自带的那一版）。

**① 循环依赖：Make 不报错，它把那条边丢掉然后照跑。**

```
$ cat Makefile
a: b
	@echo build a
b: a
	@echo build b

$ make a
make: Circular b <- a dependency dropped.
build b
build a
$ echo $?
0
```

**实测：退出码是 0。** 也就是说，一张有环的图交给 make，它会**静静地把环拆开、把两个目标都跑一遍、然后声称成功**。对一个小工具来说这是错的默认：环通常意味着图写错了，而「拆掉一条边继续跑」的结果是**跑出来的东西和你以为的图不是一回事，而且没有任何东西会拦你**。

**② 跳过的判据是时间戳，而且是整秒的。** 用一条最小规则测（`out.txt: in.txt`）：

| 操作 | Make 的反应 | 说明 |
|---|---|---|
| 首次 | 重建 | — |
| 什么都不改再跑 | `make: 'out.txt' is up to date.` | 正常 |
| **同一秒内 `touch in.txt`** | **`is up to date`——不重建** | ❗ 漏了 |
| 隔 1.1 秒后 `touch in.txt` | 重建 | 对照组 |
| **改内容，但把 mtime 调回 2020 年** | **`is up to date`——不重建，`out.txt` 里还是旧内容** | ❗ 静默给出过期结果 |

第三行的解释：实测两个文件的 mtime 分别是 `1787284964.419244000` 和 `1787284964.443832582`——**文件系统记着纳秒，Make 3.81 只比到秒**，所以同一秒内的修改对它不存在。

**这两行 ❗ 是这一整节的重点**：(b) 的跳过判据如果是时间戳，就存在**两类静默错误**——改得太快（同秒）和 mtime 倒退（拷贝、解压、`git checkout`、从备份恢复都会造成）。错误的形式不是报错，是**用旧结果继续往下跑**。

（GNU Make 4.x 支持高精度时间戳，本机没有，**没验证过就不算数**。这条差异会影响上表第三行，不影响第五行。）

**③ 边推导得出来，但要靠一个额外机制补齐。** Make 的边是显式写在规则里的（`out.txt: in.txt`），严格说是 (a) 和 (b) 之间：依赖是**声明**的，但**声明的是数据依赖**，图由这些声明推导。问题在于**声明容易漏**——手册自己在「Generating Prerequisites Automatically」一节里说 `[E3]`：

> "In the makefile for a program, many of the rules you need to write often say only that some object file depends on some header file."
> …
> "for a large program you would have to write dozens of such rules in your makefile. And, **you must always be very careful to update the makefile every time you add or remove an `#include`**."

于是有了 `-M` / `-MM`：**让编译器扫源码、自动生成依赖**，一个源文件一个 `.d`。

**这条对我们的直接推论**：如果本仓库走 (b)，**「一步声明自己消费什么」这件事绝不能靠人手写维护**——手册用一整节承认了手写会漏，而漏的后果是静默的过期结果。要么让边从代码里推出来，要么根本别走 (b)。

**④ 手册与源码印证：丢边是有意的设计，不是 bug。** 手册 Errors 附录对这条消息的解释是 `[E4]`：

> `Circular xxx <- yyy dependency dropped.`
> "This means that `make` detected a loop in the dependency graph: after tracing the prerequisite *yyy* of target *xxx*, and its prerequisites, etc., one of them depended on *xxx* again."

措辞就是 **dropped**。源码（`src/remake.c`，GNU Make 4.4.1）用的是 `error()` 而不是 `fatal()`——前者只往 stderr 写一行就返回，**不设失败状态、不退出**——然后真的把那条依赖从 `file->deps` 链表里 unlink 掉，继续构建 `[E4]`。3.81 上实测到的行为和 4.4.1 的实现一致。

**⑤ 但 Make 有两个设计值得直接抄。**

**其一：它有两种边。** §4.3「Types of Prerequisites」`[E5]`：

> "A normal prerequisite makes two statements: first, it imposes an order in which recipes will be invoked… Second, it imposes a dependency relationship: if any prerequisite is newer than the target, then the target is considered out-of-date and must be rebuilt."
>
> "Occasionally you may want to ensure that a prerequisite is built before a target, but *without* forcing the target to be updated if the prerequisite is updated. **Order-only** prerequisites are used to create this type of relationship."
>
> "**Order-only prerequisites are never checked when determining if the target is out of date**; even order-only prerequisites marked as phony will not cause the target to be rebuilt."

写法是 `targets : normal-prereqs | order-only-prereqs`。

**这条对 Loom 直接适用**：`docs/workflow.md` §9.3 的边现在只有一种 `[L1]`。但那张图里的边其实是两类——`n3(gate) → n4(draft)` 是**「先后」**（人批了才能写），而 `n4(draft) → n6(eval)` 是**「失效」**（draft 变了，eval 结果就不算数了）。**把这两类混成一种边，迟早会出现「人重新批了一次 gate，结果整篇文章重写」这种事。** 这是一条现在就该记下的建模决定。

**其二：`.PHONY` 是必备的逃生口。** §4.6 `[E6]`：

> "If you write a rule whose recipe will not create the target file, the recipe will be executed every time the target comes up for remaking."
>
> "…`clean` would always be considered up to date and its recipe would not be executed. To avoid this problem you can explicitly declare the target to be phony…"

**任何 (b) 系统都需要承认「有些步骤没有可比较的产物」**，并把它标成永远重跑。对我们，`gate`（等人）和 `checks`（确定性检查，「随时是新的、不花钱」`[L17]`）就是这一类。

**⑥ 一个漂亮的递归：依赖图自己是自己的产物。** §4.14 推荐的做法是「一个源文件一个 `.d`」，而 `.d` 本身也是一个 target、也参与失效判定 `[E3]`：

> "The practice we recommend for automatic prerequisite generation is to have one makefile corresponding to each source file. For each source file `name.c` there is a makefile `name.d` which lists what files the object file `name.o` depends on."

也就是说：**边不是人写的，是「跑一遍工具、把它吐出来的依赖记下来」得到的**，而这个「记下来」本身也是一个步骤。

**⑦ `make -p` 是只读文本 dump。** §9.7 `[E7]`：

> "`-p`, `--print-data-base`　Print the data base (rules and variable values) that results from reading the makefiles…"

它是「读完 makefile 之后的结果」，是派生物。**Make 从来没有提供过图形化编辑依赖图的东西**——这是 §3.10 那个问题的第一个数据点。

**⑧ 净判断**：Make 的经验对我们是——
- 循环：**要硬报错，不要学 make 丢边**（它丢边是为了让老 Makefile 还能跑，不是因为这样对）。
- 跳过判据：**别用时间戳**。要么按内容哈希，要么干脆记「这一步做完了没有」（一个 done 文件，§7.1），后者对我们够用且没有那两类洞。
- 依赖声明：**别让人手写**。
- **边要分两种**（先后 / 失效），从第一天就分。
- **要有 `.PHONY` 那样的「永远重跑」标记。**

---

### 3.3 Bazel：人给名字，机器给哈希——两级身份

Bazel 把 (b) 说得最清楚。它的 query 手册开篇就定义了什么叫「隐式的图」`[E18]`：

> "Bazel query language expressions operate over the build dependency graph, **which is the graph implicitly defined by all rule declarations in all BUILD files.**"

而「边」的定义是**从属性里扫出来的**，不是一条单独的记录 `[E19]`：

> "**Dependency**: A directed edge between two targets. A target `//:foo` has a target dependency on target `//:bar` if **`//:foo`'s attribute values contain a reference to `//:bar`**."

**① 环是硬错误，而且报得很好看。** query 手册说配置后的图里有环会被 `cquery` / `aquery` 报成错误；源码里用的是 `Event.error`，**analysis phase 失败，什么都不构建** `[E20]`。官方测试断言的完整格式：

```
in cc_library rule //a:rule1: cycle in dependency graph:
.-> //a:rule1 (<configuration-hash>)
|   //b:rule2 (<configuration-hash>)
`-- //a:rule1 (<configuration-hash>)
```

**和 Make 的 drop-the-edge 是两个极端，而 Bazel 这一端才是对的**：它不但报错，还**把环整条打印出来**。这是我们该抄的形态——报「有环」没用，要报「环是哪几个节点」。

**② 两级身份：人给的是名字，机器用的是哈希。** 这是 Bazel 相对 Make 最重要的结构差别 `[E19]`：

| | 人写的 | 机器判定用的 |
|---|---|---|
| 单位 | **Target**，身份是 label（`@repo//pkg:name`） | **Action**，身份是**它自己的内容哈希** |
| 用途 | 写依赖、写命令行、报错时给人看 | 判定跳过 |

**没有人给 action 起名字。** 人永远不直接写 action——action graph 完全从 target graph 推导出来。

**③ action key 里装什么：所有会影响输出的东西。** 远程执行 API 的 proto 是这条规则的规范文本 `[E21]`：`Action` = `(command_digest, input_root_digest, timeout, platform, salt)` 的 digest；`Command` = `(arguments, environment_variables, output_paths, working_directory, platform)`。**输入是靠内容 digest 进 key 的，mtime 不在里面。**

其中 `timeout` 那条注释把设计原则说透了 `[E21]`：

> "**The timeout is a part of the `Action` message, and therefore two `Action`s with different timeouts are different, even if they are otherwise identical.** This is because, if they were not, running an `Action` with a lower timeout than is required might result in a cache hit from an execution run with a longer timeout, **hiding the fact that the timeout is too short**."

**「凡是会影响输出的东西都必须进 key，否则就是拿一个不该命中的缓存把 bug 藏起来。」** 这是设计缓存 key 的第一性原则，而且它正好点名了我们会踩的那个坑——**换了模型、换了 prompt、换了温度，都必须进 key**，否则「我明明换了模型，结果一个字没变」。

**④ 内容哈希的代价，Bazel 自己列了。** 已知漏洞原文 `[E22]`：

> "**Bazel does not track tools outside a workspace.** … if, for example, an action uses a compiler from `/usr/bin/`. Then, two users with different compilers installed **will wrongly share cache hits because the outputs are different but they have the same action hash**."

对我们的对应物就是**云端模型**：同一个 prompt、同一份输入，服务端换了个版本，我们的 key 一个字没变。**这条没法根治，只能承认**——所以 §8 里那些「跳过」的档次必须能一键失效重跑。

**⑤ 沙箱不是安全特性，是依赖声明的强制执行机制。** 这是整份调研里最该记住的一句 `[E23]`：

> "**Without action sandboxing, Bazel doesn't know if a tool uses undeclared input files** (files that are not explicitly listed in the dependencies of an action). When one of the undeclared input files changes, Bazel still believes that the build is up-to-date and won't rebuild the action. **This can result in an incorrect incremental build.**"

**(b) 只在「声明是真的」这个前提下才正确。** 沙箱把「漏声明」从**静默的错误结果**变成**当场报错找不到文件**。

**这一条直接决定本仓库该不该走 (b)**：我们不可能给每个节点上沙箱——节点要读整个 library 目录、要调云端模型。也就是说**我们没有办法强制「声明是真的」**。这是 §8 结论里反对完整 (b) 的最硬的一条理由。

**⑥ 必须有 `--explain`。** Bazel 有一个选项专门回答「这一步为什么跑了 / 为什么跳过了」`[E24]`：

> "…causes the dependency checker in `bazel build`'s execution phase to **explain, for each build step, either why it is being executed, or that it is up-to-date.**"

**(b) 的行为对人是不透明的**，不给这个出口，用户唯一的办法就是删缓存。真做 (b)，这一件必做。

**⑦ `bazel query --output=graph` 是只读的。** 它只是 query 的一种输出格式，和 `--output label` / `--output xml` 并列，**没有任何回写路径** `[E18]`。§3.10 的第二个数据点。

### 3.4 Nix：把 (b) 推到底——「该不该跑」退化成「这个路径在不在」

Nix 是三者里最彻底的：**产物的名字就是它输入的哈希**，所以根本没有「跳过判定」这一步 `[E25]`。

store path 的构成是规范化的：`store-dir "/" digest "-" name`，其中 digest 是 `fingerprint` 的 SHA-256；对 input-addressed 的输出，`inner-fingerprint` 是「the ATerm serialization of the derivation」——**即整个构建配方的序列化** `[E26]`。手册的另一句更直白：

> "**Each output path is a concatenation of the cryptographic hash of all build inputs, the `name` attribute and the output name.**"

于是「这一步该不该跑」= 「这个路径在不在 store 里」。**没有比较，没有判据，只有存在性。**

**而它对「声明」的态度是最硬的一句** `[E25]`：

> "**But rather than somehow scanning all the other fields for inputs, Nix requires that all inputs be explicitly collected in the `inputs` field.** It is instead the responsibility of the creator of a derivation (e.g. the evaluator) to ensure that every store object referenced in another field … is included in this `inputs` field."

**「用到」和「声明」是两件事，系统不去猜，只认声明。** 而「保证声明是全的」这个责任被推给了上层的求值器。

**Bazel 和 Nix 是同一个问题的两种答法**：
- Bazel 用**沙箱强制**——漏了就跑不起来。
- Nix 用**求值器生成**——声明不是人写的，是上层算出来的。

**两条我们都用不上**：我们没有沙箱（⑤），也没有一个能算出「这一步要读哪些 context」的求值器——**因为那正是 `research` / `recall` 节点要用模型去决定的事**。这是 §8 反对完整 (b) 的第二条硬理由。

### 3.5 GitHub Actions：**有图，但完全没有「跳过」**——这两件事可以分开做

这是对我们最有用的一个样本，因为它证明了一件事：**「把步骤连成图」和「按输入跳过步骤」是两个可以独立决定的功能。** GHA 把前者做全了，后者**一点都没做**。

**边的声明是 job id，一个字符串** `[E36]`：

```yaml
jobs:
  job1:
  job2:
    needs: job1
  job3:
    needs: [job1, job2]
```

**而边默认携带「上游必须成功」的语义**，这是个好默认 `[E36]`：

> "**If a job fails or is skipped, all jobs that need it are skipped** unless the jobs use a conditional expression that causes the job to continue. If a run contains a series of jobs that need each other, **a failure or skip applies to all jobs in the dependency chain from the point of failure or skip onwards.**"

写 `if: always()` / `if: !cancelled()` 就是在**覆盖**这个默认。**对 Loom 直接适用**：`eval` 失败之后 `revise` 不该跑，这应该是默认行为，而不是要在每条边上写条件。

**但「这个 job 能不能跳过」完全不看输入内容** `[E37]`：

- job 的跳过**只**由 `if` 表达式和上游 job 的 result 决定，`if` 是对事件与变量求值，**不看任何文件内容**。
- 缓存（`actions/cache`）是**你自己加的一个 step**，`key` 是**你自己手写的字符串表达式**（惯例的 `hashFiles('**/package-lock.json')` 也是你自己写的——系统不会自动知道这个 job 消费了哪些文件）。
- **而且命中缓存也照样跑 job**：文档明说「a job should always be able to re-download or regenerate these files if a cache isn't available」。缓存只让 job 内部某个 step 更快，**job 本身一定被调度、一定执行**。

**结论（措辞谨慎）：在 GitHub Actions 官方文档里，找不到任何基于 job 输入内容自动跳过 job 的机制。**

**这对 §8 的分档是决定性的**：既然全世界跑得最多的 CI 系统都只做了图、没做内容跳过，那么**档 3 完全可以只做图、不做跳过**。而「明确不做」第 6/7/8 条（不推导边、不用时间戳、不用内容哈希）因此不是缺陷，是和 GHA 同一档的选择。

**身份单位是 YAML 里的那个 key**，没有哈希、没有版本。改一个 job id，所有引用它的 `needs` 立刻报 `depends on unknown job 'xxx'` `[E36]`。**Loom 的 `node_id` 也是这个形状**（`docs/workflow.md` §9.3 的 `n1`…`n9`，执行图实例靠 `node_id` 指回预设图 `[L1]`）——一致，不用改。

**它的图是四个系统里唯一「默认就画给你看」的**，而且是运行时的、带状态图标的 `[E38]`：

> "**Every workflow run generates a real-time graph that illustrates the run progress.**… The graph displays each job in the workflow. An icon to the left of the job name indicates the status of the job. **Lines between jobs indicate dependencies.** To view a job's log, click the job."

**但它仍然是只读的**——唯一的交互是「点一个 job 看它的日志」，边来自 YAML 的 `needs`，图上没有任何编辑入口。**这恰好就是 `docs/prototype-spec.md` §3 描述的 Loom 抽屉**（执行图、状态着色、点节点看详情）`[L2]`——**形态已经对了。**

### 3.6 Turborepo：**别逐条画边，写一条跨越已有图的规则**

这是本节最有用的一个结构性发现。Turborepo 的 `dependsOn` 有三种写法 `[E39]`：

```jsonc
{ "tasks": {
    "build": { "dependsOn": ["^build"] },      // 依赖包里的同名 task
    "test":  { "dependsOn": ["build"] },        // 同一个包里的另一个 task
    "lint":  { "dependsOn": ["utils#build"] }   // 指名道姓
} }
```

`^` 的含义是「**先在直接依赖里跑这个 task**」`[E39]`：

> "The `^` microsyntax tells Turborepo to run the task in direct dependencies before the target package."

**关键在于：`^build` 不是一条边，是一条边的生成规则。** 真正的边是「`^`（走 `package.json` 的依赖图）× `build`（task 名）」在每个具体 package 上展开的结果。也就是说——

> **task graph = (包依赖图，包管理器已经维护着) × (task 之间的关系，你写的那几行)**

**人只写了后者。** 这才是 (b) 在这里真正省力的原因：**它没有让你逐条画边，而是让你写一条跨越一张已有的图的规则。**

**这一条对 Loom 有直接对应物。** `docs/workflow.md` §9.4 里那个重构例子已经在做类似的事——新增一个 `revise` 节点带 `scope: ["b8", "b9"]` `[L1]`。把它说成 Turborepo 的形状就是：

> **run graph =（稿子的大纲/断言结构）×（Loom 的 9 个节点关系）**

「对 eval 标记出来的每一节各跑一次 revise」是一条**规则**，不是九条手画的边。**如果档 3 要做，这是比「逐条列 edges」更值得先试的形状**——因为大纲那张图本来就存在（`blogstudio/src/outline.ts` 从正文现算 `[L18]`），不用我们维护。

**环报错的形态也值得抄** `[E40]`：Turborepo 不只说「有环」，还告诉你**剪哪条边能解开**——

```rust
#[error("Cyclic dependency detected:\n{cycle_lines}")]
CyclicDependencies { cycle_lines: String },
#[error("{0} depends on itself")]
SelfDependency(String),
```

提示文本里写着「The cycle can be broken by removing any of these sets of dependencies:」，并把候选切边列出来。**比 Bazel 只打印环又进了一步**——这是「明确不做」里那条「环要硬报错」应该长的样子。

### 3.7 Nx：对付「漏声明」的第三条路——**默认过度包含**

§3.3 ⑤ 和 §3.4 说 (b) 的正确性依赖「声明是真的」，而 Bazel 靠沙箱强制、Nix 靠求值器生成，两条我们都没有。**但还有第三条路，而且它是成本最低的那条。**

Nx 的做法是**默认把所有东西都算作输入**，`inputs` 只是一个用来**缩小**范围的可选优化。官方文档原话 `[E52]`：

> 默认全包「may cause Nx to rerun some tasks even when files irrelevant to the task have changed **but it ensures that by default, Nx always re-runs the task when it should**」

**这句话的骨架是一个不对称代价的判断：**

| 错法 | 后果 |
|---|---|
| 多跑了不该跑的 | 慢一点、多花点钱 |
| **少跑了该跑的** | **静默的过期结果**——就是 §3.2 在 Make 上实测复现的那两类错误 |

**两类错误的代价严重不对称，所以默认必须偏向多跑。** 这对我们尤其成立：一次多跑的代价是几次模型调用，而一次少跑的代价是「读者拿到一篇建立在旧材料上的稿子，而且没有任何东西提示他」。

Nx 还把 (a)→(b) 的论证浓缩成一句 `[E52]`：手写一张依赖列表「**would duplicate information already available in the project graph and would need updates whenever project dependencies changed**」——**这正是 §3.6 那个「跨越已有的图写规则」的另一种说法。**

**Nx 也是唯一两种环策略都实现了的对照样本** `[E52]`：默认 `process.exit(1)` 并打印 `a --> b --> a`；设 `NX_IGNORE_CYCLES=true` 则降级成 warn 并调 `makeAcyclic()`——而 `makeAcyclic` 的实现是 `deps.splice(idx, 1)`，**和 GNU Make 的 `remake.c` 是同一个动作**（§3.2 ④）。**所以「硬报错」应当是默认，「丢边继续」可以留成一个显式开关，但不能是默认。**

### 3.8 如果真要做，最小字段集长什么样

把 §3.2–§3.7 收敛成一张表。这是**档 3 真要落地时**每个节点最少要声明的东西：

| 字段 | 干什么 | 先例 |
|---|---|---|
| `id` | 身份。人给的名字，不是哈希 | Bazel 的 label / GHA 的 job id `[E19][E36]` |
| `inputs` | 消费什么。**可选，只用来缩小范围** | Nx 的默认全包 `[E52]` |
| `outputs` | 产出什么。**这一项才是 (b) 的分水岭** | Make / Bazel / Nix `[E3][E19][E25]` |
| `run` | 怎么跑。**必须进 key** | Make 不这么做，是它最出名的坑 `[E21]` |
| `always` | 永远重跑，没有可比较的产物 | Make 的 `.PHONY` `[E6]` |
| `after` | **只管先后，不管失效** | Make 的 order-only `|` `[E5]` |

**对我们，`always` 那一格立刻就有人住**：`gate`（等人）、`checks`（不花钱、随时是新的 `[L17]`），以及**所有调模型的节点**——把它们标成不可缓存，比假装它们是确定性的要诚实。

**还有一件必须当一等公民做的：`--explain`。** Bazel 有 `[E24]`，Nx 的图视图存在的理由是「It always stays up to date **without having to actively maintain a document**」`[E52]`。**(b) 的行为对人不透明**，不给这个出口，读者唯一的办法是删掉整个 run 重来。**它不是 debug 开关，它是这个功能的一部分。**

### 3.9 线性够不够？实测：**7 成不是线性的，而且线性只在小图上成立**

这是本文唯一一个我们自己跑出来的外部统计，也是「要不要图」这个问题上唯一有数字的一条 `[M15]`。

**方法**：n8n 官方模板 API（公开、无鉴权）共 **11,629** 个模板，用固定 seed（20260821）随机抽 **800** 个，实际成功拉到 **799** 个（1 个 404）。排除 `stickyNote`（便签不是节点）。主口径只统计 `main` 数据流连接——AI 子节点那类「挂件」连接（`ai_languageModel` / `ai_tool` / `ai_memory`）被**故意排除**，所以下面的非线性比例是**下界**。测量日 2026-08-21。

节点数分布：mean 15.0，median 12，p90 27，max 154。

| 形态 | 占比 |
|---|---:|
| **纯线性链**（每个节点入度 ≤1、出度 ≤1，无环） | **30.7%** |
| **非线性**（有分支 / 汇聚 / 回边任一） | **69.3%** |
| 有分支（扇出 >1 或多个 output index 被占） | 65.8% |
| 有汇聚（某节点被 >1 个不同来源指向） | 50.3% |
| **有回边（循环）** | **23.5%** |

控制流节点的出现率：`if` 44.2%、`switch` 14.1%、`merge` 17.6%、`splitInBatches`（Loop Over Items）17.1%、`filter` 10.0%；**任一 68.6%**。

**但 69.3% 这个数字会误导人，所以必须配上分支密度这张表**——「有一个 `if`」和「真的是一张图」是两回事：

| 分支点个数 | 占比 |
|---:|---:|
| 0 | 34.2% |
| 1 | 32.9% |
| **≥2** | **33.0%**（其中 ≥3 占 17.0%） |

单节点最大扇出的中位数是 2、最大 15；22.9% 的工作流里存在扇出 ≥3 的节点。

**所以诚实的读法是两句话，不是一句：**
- 「n8n 用户只是在画线性链」**是错的**——纯线性只有 30.7%。
- 「每个人都在画复杂的图」**同样是错的**——**真正需要多分叉结构的约 1/3。**

**这直接影响档 3 的形状**：需要「边」和「回边」是主流；需要「一个节点扇出到三个地方再汇合」是少数。**先把前者做对，别为后者提前设计。**

**另一个更有用的切面是它随规模的变化：**

| 节点规模 | 样本数 | 纯线性占比 |
|---|---:|---:|
| 1–3 | 40 | **100%** |
| 4–6 | 105 | 73% |
| 7–10 | 190 | 35% |
| 11–20 | 302 | 19% |
| 21+ | 162 | **4%** |

**线性率随规模单调坍塌。** 三个节点以内，线性一定够；超过十个，线性几乎一定不够。

**这对 Loom 意味着什么：`docs/workflow.md` §9.3 的预设图正好是 9 个节点** `[L1]`——落在 7–10 这一档，实测线性率 **35%**。而那张图本身就有一条回边（`n7 → n6`，guard `score_improved && round < 3`）和两条条件边。**换句话说：这份设计不是「为了图而图」，它落在一个统计上确实需要图的规模区间里。**

**三条必须写明的边界：**
1. **样本有偏。** n8n 官方模板库里的东西是**别人愿意分享出来的**工作流，天然偏向「做了点有意思的事」。真实私有工作流的线性率**没有公开数据**。
2. **这是 n8n 的数据，不是写作流水线的数据。** 一个 ETL / 自动化工具的形态分布，未必迁移到「研究→写→评→改」。**我们自己的 Loom 会不会真的用上分支，没人量过**（§9.2）。
3. **两个复现坑**（留给以后重跑的人）：分页参数是 **`skip`** 不是 `page`——传 `page` 会被静默忽略、永远返回同一批 100 条，不检查就会以为全库只有 100 个；真正的图在**内层** `workflow.workflow.{nodes,connections}`。

**顺带测了 Dify，但结论要打折**：三个 GitHub 仓库共 154 个有效 YAML，linear 62.3%、branch 37.7%、**cycle 0.0%**。**那个 0% 是表示法造成的假象**——Dify 用 `iteration` / `loop` **容器节点**表达循环，不用回边，所以回边检测必然为 0；真实的循环占比要看 `iteration` 的 **16.9%**，与 n8n 的 `splitInBatches` 17.1% 几乎一样。而且这是**社区精选的 demo**，与 n8n 的官方全库随机样本**不可直接比较**，「Dify 用户更少用图」这个读法不成立。唯一稳健的共同点是规模趋势：Dify 在 21+ 节点时线性率也只剩 10%。`[M16]`

**净判断**：这个数字**不足以证明我们需要一张可编辑的图**，但足以否掉一个具体的偷懒方案——**「就做个线性列表，反正够用」在 9 个节点的规模上是站不住的**。

### 3.10 图作为图片：查到的每一个都是只读派生视图

| 系统 | 有没有「看图」的口子 | 可编辑吗 |
|---|---|---|
| **GNU Make** | `make -p` 打印读完 makefile 后的 data base | ❌ 纯文本 dump，唯一输入仍是 makefile `[E7]` |
| **Bazel** | `bazel query --output=graph` 出 GraphViz | ❌ 只是 query 的一种输出格式，与 `--output label` / `--output xml` 并列，**无回写路径** `[E18]` |
| **LangGraph** | LangGraph Studio 可视化 | ❌ 图由 `addEdge` 等代码定义，可视层是派生的 **实测** `[M4]` |
| **GitHub Actions** | **默认就画**，运行时实时图、带状态图标 | ❌ 唯一交互是「点 job 看日志」，边来自 YAML 的 `needs` `[E38]` |

| **Nx** | `nx graph`，可交互 | ❌ 交互项全是 focus / search / hide / trace；文档给的理由是「It always stays up to date **without having to actively maintain a document**」`[E52]` |

**四个里没有一个反例。** 成熟的 (b) 系统里，**图从来不是输入**——它是「把已经写好的东西换个方式打印」。

#### 3.10.1 有没有人做了可编辑的画布、后来退回去？**有一个，而且只有一个**

必须先纠三个偏，否则很容易把这一节写成一篇有倾向的稿子：

- **Prefect / Airflow / Temporal 不是撤退案例。** 它们的 "DAG" 指的是运行前必须声明的静态图**数据结构**，**不是画布**——**Airflow 从来没有 ship 过官方可视化编辑器**，PMC 明说这是 "conscious choice"、"Airflow UI is for monitoring, not for DAG writing" `[E47]`。把它们算作「从可视化撤退」是错的。
- **没有一篇叫「The DAG is dead」的 Prefect 官方文章**——那是社区转述。**未能确认**；真实存在的是 2021-10-05《Our Second-Generation Workflow Engine》与 2023-08-07《You Probably Don't Need a DAG》`[E47]`。
- **「Deutsch limit」是民间传说，不能当论据。** 引用链追到底是 1997 年 comp.lang.visual FAQ 里一句自认转述的 "Deutsch said something like…"，而**同一页纸上紧跟着就是反驳**；维基百科自己把它归进 `Category:Computer programming folklore` `[E48]`。可以当修辞，不能当证据。

**真正的撤退案例是 Jenkins Blue Ocean 的 Pipeline Editor** `[E49]`：插件页挂着正式的 **Deprecated** banner，官方推荐的替代品全部是**只读渲染**（Stage View / Graph View）加一个语法片段生成器。**即：从可视化「编辑」退回到对权威 `Jenkinsfile` 的可视化「渲染」。**

**另外两条一手表态值得单独记：**

**① n8n 官方承认画布不是真相来源。** 这一条最有分量，因为 n8n 本身就是画布优先的产品 `[E50]`：

> "**n8n can't detect conflicts on workflows.**" "**The Git repository acts as the source of truth.**" "**you shouldn't view n8n's source control as full version control**"（且不支持 pull-request 式的评审与合并）

**② Retool 是反例，必须写进来。** 它的选择是让序列化格式更可 review（YAML → Toolscript，官方说法是 "to simplify code review"），但**编辑器保持权威**——官方明说 "Retool recommends you not modify Toolscript files directly" `[E51]`。**这是第三种答案，不是我们要的那种，但它证明「画布权威」是一条有人认真走的路。**

#### 3.10.2 一句话把这件事说清楚的，反而是 Prefect

> "Most data engineers think of a DAG as a **visualization** of their workflow graph. **Workflow graphs are great!** … **You don't need to define a DAG, though, to create a workflow graph.**" `[E47]`

**图作为「视图」是好的；图作为「约束」才是问题。**

**这和 §3.9 的实测正好吻合**：7 成工作流确实有图结构（所以**视图**有价值），但只有约 1/3 需要多分叉（所以强制所有人在画布上**编辑**是过度约束）。

**净结论**：决策者「不做可视化图编辑器」是对的，而理由现在有三层——(i) 查到的成熟系统里图全是只读派生视图，(ii) 唯一的撤退案例正是从「编辑」退回「渲染」，(iii) 画布优先的 n8n 自己承认真相在 git 里。**但「不做编辑器」不等于「不画图」**——`docs/prototype-spec.md` §3 那个只读的 Loom 抽屉正是 Prefect 那句话里被肯定的东西 `[L2]`。

### 3.11 一条硬数字，和一个必须警告的陷阱：LangGraph 的循环上限

`@langchain/langgraph@1.4.12`，`npm pack` 实际发行包 `[M4]`：

- `dist/pregel/utils/config.js:36`：`const DEFAULT_RECURSION_LIMIT = 25;`，`:139` 处填进默认 config。
- 超限抛 `GraphRecursionError`（`dist/errors.d.ts:190` 的导出列表里）。

> ⚠️ **这个 25 只对 JS 成立。** Python 侧 `langgraph 1.2.11` 的 `langgraph/_internal/_config.py:32` 是
> `DEFAULT_RECURSION_LIMIT = int(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))` `[E41]`——
> **同一个产品，两个语言差 400 倍，而且 Python 那个还能被环境变量改掉。**
> 10007 实际上等于「不设限」。**任何「LangGraph 默认 25 所以安全」的推理，在 Python 上是错的。**
>
> 另有一条换算要注意：这个 limit 计的是 **superstep**，不是模型轮数。一个 ReAct agent 一轮
> （model → tools）通常吃 2 个 superstep，所以 JS 的 25 大约只等于 12 轮。
- `interrupt()`（`dist/interrupt.d.ts`）是**靠抛异常实现的**：
  > "Because the `interrupt` function propagates by throwing a special `GraphInterrupt` error, you should avoid using `try/catch` blocks around the `interrupt` function, or if you do, ensure that the `GraphInterrupt` error is thrown again within your `catch` block."

  并且「一个节点里可以有多个 interrupt，逐个处理」——这意味着**恢复时节点函数是从头重跑的**，靠已存的 resume 值把先前的 interrupt 一个个「放行」。这是 replay 语义在 LangGraph 里的具体形态，**代价是 interrupt 之前的代码会再跑一遍**。

## 4. agent 循环：把它当流水线里的一个节点

关键转向：**agent loop 不是顶层概念，它是图里的一个节点。** 所以要问的不是「怎么设计 agent 框架」，而是：

> 一个会自己跑很多轮、花很多 token、可能失败的东西，**怎么被外层当成一个步骤来对待**？

拆成四问：能不能给它一个**预算信封**；**超限时的返回形态**是什么；它的**输入输出边界**是什么形状；**跑到一半的状态能不能落盘**。

### 4.1 Vercel AI SDK v7：预算信封齐全，durable 完全没有（实测源码）

**这一节最值钱，因为它可能让自研方案作废。** 版本是仓库现在依赖的 `ai@7.0.64`（`package.json` 写 `^7.0.64`；npm 上最新 7.0.70）。**发行包里带完整 TypeScript 源码 `node_modules/ai/src/`**，以下全部读自那里 `[M2]`。

**注意 API 已经变过**：v5 时代的 `maxSteps` 没了，现在是 `stopWhen`；`stepCountIs` 也已标 `@deprecated`，现名 `isStepCount`（`src/generate-text/index.ts:56-58`）。别抄旧写法。

**循环的自然终止条件**（`src/generate-text/stop-condition.ts:8-12` 的 JSDoc 原文）：

> "A tool calling loop continues until one of the following conditions is met:
> - The model returns a finish reason other than `tool-calls`
> - A tool without an execute function is called
> - A tool call needs approval
> - One of the provided stop conditions returns `true`"

**内置停止条件只有三个**（同文件）：
- `isStepCount(n)`（:27）—— `({ steps }) => steps.length === stepCount`
- `isLoopFinished()`（:37）—— 永远返回 false，让它跑到自然终止
- `hasToolCall(...names)`（:47）—— 上一步调了某个工具就停

多个条件是**或**的关系：`isStopConditionMet` 用 `(await Promise.all(...)).some(r => r)`（:74-76）。

**默认值（实测，带行号）：**

| | 默认 | 出处 |
|---|---|---|
| `generateText` 的 `stopWhen` | **`isStepCount(1)`——默认根本不循环** | `src/generate-text/generate-text.ts:249` |
| `ToolLoopAgent` 的 `stopWhen` | **`isStepCount(20)`** | `src/agent/tool-loop-agent.ts:132`，JSDoc `@default isStepCount(20)` 在 `tool-loop-agent-settings.ts:89` |
| `maxRetries` | **2** | `src/prompt/request-options.ts:108-110` |

`ToolLoopAgent` 就是原来的 `Experimental_Agent`（`src/agent/index.ts:18-20` 把后者标成 `@deprecated` 别名）。

**预算信封——它给了什么：**

| 想限住的东西 | AI SDK v7 有没有 | 怎么写 |
|---|---|---|
| 轮数 | ✅ | `stopWhen: isStepCount(n)` |
| 墙钟时间 | ✅ **而且很细** | `timeout: { totalMs, stepMs, firstChunkMs, chunkMs, toolMs, tools: { xxxMs } }`（`src/prompt/request-options.ts:13-22`） |
| 单次请求重试 | ✅ | `maxRetries`，默认 2 |
| 取消 | ✅ | `abortSignal` |
| 工具调用次数 | ⚠️ 没有内置，但可写 | 自定义 `StopCondition`，`steps[]` 里有 `toolCalls` |
| **token 预算** | ❌ **没有内置** | 但 `StepResult` 带 `usage`，所以**可以自己写一个 `StopCondition` 累加 `steps[].usage` 来实现**。这是本仓库要补的第一件事。 |

`timeout` 那一组是真的分得很细：`totalMs`（整次调用）、`stepMs`（每一步）、`firstChunkMs` / `chunkMs`（只对流式，非流式传了会 warn，见 `generate-text.ts:596-610`）、`toolMs` 与按工具名的覆盖。对「agent loop 跑飞了」这个场景，`totalMs` + `stepMs` 基本够用。

**超限时的返回形态：** AI SDK **没有「超限异常」这个形态**。停止条件满足就是正常返回，`steps[]` 全在。循环本体是个 `do { … } while (…)`（`generate-text.ts:1434-1443`），条件是「有 client tool call 且全部执行完或被拒 **或** 有 pending 的 provider 侧延迟结果」**且** `!(await isStopConditionMet(...))`。**跑到 20 步停下来和跑完 3 步自然结束，返回的是同一种对象。** 这对外层调度是好事——不用区分两条路径。

**工具失败不中断循环**（`src/generate-text/execute-tool-call.ts:162-176`）：catch 住之后产出 `{ type: 'tool-error', toolCallId, toolName, input, error, … }`（类型在 `src/generate-text/tool-error.ts`），当作这一步的 content 回喂模型。所以「部分成功」是天然支持的：一批并行工具调用里，成功的给结果、失败的给 error，模型下一轮自己看着办。

**人在回路：`needsApproval`——这是被低估的一条。** `stop-condition.ts` 那句 "A tool call needs approval" 不是修辞。发行包里有一整套：`tool-approval-configuration.ts`、`collect-tool-approvals.ts`、`resolve-tool-approval.ts`、`tool-approval-request-output.ts` / `-response-output.ts`。工具上写 `needsApproval`（布尔或函数，`resolve-tool-approval.ts:109-126`），审批状态是 `'not-applicable' | 'approved' | 'denied' | 'user-approval'`。

**而且暂停点的状态就是 `ModelMessage[]` 本身。** `collect-tool-approvals.ts:23-38` 的做法是：看最后一条消息是不是 `role === 'tool'`，从里面收审批结果。也就是说——

> **恢复 = 把带着审批结果的 messages 再交给 `generateText` 跑一次。** 而 `ModelMessage[]` 是纯 JSON。

**这一条对本仓库价值很大**：不需要 checkpointer，不需要额外格式，**一个暂停中的 agent loop 就是一个可以写进文件的消息数组**。已经执行过的工具，结果就在 messages 里，恢复时不会重跑。这正是 §7 想要的「一步一个文件」的天然形态，而且格式是 SDK 已经在维护的那个。

#### 4.1.1 实测：这个暂停点真的能存成文件再读回来（372 字节）

上面那句「暂停点就是 `ModelMessage[]`」是整份调研里最吃重的一句——**§5 建议不自建持久化，全押在它成立**。所以我把它跑了一遍，没有只靠读源码 `[M14]`。

用 `ai/test` 的 `MockLanguageModelV3` 做一个必然触发审批的两步循环（工具上写 `needsApproval: true`），分三段测：

| 段 | 观察到什么 |
|---|---|
| ① 跑到审批点 | 模型调用 **1** 次；**工具执行 0 次**；`content` 里出现 1 个 `tool-approval-request`（带 `approvalId` 与完整 `toolCall`）；`steps.length === 1` |
| ② 落盘 | `JSON.stringify(result.response.messages)` → **372 字节**，普通 JSON，无自定义格式 |
| ③ 只从文件读回来续跑 | 追加一条 `{ role: "tool", content: [{ type: "tool-approval-response", approvalId, approved: true }] }` 再调 `generateText`：模型累计调用 **2** 次（**第一步没有重跑**），工具执行 **1** 次，拿到最终文本 |

**结论一：成立。** 一个停在审批点的 agent loop，全部状态就是 372 字节的 JSON；从文件恢复后**已完成的模型调用不会重放、工具不会重跑**。这不是 replay 语义，是**记忆化在消息记录里**——已经做完的事情就摆在 messages 里，所以不用重做。**对我们意味着：(B) 这一档不需要 checkpointer，`ai` 自己就够。**

**结论二（同样重要）：它只给 at-least-once。** 第四段实测——**拿同一份存档恢复两次**：

```
④ 用同一份存档恢复第二次后，工具累计执行次数: 2 [ 'hello', 'hello' ]
```

副作用发生了两遍。SDK 不认识「这份存档已经用过了」。**所以幂等仍然是外层的责任**——这和 Temporal 对 activity 的立场一致（§6.4）。入库那一侧本仓库已经成立（按 `(docId, clipId)` 派生 id 的 upsert，§6.2 ④）；**但「已经花掉的那次模型调用」不在其中**，见 §6.4。

**两条边界（明写）：**
- **暂停点只在审批边界上**，不是任意位置。模型正在生成到一半、或者工具执行到一半时进程死了，这一步就得整个重来——`ai` 没有更细的粒度。
- 用的是 mock model，**没有跨真实 provider 验证**。审批请求是 SDK 侧生成的（`resolve-tool-approval.ts`），与 provider 无关，所以我预期一致，但**没验证过就不算数**。

**事件模型**（`src/generate-text/generate-text-events.ts`）：`onStart` / `onStepStart` / `onStepEnd` / `onFinish` / `onAbort`，另加 `onToolExecutionStart` / `onToolExecutionEnd`。`StepResult` 带 `stepNumber` / `content` / `finishReason` / `usage` / `request` / `response`。够做进度显示。

**它没有的（决定性）：** 全包搜 `resume` / `persist` / `checkpoint`，只有 `stream-text-result.ts:47` 一处，讲的是 UI 消息流的续传，不是执行状态。**AI SDK v7 没有任何 durable execution。** 进程死了，loop 就没了——除非你停在审批点，或者自己把 `steps[]` / messages 落盘。

**仓库现状**：`pdfstudio/src/model/openai-compatible.ts:99,118` 只调 `generateText` / `streamText`，**没传 tools，所以今天根本没有 loop** `[L4]`。而 `ModelClient` 端口（`pdfstudio/src/model/model-client.ts`）只有 `complete` / `streamComplete`、`ModelMessage` 只有 `role` + `content: string`——**要接 tool-calling，这个端口必须改**，这是 ADR-0009 定的契约边界，改它要过 ADR。

### 4.2 OpenAI Agents JS：唯一把「跑到一半」做成一等对象的（实测源码）

`@openai/agents-core@0.17.0`，`npm pack` 实际发行包 `[M3]`：

- **默认 10 轮**：`dist/runner/constants.mjs` 全文就一行有效代码 —— `export const DEFAULT_MAX_TURNS = 10;`，注释是 "Shared runner-level constants. Keep behavior-altering defaults in one place."
- **超限抛异常，但异常带着状态**：`dist/runner/turnPreparation.mjs:61`
  ```js
  throw new MaxTurnsExceededError(`Max turns (${state._maxTurns}) exceeded`, state);
  ```
  而 `AgentsError` 的构造函数第二个参数就叫 `state` 并挂在实例上（`dist/errors.mjs:4-11`）。**所以即使跑爆了，你手上仍然有一个完整的 `RunState`。**
- **`RunState` 可序列化**：`dist/runState.d.ts` 有 `toJSON()`（:8499）、`toString()`（:8510）、`static fromString(initialAgent, str)`（:8519）。
- **代价：这个格式会 churn。** 同一文件 `:64`：
  ```ts
  export declare const CURRENT_SCHEMA_VERSION: "1.19";
  export declare const SUPPORTED_SCHEMA_VERSIONS: readonly ["1.0", "1.1", … , "1.19"];
  ```
  文件顶部有 44 行的版本历史注释，逐条写每个版本加了什么（1.2 加 nested agent 恢复、1.11 允许 `maxTurns` 为 null、1.19 加 sandbox 信封 v4……）。**20 个版本，全部还在支持列表里。**

**这一条是整份调研里对「要不要自己存半成品」最重要的证据**：把一个 agent loop 的中间态序列化，等于**给自己造了一个需要永久版本化的格式**。OpenAI 有一整个团队在维护它，还是走到了 1.19。

对照之下，AI SDK 那条路（暂停点 = `ModelMessage[]`）的格式风险低得多——因为 `ModelMessage` 是本来就要维护的对外契约，不是为了持久化新造的东西。

### 4.3 各家停止条件横向对照（已确认的部分）

| 实现 | 版本 | 轮数默认 | token 预算 | 墙钟 | 超限时 | 中间态可序列化 |
|---|---|---|---|---|---|---|
| Vercel AI SDK `generateText` | 7.0.64 | **1**（不循环） | ❌ 无内置（可自写） | ✅ `timeout.{total,step,…}Ms` | 正常返回，`steps[]` 全在 | ❌（但审批暂停点 = messages，可落盘） |
| Vercel AI SDK `ToolLoopAgent` | 7.0.64 | **20** | 同上 | 同上 | 同上 | 同上 |
| OpenAI Agents（JS 0.17.0 / Py 0.22.0） | **10**（两语言一致） | ❌ 无（grep 零命中） | ❌ 无 loop 级 | 抛 `MaxTurnsExceededError`（带 `state`），**但可被 `RunErrorHandlers` 拦成正常输出** | ✅ `RunState`，schema JS **1.19** / Py **1.16**（不同步） |
| LangGraph（JS 1.4.12 / Py 1.2.11） | **JS 25 / Py 10007**（计 superstep） | ❌ 无（grep 零命中） | ❌ 无 loop 级（只有 per-superstep `step_timeout`，默认 None） | 抛 `GraphRecursionError`；另有 `request_drain()` → `GraphDrained`（**边界优雅停 + checkpoint 已存**） | ✅ checkpointer（见 §6） |
| Anthropic `tool_runner`（py 1.0.0 / ts 0.120.0） | **∞——默认无上限** | ❌ 无 | ❌ 无 loop 级（只有 `AbortSignal`） | **静默 break**，不抛 | ❌（状态 = messages 数组） |
| Pydantic-AI `UsageLimits`（2.32.2） | **50 次模型请求** | ✅ **唯一齐全的一家** | ❌ 无 run 级（只有 per-tool） | 抛 `UsageLimitExceeded` | ❌（外包给 Temporal/DBOS/Prefect） |

#### 4.3.1 Anthropic 官方 runner 默认是**无限循环**（源码实测）

这条值得单独拎出来，因为它和所有人都不一样 `[E15]`：

```python
# anthropic-sdk-python 1.0.0, src/anthropic/lib/tools/_beta_runner.py:66-73
class BaseToolRunner(...):
    def __init__(self, *, params, options, tools,
                 max_iterations: int | None = None) -> None:   # ← 默认 None
```
```python
# 同文件 L122-125
def _should_stop(self) -> bool:
    if self._max_iterations is not None and self._iteration_count >= self._max_iterations:
        return True
    return False
```

**不传就是不限。** 而且超限时**不抛异常**——`_should_stop()` 只是让 `while` 退出，迭代器正常结束，`until_done()` 返回当时的最后一条 message。**调用方要自己比对 `stop_reason` 才知道是「模型说完了」还是「预算用光了」。**

TypeScript 侧同构，还多一个陷阱 `[E16]`：

```ts
// anthropic-sdk-typescript 0.120.0, src/lib/tools/BetaToolRunner.ts
if (this.#state.params.max_iterations && this.#iterationCount >= this.#state.params.max_iterations) break;
```

`&&` 的 falsy 短路意味着 **`max_iterations: 0` 也等于无上限**，不是「零轮」。

**另一条反直觉的**：循环条件**不是** `stop_reason === 'tool_use'`。两个 SDK 都只显式判 `refusal` 一处，其余靠「最后一条 assistant message 里有没有 `tool_use` content block」。比看 `stop_reason` 更宽松——**`max_tokens` 中途截断但已经产出了一个完整 `tool_use` block 的情况，仍然会继续跑。**

工具抛错的处理和 `ai` 一样，降级成模型可读的文本（`is_error: true` 的 `tool_result`），`except Exception` 全吞。**所以一次 run 里没有「工具失败」这个终止态**；外层想知道「这次炸了几个工具」，只能自己扫 messages 里的 `is_error`。

一个 TS/Python 的行为差异，对预算有影响：**TS 侧同一轮的多个 tool_use 是 `await Promise.all(...)` 并行执行，Python 侧是 `for` 串行**，且都没有并发上限参数 `[E15][E16]`。

#### 4.3.2 Pydantic-AI 是唯一把「预算」当一等公民的（源码实测）

`UsageLimits`（2.32.2）的字段与默认值 `[E17]`——**注意字段名已经改过**，老的 `request_tokens_limit` / `response_tokens_limit` 现在叫 `input_tokens_limit` / `output_tokens_limit`：

| 字段 | 默认 |
|---|---|
| `request_limit` | **50** ← 唯一非 None |
| `cost_limit`（按钱！） | `None` |
| `tool_calls_limit` | `None` |
| `input_tokens_limit` / `output_tokens_limit` / `total_tokens_limit` | `None` |
| `per_request_input_tokens_limit` | `None` |
| `count_tokens_before_request` | `False` |

**最有用的一条是它 docstring 里那个「前置 / 后置」的区分** `[E17]`：

> "The request count is tracked by pydantic_ai, and the request limit is checked **before** each request to the model. Token counts are provided in responses from the model, and the token limits are checked **after** each response."

**这决定了超额的账单归谁：**
- `request_limit` 前置 → 第 51 次请求**不会发出去**。
- token 限制后置 → **超额那一次请求已经发了、已经计费了**，然后才抛。源码注释自己承认：「otherwise the request is sent before the limit is checked, so the oversized request is still billed」。
- 想前置，得开 `count_tokens_before_request=True`（默认关），代价是每轮多一次 `count_tokens` 往返，且只有部分 provider 支持。

**直接推论到 §8 档 0**：我准备给 `ai` 加的那个 token 预算 `StopCondition`，**在语义上必然是「后置」的**——`steps[].usage` 只有在这一步跑完之后才有。也就是说**它拦不住「最后那一次超额调用」，只能拦住下一次**。这是个必须写清楚的边界，不能宣称成「花不超过 N」。

还有一条：`cost_limit` **会静默失效**——算不出价格时只发一个 `CostNotFoundWarning`（「A `cost_limit` is set but cannot be enforced because no cost was calculated for this run.」）。**按钱设的上限不能当硬保证。**

#### 4.3.3 最强的外部佐证：Pydantic-AI 自己把「进程死了怎么办」外包出去了

`pydantic_ai/durable_exec/` 下有三个子包：`temporal/` / `dbos/` / `prefect/` `[E17]`。也就是说这个框架的立场是——

> **agent loop 不回答「崩了怎么办」。那是外面那层 workflow engine 的事。**

`temporal/` 里把每个 model request 和每个 tool call 包成 Temporal activity，持久化与重放交给 Temporal 的 event history，**而不是自己发明一个 checkpoint 格式**。

**这正好独立验证了本文的分层**（也是 §2.1.2 从 Temporal overlap policy 得到的同一个结论）：**(B) 是 (C) 里的一个节点，(B) 自己不该管持久化。** 一个成熟框架、一个成熟调度器，从两个方向给出了同一个分层。

#### 4.3.5 超预算的三种语义，而只有一家给了对的那种

跨源码读下来，「预算用光了」这件事有三派做法，**选型时这是个真问题**：

| 派别 | 谁 | 问题 |
|---|---|---|
| **静默停** | Anthropic `tool_runner`、Vercel AI SDK | **你分辨不出它是答完了还是被截断了**。外层必须自己数轮数或查 `stop_reason` |
| **硬抛** | Pydantic-AI `UsageLimitExceeded`、LangGraph `GraphRecursionError` | 清晰，但半成品结果全丢（除非另有 checkpoint） |
| **可拦截** | **只有 OpenAI Agents** | — |

OpenAI Agents Python 的 `RunErrorHandlers` `[E44]`：

```python
class RunErrorHandlers(TypedDict, Generic[TContext], total=False):
    max_turns: RunErrorHandler[TContext]
    model_refusal: RunErrorHandler[TContext]
    invalid_final_output: RunErrorHandler[TContext]
```

`run.py` 里超限时**先问 handler，`handler_result is None` 才抛**。handler 拿到的 `RunErrorData` 带着 `input / new_items / history / output / raw_responses / last_agent` 一整个现场，返回一个 `RunErrorHandlerResult` 就能把「预算耗尽」**降级成一个正常的 final output**。

**对一个 pipeline 节点，这才是对的语义**：超预算不该是失败，应该是**「交出你现在有的东西」**。这和 §2.1.1 ③ 那条（人为中断 ≠ 失败）是同一种克制。

**我们要自己实现它**，因为 `ai` 属于「静默停」那一派：`stopWhen` 满足就正常返回。**所以档 0 那个 token 预算 `StopCondition` 必须配一个「为什么停的」标记**——否则调用方拿到的和「模型自己说完了」长得一模一样。

#### 4.3.6 「读者把应用关了」：只有 LangGraph 给了优雅停的 API

其余所有实现能提供的只有 `AbortSignal` / `CancelledError`——**那是硬砍，不保证停在边界，也不保证中间状态落了盘。**

LangGraph 有 `RunControl.request_drain()` 与配套的 `GraphDrained` 异常，源码 docstring 原文 `[E45]`：

> "Raised when a graph run exits early due to a drain request. This indicates the graph **stopped cooperatively at a superstep boundary** because `RunControl.request_drain()` was called (e.g., in response to SIGTERM). **The checkpoint is saved and the run can be resumed later.**"

**这正好是我们要的那个东西**：读者按 ⌘Q（或 `powerMonitor` 的 `shutdown` 事件，§2.5）→ 不是 kill，是**在步骤边界停下、把状态写完、下次接着跑**。

**对我们的落地**：这一条不需要 LangGraph，它是一个模式——**取消要在两步之间生效，不在一步中间生效**。而且它和 §6.0.2 的心跳是同一件事的两面（Temporal：不心跳的 activity 收不到取消）。仓库里已有的 `before-quit` + 信号处理（`electron/main.ts`）是挂点 `[L13]`。

#### 4.3.7 一条哲学分歧：token 花超了，该停还是该压缩？

- **Pydantic-AI**：设 `total_tokens_limit`，超了抛异常。**省着花。**
- **Anthropic**：官方文档说长任务用 **compaction**——token 超阈值就自动生成摘要，让对话越过上下文窗口继续 `[E46]`。而且客户端那版已经 deprecated，**改推服务端 context editing**（TS 源码里的 deprecation 注释指向 `edits: [{ type: 'compact_20260112' }]`）。**花完了想办法接着花。**

**两种相反的哲学，而对我们，答案取决于成本由谁承担。** 读者自己配的 endpoint、自己付钱（ADR-0005 `[L19]`）——**所以是「省着花」那一派**，而且上限必须是读者能看见、能改的。压缩是把成本藏起来，对一个花读者自己的钱的工具是错的默认。

#### 4.3.4 「中间态是不是一等对象」：只有一家是

| | 中间态 | 形态 |
|---|---|---|
| OpenAI Agents JS | ✅ **一等对象** | `RunState.toString()` / `fromString()`，带 `CURRENT_SCHEMA_VERSION = "1.19"` |
| Vercel AI SDK | ⚠️ 只在审批点 | 就是 `ModelMessage[]`，**实测 372 字节可往返** `[M14]` |
| Anthropic py/ts | ⚠️ 同上，但更封闭 | 状态 = `params["messages"]`；TS 侧全在 `#` 私有字段里，`toJSON`/`serialize` **grep 零命中**；源码注释写着「You can't clone the entire params since there are functions as handlers.」 |
| Pydantic-AI | ❌ 外包 | 见 §4.3.3 |
| LangGraph.js | ✅ checkpointer | `BaseCheckpointSaver` 五个抽象方法，可换文件后端 |

**Anthropic 那一档有个隐藏代价**：手工续跑（存下 messages、重开一个 `tool_runner`）会让 `_iteration_count` 归零（**预算重置**），并丢掉 `_cached_tool_call_response`（**挂在最后一轮的 tool 可能被重跑**）`[E15]`。这与 §4.1.1 实测到的 `ai` 的「同一份存档用两次、副作用两遍」是同一类问题——**「用 messages 当存档」这条路很省事，但它把幂等的责任整个交给了外层。**

**唯一一个有硬编码单次 tool 墙钟上限的**：Anthropic 的 `SessionToolRunner`（managed agents 那条路），`TOOL_TIMEOUT = 150.0` 秒 `[E15]`。其余所有实现的 tool 超时都要调用方自己给。

---

## 5. build vs adopt：该不该自己写

**优先级第 1。** 判据是这四条硬约束：① Electron 桌面、**没有服务器进程**；② TypeScript / Node 22；③ **持久化必须能落成我们自己控制的普通文件**（ADR-0011「文件是唯一真相」）；④ 依赖体积要付运费。

### 5.1 真实数字（全部实测取回，2026-08-21）

npm 元数据来自 `npm view`；GitHub 数字来自 `gh api`，90 天窗口 = `since=2026-05-23T00:00:00Z` `[M10]`。

| 包 | 版本 | 解包体积 | license | 仓库 | **近 90 天提交** | stars | open issues |
|---|---|---|---|---|---|---|---|
| `ai`（Vercel AI SDK） | 7.0.70 | 6.7 MB | Apache-2.0 | vercel/ai | **981** | 26,323 | 1,776 |
| `@mastra/core` | 1.60.0 | **64.6 MB** | Apache-2.0 | mastra-ai/mastra | **3,036** | 27,335 | 493 |
| `@langchain/langgraph` | 1.4.12 | 4.3 MB | MIT | langchain-ai/langgraphjs | **220** | 3,221 | 118 |
| `@langchain/core`（必带） | 1.2.9 | 7.6 MB | MIT | — | — | — | — |
| `@langchain/langgraph-checkpoint-sqlite` | 1.0.4 | 73.6 KB | MIT | — | — | — | — |
| `xstate` | 5.32.5 | **2.3 MB** | MIT | statelyai/xstate | **32** | 30,037 | 121 |
| `@openai/agents` | 0.17.0 | 23.8 KB（元包） | MIT | openai/openai-agents-js | **314** | 3,663 | 16 |
| `inngest` | 4.18.1 | 6.0 MB | **GPL-3.0** | inngest/inngest-js | **95** | 997 | 134 |
| `@dbos-inc/dbos-sdk` | 4.26.10 | 2.0 MB | MIT | dbos-inc/dbos-transact-ts | **76** | 1,325 | 6 |
| `@voltagent/core` | 2.9.2 | 12.9 MB | MIT | VoltAgent/voltagent | **35** | 10,387 | 87 |

（`@mastra/core` 的 64.6 MB 和 `inngest` 的 GPL-3.0 都是需要单独看一眼的数字。）

### 5.2 逐个判定

**`ai`（已在依赖里）** —— 详见 §4.1。循环、预算、超时、重试、工具审批全有；**durable execution 一样没有**。作为 (B) 的实现**够用**；作为 (C) 或 (A) 的实现**完全不适用**（它不管这两件事）。

**`@dbos-inc/dbos-sdk` —— 出局，Postgres 硬依赖。** 实测 `[M6]`：`package.json` 的 `dependencies` 只有 `commander, pg, serialize-error, superjson, ws, yaml`，**没有任何 sqlite 驱动**；`peerDependencies` / `optionalDependencies` 都是空的。`dist/src/sysdb_migrations/migration_runner.d.ts` 第一行就是 `import type { ClientBase } from 'pg'`，导出的迁移函数叫 `runSysMigrationsPg`。类型里确实有一个 `sqlite3?: ReadonlyArray<string>` 字段，但那是**跨语言共享的迁移定义**（注释：「From this index on, every SDK defines the same migration at the same index」），TS 侧的执行器是 Postgres 专用。**桌面应用带不动 Postgres，出局。**

**`inngest` —— 出局，必须有一个外部执行器。** 实测 `[M11]`：`helpers/consts.js:189-190` 写着
```js
export const defaultInngestApiBaseUrl = "https://api.inngest.com/";
export const defaultDevServerHost = "http://localhost:8288/";
```
SDK 本身只是 handler，**驱动它的是云端或本机 :8288 上的 Dev Server 二进制**。另外 license 是 **GPL-3.0**，要单独评估。同文件还有一条可引用的数字：`defaultMaxRetries = 3`。

**`xstate` —— 最轻，但「跑到一半」是重跑不是接着跑。** 实测 `[M9]`：
- 有 `actor.getPersistedSnapshot()`（`dist/declarations/src/createActor.d.ts:153`）和 `createActor(machine, { snapshot })` 恢复，快照是普通 JSON。**能落文件，没有服务器，2.3 MB。**
- **但是**：promise actor 的 `start` 实现（`dist/xstate-actors.development.cjs.js:782-795`）是
  ```js
  start: (state, { self, system, emit }) => {
    // TODO: determine how to allow customizing this so that promises
    // can be restarted if necessary
    if (state.status !== 'active') { return; }
    const controller = new AbortController();
    // …重新调用 promiseCreator…
  }
  ```
  也就是说：**快照恢复时，一个还处于 `active` 的异步步骤会被从头再执行一遍**，SDK 自己在源码里留了 TODO 说这一点还没法定制。
- 净判定：XState 给的是**状态机的持久化**，不是**步骤结果的记忆化**。它能记住「走到哪个状态」，不能记住「这一步的输出是什么」。用它当 (C) 的骨架是可以的，但 §7 那套「一步一个文件」还是得自己写。

**`@langchain/langgraph` —— 能无服务器跑，持久化可换成文件。**
- 无服务器：可以，作为库使用，用 `MemorySaver`；官方另有 `@langchain/langgraph-checkpoint-sqlite`（73.6 KB）。
- **持久化接口是 `BaseCheckpointSaver`**（`@langchain/langgraph-checkpoint@1.1.5`，`dist/base.d.ts:57`），抽象方法只有五个：`getTuple` / `list` / `put` / `putWrites` / `deleteThread`。**这是一个可以照着写文件实现的窄接口**——这一点很重要，它说明「换成文件后端」不是空话。
- 代价：`@langchain/core` 7.6 MB 一起进包；而且它的图是代码里显式连边的（§3.1），与「边从数据依赖推导」的方向不一致。
- 循环上限 25，`interrupt()` 恢复时**节点从头重跑**（§3.11）——同 XState 的那个问题。

**`@mastra/core` —— 功能最全，体积最劝退。**
- suspend/resume 是一等功能：步骤里 `suspend()`，外面 `run.resume({ step, resumeData })`；官方文档原话："When a workflow is suspended, its current execution state is saved as a snapshot." "Snapshots are stored in your configured storage provider and **persist across deployments and application restarts**." `[E1]`
- 存储可以是本地文件：libSQL 适配器支持 `url: 'file:./mastra.db'`；文档同时明说默认的内存 store "loses data when the process exits" `[E2]`。
- **代价是 64.6 MB 解包体积 + 一个 SQLite 文件**。对一个已经要分发 326 MB 模型权重的应用（ADR-0014），体积不是绝对的否决理由，但 64.6 MB 换的是一整套我们只用其中一小块的框架。
- 另一个信号：90 天 3,036 次提交。活跃是好事，但对一个要长期抱着的依赖，也意味着 API 变动频繁。

**`@openai/agents` —— 见 §4.2。** 它解决的是 (B) 的中间态，不是 (C) 和 (A)。真要用它，代价是接受那个 1.19 版且还在涨的 `RunState` 格式。

**`@voltagent/core`** —— 90 天 35 次提交、12.9 MB。**无服务器与文件持久化能力未核实**（§9.2）。

**一句话出局的：** Temporal（要 Temporal Server + 数据库）、Restate（要 Restate Server 二进制）、Trigger.dev（要托管/自托管服务）、n8n / Dify（是产品不是库，且要服务器）、Prefect / Dagster / LangGraph Python / CrewAI / AutoGen / Agno（Python，仓库是 TS）、BullMQ（要 Redis）。

### 5.3 初步判定

**定稿。** §3 查完之后结论没有变，反而更硬了（见「明确不做」第 6 条）。

**(B) 直接用已有的 `ai`。** 它已经在依赖里、预算信封齐全、工具失败不中断，而且**审批暂停点可落盘这件事我实测过了**——372 字节 JSON，读回来续跑不重放、工具不重跑（§4.1.1，`[M14]`）。不引第二个 agent 框架。要补的只有两件，都很小：

1. **一个累加 `steps[].usage` 的 token 预算 `StopCondition`**——十几行。
2. **外层给存档一个用过就作废的标记**——因为实测同一份存档恢复两次，副作用会发生两遍（`[M14]`）。

**特别地：不要为了 (B) 引入 OpenAI Agents SDK。** 它确实把「跑到一半」做成了一等对象（§4.2），但代价是接受一个已经迭代到 **1.19、二十个版本全在支持列表里**的私有序列化格式（`[M3]`）。`ai` 那条路的存档是 `ModelMessage[]`——SDK 本来就要维护的对外契约，不是为持久化新造的东西。**在「要不要自己存半成品」这个问题上，格式的长期成本比一次性的实现成本大得多。**

**(A) 和 (C) 自己写。** 理由不是「太重」，而是逐条不满足：
- Inngest / DBOS：**硬性需要一个我们不能分发的进程或数据库**（实测，见上）。
- Mastra / LangGraph：能跑，但它们的持久化是**它们的格式**（`mastra.db` / checkpoint 表），而 ADR-0011 要求**文件是唯一真相且可 grep、可 git、可手改**。换成文件后端 = 实现 `BaseCheckpointSaver` 或 `MastraStorage`，那时我们既写了自己的存储层，又背上了整个框架。
- XState：快照能落文件，但**它不记步骤输出**，`// TODO` 那行说明这不是我们能配出来的。

**退出成本**这一栏对本仓库尤其重要：ADR-0014 的整个论证是「不要两份适配器」，而引入一个带自己持久化模型的框架，等于在 `ClipStore` / `ContextStore` 之外多一套真相来源。

---

## 6. 持久化与崩溃恢复

> **未补**：Restate 与 Inngest 的机制细节。Temporal 见下；DBOS 见 §6.1；LangGraph 的 checkpoint 结构见 §6.1.1。

### 6.0 replay 的真正代价：你的代码变成了 schema 的一部分

**durable execution 有两种做法，区别是根本性的：**

| | 恢复方式 | 代表 |
|---|---|---|
| **replay** | **把函数从第一行重跑**，把日志里已记录的结果喂回去，跑到日志末尾之后才真的产生新副作用 | Temporal、Restate |
| **记忆化 / checkpoint** | 直接跳到没做完的那一步 | DBOS（按 `function_id` 序号）、`ai` 的审批点（按 messages） |

Temporal 的原文 `[E27]`：

> "When the Workflow's code replays, the Commands that are emitted are compared with the existing Event History. If a corresponding Event already exists within the Event History that matches that command, then the Execution progresses."

注意 **"in the same location within the sequence"**——**按序号对位**，不是按内容寻址。这与 §3.3/§3.4 的 Bazel / Nix 正好相反，也和 DBOS 的 `function_id` 一致（§6.1）。

**replay 要求代码是确定性的**，而 Temporal 把这条要求写得很细 `[E28]`：不许用可变全局变量、不许 `UUID.randomUUID()`、不许直接读系统时间（要用 `Workflow.currentTimeMillis()`）、不许原生线程、Go 里连 **`range` 遍历 map 都不行**（因为顺序是随机的）。所有外部交互必须搬进 activity：

> "Workflow code must be deterministic to support replay. To handle non-deterministic operations like API calls, **LLM/AI invocations**, database queries, and other external interactions, **put them in Activities**. Activities execute outside the replay path…"

**（注意官方自己把 LLM 调用列进了「必须外置」的清单。）**

**而最大的代价不是写代码时的这些约束，是发版。** 官方给的例子直白到刺眼 `[E27]`——一个 workflow 是「先睡一觉、再跑一个 activity」，在它睡着的时候你把两行代码换个顺序，于是：

> "The first Command the Worker sees would be ScheduleActivityTask Command, which wouldn't match up to the expected `TimerStarted` Event. **The Workflow Execution would fail and return a nondeterminism error.**"

**仅仅把两行代码调换顺序，所有还在运行的实例全部失败。** 对桌面应用，这等价于「你发了个新版本，用户机器上没跑完的任务全废」。

躲开它要付的税叫 `patched()` / `GetVersion`，而官方自己承认它反直觉 `[E29]`：

> "Note that this behavior means that the Workflow **does not always run the newest code**."

还有一条必须背下来的手写规则，否则新执行会走错分支：

> "when patching in new code, **always put the newest code at the top of an if-patched-block**."

**净判断：replay 这条路本仓库不能走。** 理由不是「太重」，是三条具体的：
1. 我们**发版频繁、用户升级不可控**，而 replay 把「改代码」变成了「迁移数据」。
2. 代价的形式是**在飞的 run 全部失败**，且失败发生在用户机器上、我们看不见。
3. 换来的好处（把中间状态完全省掉）我们并不需要——**§7.1 实测过，git 那种「一步一个文件」的中间状态只有两千字节。**

**该抄的是记忆化那一支**（DBOS / `ai` 的审批点），不是 replay 那一支。

### 6.0.1 Temporal 的超时默认值：全是 ∞，而且它自己劝你别用默认

四个 activity 超时的官方默认值 `[E30]`：

| 超时 | 语义 | 默认 |
|---|---|---|
| Schedule-To-Start | 排队等到被 worker 领走的最长时间 | **∞** |
| **Start-To-Close** | **单次执行的最长时间** | **∞** |
| Schedule-To-Close | 整个 activity（含重试链）的最长时间 | **∞** |
| Heartbeat | 两次心跳之间的最长间隔 | **没有公开数据**（该页未给） |

> "An Activity Execution must have either this timeout (Start-To-Close) or the Schedule-To-Close Timeout set."
> "**We strongly recommend setting a Start-To-Close Timeout.**"

**这条和 §4.3.1 的 Anthropic runner 是同一个形状**：默认无限，靠文档喊你去设。对我们的推论很直接——**「agent loop 跑飞了」不会有任何现成的东西来救你，`timeout.totalMs` 必须显式设**（§8 档 0）。

Retry policy 的默认值 `[E31]`：`Initial Interval = 1 second`、`Backoff Coefficient = 2.0`、`Maximum Interval = 100 × Initial Interval`、**`Maximum Attempts = ∞`**、`Non-Retryable Errors = []`。对照仓库里已有的 `retry.ts`：`tries: 3`、`BACKOFF_MS = 700` 递增 `[L8]`——**我们的更保守，而且区分了瞬时/永久错误，这一点比 Temporal 的默认更适合「调模型要花钱」的场景。**

还有一条反直觉但重要的 `[E31]`：

> "Unlike Activities, **Workflow Executions do not retry by default**." "Retrying an entire Workflow Execution is not recommended due to the deterministic nature of Workflow replay."

**重试的粒度是步骤，不是整个 run。**

### 6.0.2 心跳：判死的依据是「进展停了」，不是「时间到了」

> "An Activity Heartbeat is a ping from the Worker that is executing the Activity to the Temporal Service. Each ping informs the Temporal Service that the Activity Execution is making progress and the Worker has not crashed." `[E30]`
>
> "Heartbeating is best thought about not in terms of time, but in terms of **'How do you know you are making progress?'**"

两条设计细节值得抄：

1. **心跳可以带 payload，而且那个 payload 就是断点**：「A Heartbeat can include an application layer payload that can be used to _save_ Activity Execution progress. If an Activity Task Execution times out due to a missed Heartbeat, **the next Activity Task can access and continue with that payload**.」——这正是 §7.2 里 `steps/` 那些文件该起的作用。
2. **取消只能在心跳点送达**：「Activities that don't Heartbeat can't receive a Cancellation.」——所以我们那个「读者点了停」的按钮，必须挂在同一个循环上，不能指望它在任意位置生效。

对我们的落地形态：**长跑的步骤定期更新一个 `progress` 文件（带断点 payload），监督方看它的 mtime 判活。** 这与 §2.1.4 那个「超过多久认定它死了」是一对——一个给上限，一个给「还活着」的证据。

节流的默认值（如果我们要抄这个机制）`[E30]`：`defaultHeartbeatThrottleInterval` 30 秒、`maxHeartbeatThrottleInterval` 60 秒；有 `heartbeatTimeout` 时用它的 0.8 倍。

### 6.1 已确认：一个真实系统的最小步骤日志长什么样

DBOS 的 system database schema（`@dbos-inc/dbos-sdk@4.26.10`，`dist/schemas/system_db_schema.d.ts`，实测 `[M6]`）。两张表是核心：

```ts
export interface operation_outputs {
  workflow_uuid: string;
  function_id: number;        // ← 步骤的身份 = 在 workflow 里的第几步
  output: string;
  error: string;
  child_workflow_id: string;
  function_name?: string;
  started_at_epoch_ms?: number;
  completed_at_epoch_ms?: number;
  serialization: SysDBSerializationFormat | null;
}
```

```ts
export interface workflow_status {
  workflow_uuid: string;
  status: string;
  name: string;
  // …
  application_version?: string;      // ← 这次 run 绑在哪个代码版本上
  recovery_attempts: number;          // ← 恢复过几次
  workflow_timeout_ms: number | null;
  workflow_deadline_epoch_ms: number | null;
  inputs: string;
  // …
}
```

三条可以直接抄的观察：

1. **步骤的身份是「第几步」，不是「输入的哈希」。** `function_id` 是一个序号。这就是为什么 DBOS 要求 workflow 函数在步骤**顺序**上确定——序号对不上，记忆化就错位。这与 Make / Bazel / Nix 那类按内容寻址的系统是**两种完全不同的身份模型**（§3 待补）。
2. **`application_version` 说明代码版本是 run 的一部分。** 「改了代码，在飞的 run 怎么办」这个问题，DBOS 的答案是把版本记下来。
3. **最小字段集**：`(run id, 步序号, output, error, 起止时间)`。加上 `workflow_status` 的 `status` / `recovery_attempts` / `inputs`。**这就是一个「一步一个文件」方案要写的全部东西。**

`workflow_schedules` 那张表还给了 §2.4 的那个字段：`last_fired_at` + `automatic_backfill`。

### 6.1.1 另一个真实系统的最小步骤日志：LangGraph 的 checkpoint

和 DBOS 的「按序号」不同，LangGraph 用的是**版本向量**。`Checkpoint` 这个 TypedDict 的字段 `[E45]`：

```
v                # 格式版本，当前 1
id               # 唯一且单调递增，可直接排序
ts               # ISO 8601
channel_values   # 状态本身
channel_versions # 每个 channel 现在是第几版
versions_seen    # 每个节点见过每个 channel 的第几版
updated_channels
```

`versions_seen` 的 docstring 点出了全部要害：

> "Map from node ID to map from channel name to version seen… **Used to determine which nodes to execute next.**"

**恢复不是重放，是从版本向量直接算出「谁还没跑」。** 所以已完成的步骤不会重跑。配套的 `put_writes` 记的是「某个节点已经算完、但整个 superstep 还没提交」的中间写——**这才是「不重跑已完成工具」的机制保证**。

**三种身份模型，到此凑齐了：**

| | 步骤的身份 | 恢复方式 |
|---|---|---|
| **Temporal** | 事件在序列里的**位置** | replay（从头重跑代码） |
| **DBOS** | `function_id`，一个**序号** | 记忆化（跳到没做完的） |
| **LangGraph** | **版本向量**（谁见过哪个 channel 的第几版） | 算出「谁还没跑」 |
| **Bazel / Nix** | **输入的内容哈希** | 存在性判定 |
| **git rebase** | **剩余清单的第一行** | todo/done 此消彼长 |

**对我们，git 那一档最合适**（§7.1）：不需要版本向量的表达力，而它的状态是人能读的纯文本。

**还有一个默认值要注意**：LangGraph 的 `durability` 默认是 `"async"`——**存 checkpoint 和跑下一步是并发的** `[E45]`。也就是说**默认模式下进程硬崩可能丢掉最后一个 superstep 的 checkpoint**；要严格不丢得显式 `durability="sync"`，代价是每步一次同步写。**这是一个默认值站在「快」而不是「稳」那边的真实取舍**，而我们这边应该反过来——一次模型调用几秒钟，多一次 `rename` 的开销可以忽略，丢一步的代价却是重新花钱。

### 6.2 仓库里已经有的四个可抄机制（实测）

不用从零发明，`pdfstudio/` 里已经把最难的几条踩过了：

**① 崩溃后靠文件收尸** —— `pdfstudio/src/model/engine-registry.ts` + `engine-registry-file.ts` `[L5]`。账本落 `running.json`，下次启动 `reap()`。注释原话：

> 「『退出时停掉』是必要的，但**它覆盖不了 SIGKILL 和崩溃**，而那正是实际发生的情况。所以这一层是兜底：账本落盘，下次开机先扫一遍。」

还有一条只有踩过才知道的教训：**不能只问「pid 还活着吗」**——

> 「pid 会被系统回收再分配，上一次记下的号码这会儿可能是浏览器的某个 helper。照着杀就是杀无辜，而且现象是『别的软件莫名其妙没了』，根本查不到这里。」

所以 `RegistryDeps` 里那个方法叫 `commandOf(pid)` 而不是 `isAlive(pid)`，实现是 `ps -o command= -p <pid>`，认出是 `llama-server` 才动手。**「一个 run 的记录还在，但它到底是不是还在跑」是同一个问题，同一个答案：记下足够多的东西来确认身份，别只记一个会被复用的号码。**

**② 先写 `.part` 再 rename** —— `llama-server.ts:151-153`、`:229` `[L6]`。注释：「下到一半断网留下的半个文件，下次会被 `has()` 当成『已就绪』」。ADR-0011 代价①把这条升成了规则：「先写文件（临时目录再 `rename`，同一文件系统上原子），再更新索引；**顺序不能反**」`[L7]`。

**③ 重试，且区分瞬时/永久** —— `pdfstudio/src/outline/retry.ts` `[L8]`。默认 `tries: 3`，`BACKOFF_MS = 700` 递增退避，`wait` 是注入点让测试跳过真实等待。判据是一个 `transient()` 函数，只认 `model-unavailable`：

> 「`bad-output` 不重试：模型没按约定给 JSON 是这张图加这个 prompt 的结果，再问一遍多半是同样的形状，白花一次钱。不认识的错更不重试——那通常是代码写错了，重试只会把 bug 藏起来。」

这条对 (B) 直接适用：**agent loop 的一步失败了，该不该重试取决于错误的种类，不是重试次数。**

**④ 幂等入库已经是契约** —— `contextstudio/src/context-store.ts:12` `[L9]`：

> 「收下 PDF Studio 交出的一批。**幂等：同一批导入两次，库里条数不变。**」

`IngestReport` 是 `{ added, updated, sourceDeleted }`。ADR-0002 硬要求①把机制写死了：**id 由 `(docId, clipId)` 派生，导入是 upsert 不是 append** `[L10]`。而且 ADR-0002 特意指出这一条最容易漏、代价最大：

> 「`docs/workflow.md` §8 把 draft 的 provenance 比作 lockfile，id 一变，所有引用它的段落全断，**而且不报错**。」

**这正好是 DBOS 那个 `sched-${name}-${next.toISOString()}` 的同一个思路**：不判断「跑过没有」，而是让 id 本身决定。`scan` 节点重跑一遍是安全的，因为入库幂等——**这条已经成立，不用新做。**

### 6.3 长任务在这个仓库里现在长什么样

**已有形态**（可以照抄）：模型下载 / 引擎启动。状态活在本机 API 进程的一个内存变量 `enginePhase` 里，渲染侧 `LocalModel.tsx:33` 每 2 秒轮询 `/__engine` `[L11]`：

> 「下载 1.7 GB 加载模型可能要十几分钟，期间一直轮询；就绪或没在做事就停。」

**它不落盘，重启就没了**——对下载来说可以接受（`.part` 文件在，重来一次就是了）。

**反例**（不能照抄）：`pdfstudio/app/react/toc-scan.ts` —— 逐页调模型建目录，**整个循环跑在渲染进程里**，不落盘。关窗口就全丢 `[L12]`。这正是 loop 不能放在渲染侧的实证。

---

### 6.4 幂等：副作用发生了但没记下来——而这一条对我们比对别人更痛

**先纠正我自己一处措辞。** 上文（§4.1.1）说「at-least-once，和 Temporal 的立场一致」——**「at-least-once」是我的概括，不是 Temporal 主文档的用词**。它的 activity-definition 页说的是更精确、也更有用的一句 `[E53]`：

> "Temporal guarantees that the Activity **will be observed as completed exactly once**. However, **the Activity may be executed multiple times and may even partially complete more than once** during this process."

（「at-least-once」这个词确实出现在 Temporal 的 Local Activity / Standalone Activity / Global Namespace 等页面和官方 blog 上，但主文档选择了上面这个说法。**「对外观察到一次，实际可能跑很多次、甚至跑了一半好几次」——这才是准确的形状。**）

**而 Temporal 对崩溃窗口的描述，逐字就是我们的处境** `[E53]`：

> "The Activity function completes successfully, but the Worker crashes **just before it notifies the Temporal Service**. In this case, the Event History won't reflect the successful completion of the Task, so the Activity will be retried. If the Activity is not idempotent, this could have negative consequences, **such as duplicate charges in a payment processing scenario**."

把「payment processing」换成「模型调用」，这就是本仓库的原话。

#### 6.4.1 Temporal 推荐的那条路，对我们**是堵死的**

它的建议很明确 `[E53]`：

> "You can achieve idempotency in your application through the use of unique identifiers, known as idempotency keys… **These are enforced by the service you are calling from your Activity, not by the Activity itself.**"

**也就是说：幂等要由被调用方兑现。而我们的被调用方是 Anthropic Messages API，它没有 idempotency key。** 这一条三条独立证据都指向同一结论 `[E54]`：

1. **Messages `create` 的 Header Parameters 里只有一个可选项**（`anthropic-user-profile-id`），没有 `Idempotency-Key`。
2. **把 `llms.txt` 列出的 384 个 API 文档页全量下载后 grep `idempoten*`**：命中只有 Message Batches 的 GET 轮询端点（天然幂等）、Admin API 里「重复归档返回同样结果」那类语义描述、以及 webhook 事件体里给**入站**去重用的 `id`。**没有一处是调用方可用的 key。** 唯一正面回答这个问题的地方是 Claude Code routines 的触发端点文档，答案是否定的：
   > "**There is no idempotency key.** If a webhook caller retries, the endpoint creates multiple sessions."
3. **两个官方 SDK 里的 idempotency header 字段是死代码。** TS 侧有 `protected idempotencyHeader?: string` 和一段 `if (this.idempotencyHeader && method !== 'get')` 的发送分支，Python 侧有 `self._idempotency_header = None`——**但两边都从未被赋值**（全包 grep 无任何 `idempotencyHeader = …`）。所以那个分支恒为 false，`RequestOptions.idempotencyKey` 传了也会被丢弃。这是 Stainless 代码生成器留下的脚手架，不是可用功能。

**更糟的一条**：SDK **默认自动重试 2 次**，覆盖 connection error / 408 / 409 / 429 / ≥500，而重试时**只多带一个 `X-Stainless-Retry-Count`**（遥测用），**没有任何让重试变安全的标识** `[E54]`。

> **也就是说：一次 429 之后的自动重试，如果第一次其实已经在服务端成功了，你就付了两次钱，而且两边都不知道。**

这条直接落到本仓库：`ai@7.0.64` 的 `maxRetries` 默认也是 **2**（§4.1 实测 `[M2]`）。**这个默认现在就在生效，与要不要做 loop engineering 无关。**

#### 6.4.2 那就只能用「先记意图、再执行」

被调用方不给保证时的标准答案有一个名字：**write-ahead intent**（等价于 WAL 的 log-before-apply）。四个独立的一手来源都指向它 `[E55]`：

- **AWS 的 Durable Execution SDK** 把两种 step 语义直接定义成「checkpoint 与执行的先后顺序」，并明说即使 at-most-once per retry，端到端也要配 no-retry 才能限制成单次。
- **Restate** 的原话是把顺序讲得最清楚的一句：
  > "Generate idempotency key, persist in Restate, **register compensation** (e.g. `refund`), then do action (e.g. `charge`). **Register compensation first in case action succeeded but confirmation was lost.**"
- **Azure Durable Functions** 描述的是同一个窗口：「a failure occurs after the activity completes but before the result is recorded」。
- **Temporal 的 blog** 同论。

**落到「文件是唯一真相」上，它就是两个文件、一个顺序：**

```
steps/<key>.intent.json   ← 调用之前原子写入（临时文件 + rename）
steps/<key>.json          ← 拿到结果之后原子写入
```

**下次启动时的判据只有一条：**

| 磁盘上看到 | 含义 | 该怎么办 |
|---|---|---|
| 两个都没有 | 没开始 | 正常跑 |
| 只有 `.intent.json` | **这次调用可能已经花掉钱了，但我们没拿到结果** | **不要静默重跑——摆给读者看，让他决定** |
| 两个都有 | 做完了 | 跳过 |

**中间那一行是这一整节的产出。** 它无法被消除——被调用方不给 key，这个窗口就客观存在——**但它可以从「静默重复扣费」变成「一条读者看得见的记录」**。这与 §7.1 从 git 学到的「先记后做」是同一条纪律的两半：git 的 `done` 先写是为了**不重复执行**，`.intent.json` 先写是为了**不重复扣费**。

**这也补上了 §8 档 2 第 1 条的一个缺口**：光有 `done` 不够。`done` 记的是「这一步开始处理了」，而模型调用需要更细一格——**「这一次 HTTP 请求发出去了」**。

#### 6.4.3 一处没有调和的矛盾（照录，不解释）

**Restate 在 218 个文档页里从不说 at-least-once，它说 exactly-once。** 但它的架构页把「这一步发生了」定义为 **journal 追加达成 quorum 的那一刻**，而它自己数据库指南里的一段代码注释又承认了窗口的存在：「a very small window … where the query gets re-executed after success」`[E55]`。

**这两处描述的是不同层面**（对外的交付语义 vs 内部的执行窗口），我这里**只记录张力，不做调和**——因为对我们有用的结论不依赖它：**无论叫什么名字，那个窗口都存在，而我们的被调用方不帮忙。**

## 7. 最小可行的持久化：一步一个文件

Bazel 的 action key 见 §3.3 ③，Nix 的 derivation hash 见 §3.4，git 的实测见 §7.1，LangGraph 的 checkpoint 结构见 §6.1.1。

### 7.1 先例就在手边：`git rebase` 的中断态是一堆纯文本小文件（本机实测）

**这是整份调研里最贴合本仓库的先例**：一个多步骤、会中途停下等人、必须跨进程重启续跑的过程，而它的全部状态**就是一个目录里的十几个纯文本文件**——正好是 ADR-0011「文件是唯一真相」的形状。

实测环境：git 2.39.5（Apple Git-154），造一个必然冲突的三步 `rebase -i --onto`，停在第 1 步 `[M13]`。停下来那一刻 `.git/rebase-merge/` 的内容：

| 文件 | 字节 | 装什么 | 实测内容 |
|---|---|---|---|
| `git-rebase-todo` | 98 | **还没做的步骤** | `pick 50023bd c2` / `pick 616bcda c3` |
| `done` | 49 | **已经做完的步骤**（追加） | `pick 6ced9cf c1` |
| `git-rebase-todo.backup` | 1628 | **最初的完整计划** | 三条 pick 全在，外加注释掉的命令说明 |
| `stopped-sha` | 41 | 卡在哪一步 | `6ced9cf…` |
| `msgnum` / `end` | 2 / 2 | 进度计数 | `1` / `3` |
| `onto` | 41 | 这次 run 的输入 | 目标基点 sha |
| `orig-head` | 41 | 这次 run 的输入 | 原分支头 sha |
| `head-name` | 17 | 这次 run 的输入 | `refs/heads/topic` |
| `author-script` | 79 | 恢复时要还原的环境 | `GIT_AUTHOR_NAME=…` 等三行 |
| `interactive` | **0** | 布尔标志：**存在即为真** | 空文件 |
| `no-reschedule-failed-exec` | **0** | 同上 | 空文件 |

**整个中断态一共 2110 字节。** 目录 48K 是文件系统块的开销，真实内容两千字节出头。

**再实测一次「续跑」**：解决冲突后 `git rebase --continue`，`done` 变成两行、`git-rebase-todo` 少一行。**`todo` 和 `done` 是一对此消彼长的列表，二者之和恒等于计划。**

**四条可以直接抄的设计：**

1. **`todo` / `done` 这一对就是恢复点。** 不需要「当前指针」这种容易和真相不同步的字段——**做完一步就把它从 todo 挪进 done，一次原子的追加加截断**。要知道从哪继续，读 `todo` 第一行。
2. **`git-rebase-todo.backup` 是预设图，`done` 是执行图。** 这个对应关系是精确的：`docs/workflow.md` §9.3 要的「预设图 / 执行图 / 可 diff 的偏离度」，git 用**两个文本文件的差**就实现了 `[L1]`。而且它顺带解释了为什么要留 `.backup`——**因为 todo 是可以被人改的**（`rebase -i` 就是让人改它），改完之后你需要知道原来打算干什么。这正是 §9.4 的「图重构」。
3. **零字节文件当布尔量。** `interactive` 存在就是交互式。对「这个 run 是不是人手动触发的」这类标志，一个空文件比一个 JSON 字段更难写错，也更容易 grep。
4. **run 的输入单独存。** `onto` / `orig-head` / `head-name` 是这次 run 的参数，和进度分开放。恢复时不用重新推断输入。

#### 三条只有读源码才知道的（`sequencer.c` / `builtin/rebase.c` 的注释）

git 在源码里给每个状态文件都写了注释说明它装什么——这个做法本身就值得抄。三条超出实测所见的 `[E14]`：

**① `done` 是在处理**之前**就写的，不是之后。**

> "The rebase command lines that have already been processed. A line is moved here **when it is first handled, before any associated user actions**."

**这条纠正了我原本的直觉。** 天真的做法是「做完了才记下来」，但 git 反过来：崩在中间时，**宁可认为「这一步做过了」（然后停下来让人看），也不要认为「没做过」（然后重做一遍、产生重复副作用）**。

对我们，这正是 §4.1.1 实测到的那个问题的答案——同一份存档恢复两次，工具就执行两次。**先记后做**，把重复副作用换成「可能漏做一步，但人看得见」。这与 ADR-0011「先落文件再更新索引，顺序不能反」是同一条纪律的另一面 `[L7]`。

**② `amend` 存的不是「要做什么」，而是「世界还是不是我离开时那样」。**

> "When an 'edit' rebase command is being processed, the SHA1 of the commit to be edited is recorded in this file. When `git rebase --continue` is executed, if there are any staged changes then they will be amended to the HEAD commit, **but only provided the HEAD commit is still the commit to be edited**."

**这是整段源码里对我们最有启发的一条。** 读者在两次之间可能自己改了稿子、删了摘录、把书从书架上拿掉了。`--continue` 不能盲目接着干。

**一个可续跑的 run 必须存前置条件的指纹，而不只是「跑到第几步」。** 对 Loom：`revise` 节点续跑之前要确认 draft 还是它离开时那一版，否则应该报错等人，而不是把改动打在一篇已经被人手改过的稿子上。这一条现在不写下来，将来一定会以「agent 把我的修改覆盖了」的形式出现。

**③ `msgnum` / `end` 是给人看的，删了照样能续。**

> "The file to keep track of how many commands were already processed **(e.g. for the prompt)**."

进度显示的数据和恢复所需的数据是两回事。真正的续跑点只是 `git-rebase-todo` + `done` 这一对。**别把进度计数当成状态的一部分**——它可以随时从那两个列表重算。

**④ 「有没有没跑完的 run」的判据就是目录在不在。**

`builtin/rebase.c` 里 `rebase-merge` / `rebase-apply` 两个目录路径是常量；结束时删掉，没删掉就说明没结束 `[E14]`。**不是锁文件，不是 pid**——而这正好绕开了 §6.2 ① 那个 pid 会被回收的坑 `[L5]`。

**一条没抄的**：git 把 `author-script` 存下来是为了**还原环境**（作者名、时间戳）。对我们，对应的是「这次 run 用的是哪个模型、哪份 prompt、哪个代码版本」——DBOS 的 `workflow_status.application_version` 是同一个需求（§6.1）。**这一格不能空着**，否则一个跨版本恢复的 run 会用新代码接着老结果跑，而没有任何东西会提醒。

### 7.2 初步形状

**未定稿**（等 §3 / §6 补完再修）。一次 run 一个目录，与 ADR-0011「一条摘录一个文件夹」同构，字段取自 §6.1（DBOS 的 `operation_outputs`）与 §7.1（git）：

```
runs/<run-id>/
  plan.json         # 预设图：跑的是哪份 loom、节点与边（= git-rebase-todo.backup）
  run.json          # 触发方式、触发时刻、代码/模型版本、状态（= onto/orig-head/author-script）
  todo              # 还没跑的节点实例，一行一个
  done              # 跑完的节点实例，一行一个，追加
  steps/
    01-research.json   # { nodeId, instance, status, startedAt, endedAt, in[], out[], error? }
    02-coverage.json
  blocked           # 零字节：存在 = 卡在 gate 上等人（= interactive 那种用法）
```

**最小字段集**：`(run id, 步序号, output, error, 起止时间)` + `status` / `recovery_attempts` / `inputs` / **代码版本**。

**为什么不是一个 JSON 大文件**：ADR-0011 代价①那条规矩——「先写文件（临时目录再 `rename`，同一文件系统上原子），再更新索引；顺序不能反」`[L7]`。一步一个文件，每一步的落盘就是一次独立的原子 `rename`；一个大文件则每次都要整体重写，崩在中间就全毁。`done` 的追加同理。

---

## 8. 给结论：分档

四档，每一档都能单独停下来交付，后一档不推翻前一档。

---

**档 0 —— 先把 (B) 的预算信封补上。与 loop engineering 无关，现在就该做。**

**前提**：仓库已依赖 `ai@7.0.64`，`ToolLoopAgent` 现成。

**做**：
1. 一个累加 `steps[].usage` 的 token 预算 `StopCondition`。
2. 显式给 `timeout: { totalMs, stepMs }`——**因为查过的每一家默认都是无限**（Anthropic runner `max_iterations=None` `[E15]`、Temporal 四个超时全 ∞ `[E30]`）。
3. `stopWhen` 显式写死，别吃 `isStepCount(1)` 那个默认（它意味着「根本不循环」，会安静地什么都不做）。

4. **把 `maxRetries` 想清楚再定。** 它现在默认 **2**，而 Anthropic 侧**没有 idempotency key**——一次 429 之后的自动重试，如果第一次其实已经在服务端成功了，**就是付两次钱且两边都不知道**（§6.4）。**这个默认此刻就在生效，与做不做 loop 无关。**

**代价**：十几行 + 一条测试。

**必须写清楚的边界**：token 预算**是后置的**——`steps[].usage` 只有这一步跑完才有，所以**它拦不住超额的那一次调用，只能拦住下一次**（Pydantic-AI 的同一个问题，`[E17]`）。别把它宣传成「花不超过 N」。

---

**档 1 —— (A) 最便宜的那一种：应用开着的时候，每 N 小时跑一次 `scan`。**

**前提**：`scan` 入库幂等（§6.2 ④ 已成立，不用新做）。

**做之前先问一个问题（§2.7 的结论）**：`scan` 能不能写成**「有哪些源还没扫过」**，而不是**「上次什么时候跑的、错过了几次」**？如果能——而它几乎肯定能，因为入库幂等（§6.2 ④）——**那么下面这张表里的大半问题会自己消失**：待办在磁盘上，跟应用开没开、时钟准不准、错过几次都无关。Zotero 就是这么做的，`lastSyncTime` 只用来渲染 tooltip `[E43]`。

**做**：本机 API 进程里一个循环 + 一个 `lastRunAt` 文件 + 在启动与 `powerMonitor` 的 `resume` 上各检查一次。语义按下面这张表，全部有先例：

| 决定 | 取什么 | 依据 |
|---|---|---|
| 睡过去错过了多次 | **合并成一次补跑** | **三个独立实现同一决定**：launchd coalesce `[M5]`、Temporal `BufferOne` `[E9]`、obsidian-git `Math.max(0, diff)` `[E42]`。（**DBOS 是唯一的反例**——它每个错过的时刻各补一次 `[M6]`，因为它假设「每个周期都有独立产物」；`scan` 不是那种任务） |
| 到底补不补 | **补。** 「不补跑 = 对只开一会儿的用户功能失效」——而那正是我们的读者 | obsidian-git 把这条写成了产品承诺 `[E42]` |
| `lastRunAt` 存哪 | **机器本地，不进会同步的配置**——别的设备的时钟会污染本机调度 | obsidian-git 用 per-vault `localStorage` `[E42]` |
| 改了间隔设置 | **不触发补跑** | obsidian-git `reload()` 的注释 `[E42]` |
| 错过太久了 | **超过一个窗口就不补** | Windows 默认不补 `[E11]`；Temporal catchup window `[E9]`。**窗口取多少没人量过**（§9.2） |
| 上一次还在跑 | **跳过** | Windows 默认 `IgnoreNew`、Temporal 默认 `Skip`——两家独立同默认 `[E8][E9]` |
| 上一次卡死了 | **超过 N 小时就认定它死了**，否则它会永久挡住后面所有触发 | Windows `ExecutionTimeLimit` 默认 72 小时 `[E13]` |
| 读者自己退出应用导致中断 | **不算失败**，不报错、不停用调度 | Temporal pause-on-failure「but not Cancellation or Termination」`[E9]` |

**一个必踩的工程坑**：JS `setTimeout` 的上限是 `2147483647` ms（约 24.8 天），**超过会立即触发**。obsidian-git 在同一个文件里夹断了三次 `[E42]`。「每月一次」这个间隔就在上限之外。

**另外三条直接抄 Raycast**（§2.6）：**默认关闭**（用过一次这个功能才开）、**UI 不承诺准点**（系统会为省电挪动执行时间）、**后台出错不弹窗**（入口挂个警告图标，点进去看详情）。

**不做**：不碰 launchd、不注册开机自启、不上 cron 表达式（给「每 N 小时 / 每天几点 / 每周几」三个下拉）。

**代价**：读者不开应用就不跑。**而这一档的全部风险押在「读者多久开一次应用」上，那个数字没人量过**（§9.2 第 1 条）。所以这一档的第一件事其实是**把它记下来**——`lastRunAt` 这个文件顺带就是那份数据。

---

**档 2 —— (C) 的骨架：一次 run 落成文件，能看见、能续跑。**

**这一档是真正的分水岭**，因为它第一次引入「跑到一半」这个状态。

**做**：§7.2 那个目录结构。四条纪律，每条都有先例：

0. **模型调用要有意图日志。** 调用前原子写 `steps/<key>.intent.json`，拿到结果再写 `steps/<key>.json`。下次启动时**只有 intent 没有结果 = 这次调用可能已经花掉钱了**——摆给读者看，不要静默重跑（§6.4.2）。`done` 记的是「这一步开始了」，粒度不够细。
1. **先记后做。** 一步开始处理**之前**就写进 `done`，不是做完之后。git 的 `done` 就是这么做的 `[E14]`，理由是**宁可漏做一步让人看见，也不要重复副作用**——而 §4.1.1 实测证明重复副作用是真会发生的（同一份存档恢复两次，工具执行两遍 `[M14]`）。
2. **续跑前先验前置条件。** 存下 draft / context 的指纹，不一致就报错等人，别硬接着改。git 的 `amend` 文件就是干这个的 `[E14]`。**不写这一条，将来一定会以「agent 把我的修改覆盖了」的形式出现。**
3. **代码/模型版本进 run 记录。** DBOS 的 `workflow_status.application_version` `[M6]`、git 的 `author-script` `[E14]` 是同一个需求。
4. **判「有没有没跑完的 run」看目录在不在**，不看 pid——pid 会被回收再分配，这个坑仓库里已经踩过并写进注释了 `[L5]`。

**跳过的判据用 `done` 文件，不用时间戳，也不用内容哈希。** 时间戳有两类静默错误（§3.2 实测）；内容哈希需要「声明是真的」这个前提，而我们给不了（下面「明确不做」第 6 条）。

**代价**：多一个需要维护的磁盘格式。**但它很小**——git 的完整中断态实测 2110 字节（§7.1）。

---

**档 3 —— 图本身：边、分支、回边。**

**前提**：档 2 已经在跑，而且**已经积累了几次真实 run 的执行记录**——否则你不知道该画什么。

**做**：把 `docs/workflow.md` §9.3 那份预设图落成数据。三条来自本次调研的具体修正：

1. **边要分两种**：「先后」和「失效」。Make 的 order-only prerequisite 分了 `[E5]`，§9.3 的图没分。`gate → draft` 是先后，`draft → eval` 是失效。**混在一起，将来会出现「人重新批了一次 gate，整篇文章重写」。**
2. **环要硬报错，并且把环整条打印出来。** 学 Bazel `[E20]`，别学 Make（丢边、照跑、退出码 0，§3.2 实测）。
3. **必须有一个 `--explain`**：这一步为什么跑了 / 为什么跳过了。**它不是 debug 开关，是这个功能的一部分**——不给这个出口，读者唯一的办法是删掉整个 run 重来 `[E24][E52]`。
4. **环报错要给切边候选**，学 Turborepo（§3.6）：在 (b) 里那条闭合的边往往不是用户直接写出来的，只说「有环」他找不到。
5. **默认多跑，不默认少跑**（§3.7）：多跑一次是几次模型调用，少跑一次是「读者拿到一篇建立在旧材料上的稿子，而且没有任何东西提示他」。

**每个节点最少声明什么，见 §3.8 那张表**（`id` / `outputs` / `run` / `always` / `after`；`inputs` 可选）。**所有调模型的节点标成 `always`**——把它们当确定性的来缓存是在撒谎。

**边是声明的，不是推导的**（「明确不做」第 6 条）。但**别逐条画**——先试 Turborepo 那个形状（§3.6）：`run graph =（稿子的大纲）×（9 个节点的关系）`。大纲那张图本来就存在、从正文现算 `[L18]`，不用我们维护。

**这一档可以只做图、不做「跳过」。** GitHub Actions 就是这么干的——图做全了，按输入内容跳过一点没做（§3.5）。

**为什么线性列表不够**：n8n 官方模板 799 个随机样本，7–10 个节点的规模上纯线性只占 **35%**，而 Loom 是 9 个节点（§3.9 实测）。**这个数字不证明我们需要图，但它否掉了「做个线性列表反正够用」。**

**代价**：这是唯一一档需要自己设计数据模型的。而且 §9.2 里那条「Loom 会不会真的用上分支」到这一档才有答案。

### 8.1 明确不做，以及为什么

1. **不做可视化图编辑器——但要画只读的图。** 理由现在有三层（§3.10）：(i) 查到的五个成熟系统（Make `-p`、`bazel query --output=graph`、`nx graph`、GitHub Actions run 图、LangGraph Studio）里，图**全是只读派生视图，没有一个反例**；(ii) 唯一一个真实的撤退案例——Jenkins Blue Ocean 的 Pipeline Editor——正是从「编辑」退回「渲染」`[E49]`；(iii) 连画布优先的 n8n 自己都写着 "**The Git repository acts as the source of truth**"、"n8n can't detect conflicts on workflows" `[E50]`。
   **注意分寸**：这一条否掉的是「可编辑的画布」，不是「图」。`docs/prototype-spec.md` §3 那个只读的 Loom 抽屉恰恰是 Prefect 那句话里被肯定的东西——**图作为视图是好的，图作为约束才是问题** `[E47][L2]`。

2. **不注册 launchd job / 不开机自启。** `RunAtLoad` 被 man 页明确劝退（"should be avoided"，§2.2），`openAsHidden` 在 macOS 13+ 已经不可用（§2.5）。更根本的：**「后台静默跑模型花钱」对一个本地工具是需要显式同意的事**，不是一个默认。

3. **不上 cron 表达式。** DST 那段写在 `crontab(5)` 的 **BUGS** 标题底下（§2.3）；连 Temporal 都要专门写一句建议用 UTC「to avoid various surprising properties of time zones」`[E9]`。读者要表达的是「每周一次」「每天早上」，给三个下拉就够。

4. **不引第二个 agent 框架。** 见 §5.3。特别是**不要为了「跑到一半能存下来」而引入 OpenAI Agents SDK**——`ai` 的审批点已经实测可往返（372 字节，`[M14]`），而 OpenAI 那条路的代价是一个迭代到 1.19、二十个版本全在支持列表里的私有格式（`[M3]`）。

5. **不走 replay 式的 durable execution。** 不是因为重，是因为**它把改代码变成了迁移数据**：Temporal 官方的例子里，把两行代码换个顺序就让所有在飞实例失败 `[E27]`，而躲开它的 `patched()` 会让「workflow 不总是跑最新代码」`[E29]`。**桌面应用发版频繁、用户升级不可控，这个代价我们付不起。** 该抄的是记忆化那一支（DBOS 的 `operation_outputs`、`ai` 的审批点）。

6. **不做「从数据依赖推导边」的完整 (b)。边由声明给出，就像 §9.3 现在这样。**
   理由是两条硬的，不是偏好：
   - **Bazel 靠沙箱强制「声明是真的」** `[E23]`——「Without action sandboxing, Bazel doesn't know if a tool uses undeclared input files… **This can result in an incorrect incremental build.**」我们**不可能给节点上沙箱**：节点要读整个 library、要调云端模型。
   - **Nix 靠求值器生成声明** `[E25]`——「Nix requires that all inputs be explicitly collected in the `inputs` field」，并把「保证声明全」的责任交给上层求值器。我们**没有这样一个求值器**，因为「这一步要读哪些 context」正是 `research` / `recall` 节点要用模型去决定的事。
   
   **两条路都堵死，而 (b) 只在「声明是真的」的前提下才正确。** 强行做的结果是**静默的过期结果**——这正是 §3.2 在 Make 上实测复现出来的那两类错误。

   **补一句公道话**：还有第三条路——Nx 的**默认过度包含**（§3.7），它让 (b) 变安全，代价是几乎放弃了 (b) 的全部收益（跳过）。**所以真正的结论不是「(b) 做不了」，而是「(b) 在我们这里退化成了 (a)，那就直接写成 (a)」。** 如果将来真要收窄，`inputs` 作为一个**可选的、只用来缩小范围**的字段随时可以加——那正是 Nx 的形状。

7. **不用时间戳判断「这一步能不能跳过」。** 实测复现了两类静默错误：同秒修改漏掉、mtime 倒退给出过期结果（§3.2）。用 `done` 文件。

8. **不按内容哈希做步骤缓存。** 承接第 6 条。而且即使做了也有一个我们治不了的洞：Bazel 自己承认「不追踪 workspace 之外的工具」会导致**错误地共享缓存命中** `[E22]`，对我们的对应物就是**云端模型换了版本而 key 一个字没变**。

9. **不把 loop 跑在渲染进程里。** `toc-scan.ts` 已经是现成的反例——逐页调模型建目录，跑在 `app/react/` 里，关窗口就全丢（§6.3）。

10. **不做「重试整个 run」。** 重试的粒度是步骤。Temporal 的原话：「Retrying an entire Workflow Execution is not recommended」`[E31]`。而且仓库里已有的 `retry.ts` 给了更好的形状——**区分瞬时与永久错误**，`bad-output` 不重试（「再问一遍多半是同样的形状，白花一次钱」`[L8]`）。

11. **不承诺跨版本恢复。** 记下代码/模型版本（档 2 第 3 条），**版本不一致就报错等人**，不要自作主张接着跑。这是 §6.0 那一整节的教训用最便宜的方式兑现。

### 8.2 前后端切分

沿 ADR-0013 / ADR-0014 的既有切法，一条新缝都不开：

```
渲染侧 React           →  app/http-loom.ts（适配器，与 http-clip-store.ts 同形状）
                       →  本机 API /__loom（local-api.ts 加一条前缀路由）
                       →  领域层（纯 TS、Node 里测：图的推进、停止条件、状态迁移）
                       →  文件（runs/<run-id>/，ADR-0011 的形状）
```

三条硬要求，全部来自已有 ADR：

1. **循环跑在本机 API 那一侧，不在渲染进程。** 本机 API 在 dev 是 vite middleware、在打包是主进程里的 `http.Server`（ADR-0014）`[L13]`——两种形态下它都比窗口活得久，而渲染进程不是。
2. **一份实现，不写第二套 IPC 适配器。** ADR-0014 的原话：「每条边界都要写两份适配器……**dev 下全绿，打包后才出问题**」`[L13]`。
3. **接线必须落进可测的那一层。** ADR-0013 那张表：竖切一次暴露 7 个 bug，**6 个在 shell（接线层）**，而同期领域层 127 条测试只抓到 1 个 `[L14]`。调度、停止条件、状态迁移全是接线，必须在 Node 里可测。

另外：**外壳不 import 任何领域类型**（ADR-0003 判据）`[L15]`。Loom 页面进案头那一列，要走 `Active` 那个联合多一个分支的路子。

**一条边界澄清**：这个仓库确实有一个 Cloudflare Worker + D1（`worker/index.ts`），博客站点本身跑在上面，Cloudflare Cron Triggers 在那边是可用的。但**它碰不到本机的 library 目录**，而文件是唯一真相（ADR-0011）。所以「有服务器」在这件事上帮不上忙。

---

## 9. 数字：哪些有出处，哪些没人量过

### 9.1 有出处的（本文里全部标了来源）

见 §0 的表与各节。全部是 man 页原文、发行包源码行号、或 `gh api` / `npm view` 取回的真实数字。

### 9.2 **没有公开数据 / 没人量过 / 我没能确认的**

三类分开列。**每一条我都明确知道自己不知道，没有用估计值填空。**

#### A. 没人量过（我们自己的数）

1. **读者一周开几次这个应用、每次开多久。** 没有任何数据。**档 1 的全部风险押在它上面。** 所以档 1 的第一件事其实是把它记下来——`lastRunAt` 那个文件顺带就是这份数据。
2. **一次 `research` / `eval` 节点实际花多少 token、多少钱、多少墙钟时间。** 没量过。**所以档 0 那个 token 预算该设成多少，现在没有依据**——先做出可测量的口子，再定数字。
3. **补跑窗口该取多久**（§8 档 1 那张表里唯一没有先例可抄的格）。Windows 默认不补、Temporal 默认一年，两个极端都不适用。
4. **「卡死多久算它死了」该取多久。** Windows 取 72 小时 `[E13]`，Raycast 让它跟着 interval 走 `[E33]`，我们两条都不完全适用。
5. **eval 分数「不再提升」的阈值。** `docs/workflow.md` §6 写了规则，但没有评测集、阈值没标定过。ADR-0004 代价 2 已经承认过同一类问题 `[L16]`。
6. **我们自己的 Loom 会不会真的用上分支。** n8n 那一侧我量了（§3.9），但那是自动化工具的分布、且样本偏向「别人愿意分享的」工作流。**真实私有工作流的线性率没有公开数据。**
7. **Loom 图的「偏离度」怎么度量。** `docs/workflow.md` §11 自己列在待定里 `[L1]`。
8. **换书 / 换稿子 / 跑一次 Loom 的耗时。** ADR-0003 决策 2 已写明「那个假设还没量过」`[L16]`。

#### B. 外部没有公开数据

9. **用户配错 cron 表达式的比例。** 找了，**没有**。找到的是库自身的 DST bug 和跨实现的语义差异（§2.3.1），那不是配错率。**不要用前者冒充后者。**
10. **「可视化流程编辑器在什么情况下失败」的量化数据。** 找到的是**一个**真实撤退案例（Jenkins Blue Ocean `[E49]`）和若干官方表态，**没有任何带数字的研究**。§3.10.1 已经严格区分了 (i) 官方表态 (ii) 从业者观点 (iii) 实测数据。
11. **「Deutsch limit」不是数据。** 它是 1997 年一句自认转述的民间说法，维基百科自己归入 folklore `[E48]`。**本文没有把它当论据用，将来也不该。**

#### C. 我没能确认（查了，但没查到一手依据）

12. **Temporal 的 Heartbeat Timeout 默认值。** 该页只给了另外三个 `[E30]`。
13. **Windows `WakeToRun` 的默认值。** 所引属性页未给出。
14. **Windows 补跑那 10 分钟延迟本身带不带随机抖动。** `RandomDelay` 是 trigger 上的独立设置（默认 `PT0M`），与补跑无关 `[E11]`。
15. **Raycast 在机器睡眠 / 应用未运行时到底补不补跑。** 文档通篇没有正面回答；§2.6 里那条「不补」是**从「它只展示 last run time、从不提 missed runs」推出来的，是推断不是文档**。
16. **GNU Make 环处理的退出码在官方文档里无明文。** 我实测 3.81 是 0（`[M12]`），源码用 `error()` 而非 `fatal()` 佐证（`[E4]`），但**文档没写**。
17. **LangGraph Python 从 25 改成 10007 的时间点与理由。** 只读了 1.2.11 一个版本；10007 是质数、看着像刻意选的哨兵，但**那是我的推测，不是源码里的说法**。
18. **各家「已完成的 tool call 会不会重跑」，除 `ai` 之外都没有实测。** `ai` 那一条我跑过（`[M14]`）；其余是从数据结构推的，**没有真的做「杀进程再恢复」的实验**。
18b. **「只有 intent 没有结果」时那次调用到底成没成功——无法从本地判断。** 这不是我没查到，是它**客观不可知**：被调用方不提供 key，也不提供「这个请求我处理过没有」的查询。§6.4.2 的方案是把它变成一条读者可见的记录，**不是消除它**。
19. **Anthropic 官方对 `max_iterations` 的推荐值。** 源码默认 `None`，文档只说「if you set it」，**从没给过建议数字**。流传的「Anthropic 默认 10」不是源码里的东西——那只是文档示例里的示例值 `[E15][E46]`。
20. **Anthropic managed-agents 服务端 session 的轮数 / 时长上限。** SDK 里有 `max_iterations` 字段和 `"max_iterations_reached"` 这个终态，说明服务端确实有这个概念，但默认值查不到（由服务端决定）。
21. **`@voltagent/core` 的无服务器与文件持久化能力。** 没核实。
22. **Inngest 的机制细节。** 只确认了架构（必须有外部执行器，`[M11]`）。
22b. **Restate 的「exactly-once」与它自己承认的重执行窗口之间的张力。** 它 218 个文档页里从不说 at-least-once，但架构页把「步骤已发生」定义为 journal 达成 quorum，数据库指南的代码注释又写着「a very small window … where the query gets re-executed after success」。**两处描述的层面不同，我只照录、不调和**（§6.4.3）——结论不依赖它。
22c. **Temporal 文档内部的措辞不一致。** 普通 Namespace 在 Global Namespace 页被描述成 "at-most-once semantics for an Activity Execution"，而 blog 说默认无限重试即 at-least-once。**照录，未调和。**
23. **GitHub Actions job 的默认超时（我记得是 360 分钟）。** 没核实，不写进正文。
24. **Bazel 本地 action cache 的字节级构造是否与 REAPI proto 的 digest 完全一致。** 文档用的是 "might include" `[E19]`。
25. **Nix `hashQuotientDerivation` 的完整算法。** 没展开核对 `[E26]`。
26. **AI SDK 的 `timeout.totalMs` 触发时到底抛什么、半成品 `steps[]` 保不保留。** 读到了字段定义，**没实测触发路径**。
27. **Windows 侧的一切都没验证过。** ADR-0014 已写明「Windows 只要不引入平台特有代码就应当能构建，但**没验证过就不算支持**」`[L13]`。

## Sources

### 本仓库（路径相对仓库根）

- `[L1]` `docs/workflow.md` —— §3.10 Loop（改）、§4 七个阶段、§6 停止条件（「分数不再提升就停 / 最多 3 轮 / 取历史最佳 revision」）、§9 Loom（§9.2 封闭节点表、§9.3 预设图 JSON 与执行图实例、§9.4 图重构必须记录 cause、§9.5 `trigger: manual|cron|event`、§9.6 图与 branch、§9.7 staging、§9.8 执行语义）、§11 待定。
- `[L2]` `docs/prototype-spec.md` §3「Loom（任务即图）」—— 三模式（预设图/执行图/对照）、侧栏四块、节点状态色。
- `[L3]` `public/blog-studio-prototype.html` —— `loom_EDGE_LABEL`（`"n7>n6": "回边 · 分数提升 且 round<3"`）在 :7478 附近；`loom_all()` / `loom_edgeWalked()` 等派生函数在 :7386-7500。
- `[L4]` `pdfstudio/src/model/model-client.ts`（`ModelClient` 只有 `complete` / `streamComplete`；`ModelMessage.content: string`）；`pdfstudio/src/model/openai-compatible.ts:2,99,118`（只 import 并调用 `generateText` / `streamText`，不传 tools）。
- `[L5]` `pdfstudio/src/model/engine-registry.ts`（`EngineRecord` / `RegistryDeps.commandOf` / `reap`）+ `engine-registry-file.ts`（`running.json`、`ps -o command= -p`、`SIGKILL`）。
- `[L6]` `pdfstudio/src/model/llama-server.ts:151-153`（`const staging = \`${target}.part\``）、`:229`。
- `[L7]` `pdfstudio/docs/adr/0011-clip-storage-markdown-folder.md` —— 「文件是唯一真相，数据库是可重建的缓存」；代价①原子性与写入顺序。
- `[L8]` `pdfstudio/src/outline/retry.ts` —— `retrying()`、`transient()`、`BACKOFF_MS = 700`、默认 `tries: 3`。
- `[L9]` `contextstudio/src/context-store.ts:12-13`（幂等注释与 `ingest` 签名）、`:26-28`（`IngestReport`）、`:189-196`（`added` / `updated` 计数）。
- `[L10]` `docs/adr/0002-handover-not-shared-writes.md` —— 硬要求①「id 稳定，导入幂等」。
- `[L11]` `pdfstudio/app/react/LocalModel.tsx:24-36`（2 秒轮询 `/__engine`）；`pdfstudio/src/server/local-api.ts:109,173`（`engineStatus()` / `enginePhase`）。
- `[L12]` `pdfstudio/app/react/toc-scan.ts:68-96`（`readTocPages` 逐页循环、`retrying()`），整个文件在 `app/react/` 即渲染侧。
- `[L13]` `pdfstudio/docs/adr/0014-electron-and-shared-local-api.md` —— 共用一份本机 API；「不做签名与公证/不做自动更新/Windows 没验证过就不算支持」。另 `pdfstudio/electron/main.ts:96-120`（前缀路由、`server.listen(0, "127.0.0.1")`）。
- `[L14]` `pdfstudio/docs/adr/0013-app-layer-and-view-split.md` —— 7 个 bug / 6 个在 shell 那张表。
- `[L15]` `docs/adr/0003-one-shell-two-contexts.md` 决策 1（外壳不 import 任何领域类型）与决策 3（`Active` 联合）；`docs/adr/0004-writer-as-third-root.md` 决策 1、决策 3（「而现在还没有 Loop，只有人在编辑器里写」）。
- `[L19]` `pdfstudio/docs/adr/0005-cloud-model-user-configured.md` —— 模型端点与 apiKey 由读者自己配、自己付钱。
- `[L18]` `blogstudio/src/outline.ts` 与 `blogstudio/CONTEXT.md`「大纲 (outline)」条 —— 「正文里的标题结构，**从正文现算**，不是单独存的一份数据」。
- `[L17]` `blogstudio/CONTEXT.md`「检查 (check)」条 —— 「确定性检查……**一行模型调用都没有**，所以它随时是新的、不花钱、不需要配置。」
- `[L16]` `docs/adr/0003` 决策 2（「那个假设还没量过」）；`docs/adr/0004` 代价 2（召回阈值没量过）。

### 本机实测

- `[M1]` **仓库现状扫描**（2026-08-21）：`grep -rn "setInterval" pdfstudio/app pdfstudio/electron pdfstudio/src blogstudio/src contextstudio/src` → 0 命中（除测试）；`setTimeout` 全部是 debounce / 轮询 / 退避 / 退出兜底。`grep -o -i "loom" public/blog-studio-prototype.html | wc -l` → 324（另 `Loom` 23、`预设图` 8、`执行图` 7、`重构图` 1、`偏离度` 2、`staging` 2）。
- `[M2]` **Vercel AI SDK 源码实测**：`node_modules/ai@7.0.64`，发行包内含完整 `src/`。`src/generate-text/stop-condition.ts`（:8-12 JSDoc、:27 `isStepCount`、:37 `isLoopFinished`、:47 `hasToolCall`、:74-76 `isStopConditionMet`）；`src/generate-text/generate-text.ts`（:249 `stopWhen = isStepCount(1)`、:596-610 流式专用 timeout 的 warning、:1434-1443 `do…while`）；`src/agent/tool-loop-agent.ts:132`（`?? isStepCount(20)`）与 `tool-loop-agent-settings.ts:89`；`src/agent/index.ts:15-20`（`ToolLoopAgent` / `Experimental_Agent` 别名）；`src/generate-text/index.ts:51-58`（`stepCountIs` 已 `@deprecated`）；`src/prompt/request-options.ts:13-22`（`TimeoutConfiguration`）、:104-127（`RequestOptions`，`maxRetries` `@default 2`）；`src/generate-text/execute-tool-call.ts:162-176`（工具抛错转 `tool-error`）；`src/generate-text/tool-error.ts`；`src/generate-text/generate-text-events.ts`（事件回调清单）；`src/generate-text/tool-approval-configuration.ts:13-34`（`ToolApprovalStatus`）、`collect-tool-approvals.ts:23-38`、`resolve-tool-approval.ts:109-126`、`tool-approval-response-output.ts`。全包 `grep resume|persist|checkpoint` 只命中 `stream-text-result.ts:47`（UI 流续传）。
- `[M3]` **OpenAI Agents JS 实测**：`npm pack @openai/agents-core`（0.17.0）解包后读。`dist/runner/constants.mjs`（`DEFAULT_MAX_TURNS = 10`）；`dist/runner/turnPreparation.mjs:58-61`（`throw new MaxTurnsExceededError(..., state)`）；`dist/errors.mjs:4-24`（`AgentsError` 持有 `state`）；`dist/runState.d.ts:20-65`（版本历史注释 + `CURRENT_SCHEMA_VERSION = "1.19"` + `SUPPORTED_SCHEMA_VERSIONS` 20 项）、:8499 `toJSON`、:8510 `toString`、:8519 `static fromString`。
- `[M4]` **LangGraph.js 实测**：`npm pack @langchain/langgraph`（1.4.12）。`dist/pregel/utils/config.js:36`（`DEFAULT_RECURSION_LIMIT = 25`）、:139；`dist/errors.d.ts:36,190`（`GraphInterrupt` / `GraphRecursionError`）；`dist/interrupt.d.ts`（interrupt 靠抛异常、多 interrupt 顺序处理）。另 `npm pack @langchain/langgraph-checkpoint`（1.1.5）：`dist/base.d.ts:57-77`（`BaseCheckpointSaver` 的五个抽象方法）。
- `[M5]` **macOS launchd man 页实测**（macOS 15.7.9 / build 24G830；`man 5 launchd.plist`，man 页日期 "Darwin 30 July, 2019"）：`StartCalendarInterval` / `StartInterval` / `RunAtLoad` / `ThrottleInterval` / `WatchPaths` 各段原文见 §2.2。
- `[M6]` **DBOS Transact TS 实测**：`npm pack @dbos-inc/dbos-sdk`（4.26.10）。`package.json` 的 `dependencies`（只有 `commander, pg, serialize-error, superjson, ws, yaml`；`peerDependencies` / `optionalDependencies` 为空）；`dist/src/sysdb_migrations/migration_runner.d.ts`（`import type { ClientBase } from 'pg'`、`DBMigration.sqlite3?`、`runSysMigrationsPg`）；`dist/schemas/system_db_schema.d.ts`（`workflow_status` / `operation_outputs` / `workflow_schedules` 等表结构）；`dist/src/dbos.js:1705` 与 `dist/src/client.js:506`（`automaticBackfill ?? false`）；`dist/src/scheduler/scheduler.js:121-133`（backfill 触发条件）、:252-277（`backfillSchedule`）、:164-172（jitter）、`enqueueScheduledWorkflow`（`initWorkflowStatus` + 固定 `workflowID`、`applicationVersion`）。
- `[M7]` **Electron d.ts 实测**：`node_modules/electron@43.4.0/electron.d.ts`。全文 `grep -i "cron\|schedule"` 无调度 API；`:1758-1771` `setLoginItemSettings` 文档；`:23598+` `Settings` 接口（`openAtLogin` / `openAsHidden` `@deprecated` / `type` 四值 / `path` / `args`）；`:10898-10905` `resume`、`:10956-10963` `suspend`、`:11024-11040` `user-did-become-active`、`:11078-11084` `getSystemIdleState` / `getSystemIdleTime`。
- `[M8]` **macOS cron man 页实测**：`man 5 crontab`（macOS 15.7，man 页日期 "July 31, 2005"，AUTHORS: Paul Vixie）BUGS 段；`man 1 crontab` 的 Darwin note；`man 8 cron` 的 DESCRIPTION。
- `[M9]` **XState 实测**：`npm pack xstate`（5.32.5）。`dist/declarations/src/createActor.d.ts:153`（`getPersistedSnapshot`）、`State.d.ts:94`、`types.d.ts:664,794,904`；`dist/xstate-actors.development.cjs.js:782-795`（promise actor `start` 的 `// TODO: determine how to allow customizing this so that promises can be restarted if necessary` 与 `status !== 'active'` 提前返回）、:729-731（`getPersistedSnapshot` / `restoreSnapshot` 直通）。
- `[M10]` **候选库的真实数字**（2026-08-21 取回）：体积/版本/license 来自 `npm view <pkg> version dist.unpackedSize license time.modified`；提交数来自 `gh api "repos/OWNER/REPO/commits?since=2026-05-23T00:00:00Z&per_page=100" --paginate --jq 'length'` 求和；stars / open issues / pushed_at 来自 `gh api repos/OWNER/REPO`。原始数字见 §5.1 表。
- `[M11]` **Inngest 实测**：`npm pack inngest`（4.18.1）。`package.json` 依赖清单；`helpers/consts.js:189-191`（`defaultInngestApiBaseUrl = "https://api.inngest.com/"`、`defaultInngestEventBaseUrl = "https://inn.gs/"`、`defaultDevServerHost = "http://localhost:8288/"`）；同文件源码映射里的 `defaultMaxRetries = 3` 与 `ExecutionVersion` 枚举注释。

- `[M12]` **GNU Make 实测**（`make --version` → GNU Make 3.81，macOS 15.7.9 自带；2026-08-21）：① 环——两行 Makefile `a: b` / `b: a`，`make a` 输出 `make: Circular b <- a dependency dropped.` 后把 `b`、`a` 都跑了，`echo $?` = **0**。② 时间戳——规则 `out.txt: in.txt`，五次操作的结果见 §3.2 表；同秒 `touch` 不触发重建、隔 1.1 秒触发；`stat -f "%N %Fm"` 显示两文件 mtime 为 `1787284964.419244000` / `1787284964.443832582`（纳秒级记录，Make 3.81 只比到秒）。③ `echo v2 > in.txt; touch -t 202001010000 in.txt; make` → `is up to date`，`cat out.txt` 仍为 `v1`。脚本与样本在本次会话 scratchpad 的 `mk/`。

- `[M13]` **git rebase 中断态实测**（git 2.39.5 / Apple Git-154，2026-08-21）：临时仓库造三个 commit 的 topic 分支与一个冲突的 main，跑 `git rebase -i --onto main HEAD~3` 停在第 1 步。`.git/rebase-merge/` 的文件清单、字节数与内容见 §7.1 表（`cat .git/rebase-merge/* | wc -c` = **2110**）。随后解决冲突 `git rebase --continue`，实测 `done` 由 1 行增至 2 行、`git-rebase-todo` 由 2 行减至 1 行。脚本与仓库在本次会话 scratchpad 的 `gitr/`。

- `[M14]` **AI SDK 审批暂停点往返实测**（`ai@7.0.64` + `ai/test` 的 `MockLanguageModelV3`，Node v24.18.0，2026-08-21）：工具声明 `needsApproval: true`，`stopWhen: isStepCount(10)`。第 1 次 `generateText` 后 `executed.length === 0`、`content` 含 1 个 `tool-approval-request`；`JSON.stringify(result.response.messages)` 长 **372** 字节；把该 JSON 写盘后重新读入、追加一条 `tool-approval-response` 再调用，模型累计调用 2 次、`executed === ['hello']`。第四段用同一份存档二次恢复，`executed === ['hello','hello']`。脚本 `approval-roundtrip.mts` 在本次会话 scratchpad。

- `[M15]` **n8n 官方模板库图形态实测**（2026-08-21）：数据源 `https://api.n8n.io/api/templates/workflows?page=N&rows=100`（列表，返回 `totalWorkflows: 11629`）与 `https://api.n8n.io/api/templates/workflows/<id>`（详情，图在内层 `workflow.workflow.{nodes,connections}`）。翻完全部列表页取得全部 id，固定 seed 20260821 随机抽 800，成功 799（1 个 404）。排除 `n8n-nodes-base.stickyNote`。指标定义：branch = 某节点出边总数 >1 或 `main` 下多于一个非空 output index；merge = 某节点的 distinct source >1；cycle = DFS 中出现指向递归栈内节点的边；purely linear = 全部节点入度 ≤1 且出度 ≤1 且无环。主口径只算 `main` 连接；对照口径含全部连接类型时纯线性降至 17.0%。结果见 §3.9。

- `[E27]` Temporal「Workflow Definition」：<https://docs.temporal.io/workflow-definition>（Command/Event 的对位重放；intrinsic non-determinism；「会产生 Command 的 API 调用」清单；改代码导致 nondeterminism error 的完整例子；安全改动白名单）。检索日 2026-08-21。
- `[E28]` Temporal 各语言的 workflow 约束清单：<https://docs.temporal.io/develop/java/workflows/basics>（Java 的完整 requirements 列表）、<https://docs.temporal.io/develop/go/workflows/basics>（Go 明确点名 `range` 遍历 map 不可用，及 `workflow.Now()` / `workflow.Sleep()` / `workflow.Go()` 替换表）。
- `[E29]` Temporal Patching：<https://docs.temporal.io/patching>（`patched()` 四种情形的行为；"does not always run the newest code"；"always put the newest code at the top of an if-patched-block"）。
- `[E30]` Temporal「Detecting Activity failures」：<https://docs.temporal.io/encyclopedia/detecting-activity-failures>（四个超时的语义与默认 ∞；"We strongly recommend setting a Start-To-Close Timeout."；心跳的定义、payload 续跑、取消只在心跳点送达、节流默认 30s/60s）。
- `[E31]` Temporal Retry Policies：<https://docs.temporal.io/encyclopedia/retry-policies>（默认 Initial Interval 1s / Backoff 2.0 / Max Interval 100× / **Max Attempts ∞**；workflow 默认不重试）。
- `[M16]` **Dify 工作流形态实测**（2026-08-21）：Dify 无公开模板 API，改测三个 GitHub 语料仓库（`svcvit` / `bingyue` / `aircrushin`）共 162 个 DSL YAML，有效 154 个。linear 62.3% / branch 37.7% / merge 20.1% / cycle 0.0%（**该 0% 为表示法假象**，Dify 用 `iteration` / `loop` 容器节点而非回边；`iteration` 出现率 16.9%）。**社区精选语料，与 `[M15]` 的官方全库随机样本不可直接比较。** 脚本与原始样本在本次会话 scratchpad。

### 外部一手来源

- `[E15]` `anthropic-sdk-python` v1.0.0，`src/anthropic/lib/tools/_beta_runner.py`（`BaseToolRunner.__init__` L66-73 的 `max_iterations: int | None = None`；`_should_stop` L122-125；`__run__` L166-199；`_generate_tool_call_response` L226-281 的 `except Exception` 与 `is_error`；`append_messages` L104-118）；`src/anthropic/types/beta/beta_stop_reason.py`（`end_turn` / `max_tokens` / `stop_sequence` / `tool_use` / `pause_turn` / `compaction` / `refusal` / `model_context_window_exceeded`）；`src/anthropic/lib/tools/_beta_session_runner.py`（`TOOL_TIMEOUT = 150.0`、`DEFAULT_MAX_IDLE = 60.0`）。<https://github.com/anthropics/anthropic-sdk-python/blob/v1.0.0/src/anthropic/lib/tools/_beta_runner.py>
- `[E16]` `anthropic-sdk-typescript` v0.120.0，`src/lib/tools/BetaToolRunner.ts`（`max_iterations?: number` 无默认；`while (true)` 内 `if (this.#state.params.max_iterations && …) break` 的 falsy 短路；`generateToolResponse` 的 `catch` → `is_error`；`await Promise.all(toolUseBlocks.map(...))` 并行；`BetaToolRunnerRequestOptions` 的 `Pick` 里**没有** `'timeout'`）。<https://github.com/anthropics/anthropic-sdk-typescript/blob/sdk-v0.120.0/src/lib/tools/BetaToolRunner.ts>
- `[E17]` `pydantic-ai` v2.32.2，`pydantic_ai_slim/pydantic_ai/usage.py`（`UsageLimits` L418-472，`request_limit` 默认 50，其余默认 None；`count_tokens_before_request` 默认 False；`_warn_if_cost_unavailable` L528-536）；`pydantic_ai/exceptions.py` L459 `UsageLimitExceeded`；`pydantic_ai/agent/__init__.py` L1516（`usage_limits or UsageLimits()`）、L505/L610-612（`tool_timeout` 默认 None）；`pydantic_ai/durable_exec/{temporal,dbos,prefect}/`。<https://github.com/pydantic/pydantic-ai/blob/v2.32.2/pydantic_ai_slim/pydantic_ai/usage.py>
- `[E18]` Bazel query 语言参考（"the graph implicitly defined by all rule declarations in all BUILD files"；§Cycles in the dependency graph；`--output graph`）：<https://bazel.build/query/language>
- `[E19]` Bazel Glossary（`Label` / `Dependency` / `Action` / `Action graph` / `Target` / `Action cache` / `Action key`）：<https://bazel.build/reference/glossary>；`deps` 属性定义 <https://bazel.build/reference/be/common-definitions>
- `[E20]` Bazel 环报错实现与格式：`src/main/java/com/google/devtools/build/lib/skyframe/AbstractLabelCycleReporter.java`（`Event.error` + `"cycle in dependency graph:"`）；官方测试断言的完整格式见 `src/test/java/com/google/devtools/build/lib/analysis/CircularDependencyTest.java`。<https://github.com/bazelbuild/bazel>
- `[E21]` Remote Execution API v2 proto：`build/bazel/remote/execution/v2/remote_execution.proto`（`message Action` 的 `command_digest` / `input_root_digest` / `timeout` / `salt` 注释；`message Command` 的 `arguments` / `environment_variables` / `output_paths`；`message Digest`）。<https://github.com/bazelbuild/remote-apis>
- `[E22]` Bazel 远程缓存文档（两类数据、`--action_env` 白名单、"Bazel does not track tools outside a workspace"）：<https://bazel.build/remote/caching>；缓存命中比对 <https://bazel.build/remote/cache-remote>
- `[E23]` Bazel 沙箱文档 §Reasons for sandboxing：<https://bazel.build/docs/sandboxing>
- `[E24]` Bazel 用户手册 `--explain`：<https://bazel.build/docs/user-manual>；hermeticity <https://bazel.build/basics/hermeticity>
- `[E25]` Nix Reference Manual（显示版本 2.34.9）「Derivation」：<https://nix.dev/manual/nix/stable/store/derivation/index.html>（inputs specification 与「rather than somehow scanning all the other fields for inputs」那段）
- `[E26]` Nix store path 规范：<https://nix.dev/manual/nix/stable/protocols/store-path.html>、<https://nix.dev/manual/nix/stable/store/store-path.html>、input-addressed 输出 <https://nix.dev/manual/nix/stable/store/derivation/outputs/input-address.html>
- `[E32]` GitHub Actions `schedule` 事件：<https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>（原文出自 <https://github.com/github/docs/blob/main/data/reusables/actions/schedule-delay.md>）——高峰延迟与丢弃、公开仓库 60 天无活动自动停用、不支持 `@daily` 等非标准写法。检索日 2026-08-21。
- `[E33]` Raycast Background Refresh：<https://developers.raycast.com/information/lifecycle/background-refresh>（文档源文件 <https://github.com/raycast/extensions/blob/main/docs/information/lifecycle/background-refresh.md>）——`interval` 字段与最小 `10s`、调度不精确与电池、超时随 interval 动态调整以防重叠、默认关闭、错误以警告图标呈现、共享状态需防御式编程。检索日 2026-08-21。
- `[E34]` `node-schedule` 的 DST 问题：<https://github.com/node-schedule/node-schedule/issues/267>（合并了 #11 / #131 / #132 / #214 / #208；"caused downtime for us two years running now"；`nextInvocationDate()` 的 `while (true)`）；<https://github.com/node-schedule/node-schedule/issues/132>（2015，3AM CPU 100%）。
- `[E35]` `node-cron` 的 DST 问题：<https://github.com/node-cron/node-cron/issues/509>（2026-03，DST 切换小时内日志刷屏 + CPU 飙升）；<https://github.com/node-cron/node-cron/issues/174>（2019，系统时区过 DST 即出错，与目标时区无关）；文档化 DST 行为的 PR <https://github.com/node-cron/node-cron/pull/604>。
- `[E36]` GitHub Actions workflow 语法 `jobs.<job_id>.needs`：<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>（失败/跳过沿依赖链传播；`always()` / `!cancelled()` / `failure()` 的语义）。检索日 2026-08-21。
- `[E37]` GitHub Actions 依赖缓存：<https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching>（`key` / `path` 为必填、由用户书写；"On a cache miss, the action automatically creates a new cache if the job completes successfully."）与 <https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching>（"a job should always be able to re-download or regenerate these files if a cache isn't available."）。
- `[E38]` GitHub Actions 可视化图：<https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph>。
- `[E39]` Turborepo「Configuring tasks」：<https://turborepo.dev/docs/crafting-your-repository/configuring-tasks>（`dependsOn` 的三种写法与 `^` microsyntax 的定义）。检索日 2026-08-21。
- `[E40]` Turborepo 环检测实现：`crates/turborepo-graph-utils/src/lib.rs`（`Error::CyclicDependencies` / `SelfDependency`；`validate_graph` 里 "The cycle can be broken by removing any of these sets of dependencies:" 的提示构造）。<https://github.com/vercel/turborepo>
- `[E41]` LangGraph Python `1.2.11`，`langgraph/_internal/_config.py:32`：`DEFAULT_RECURSION_LIMIT = int(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))`；超限抛 `GraphRecursionError`（`langgraph/errors.py:67`，继承内建 `RecursionError`），触发点 `langgraph/pregel/main.py:3002-3010`；`_loop.py` 里 `self.stop = self.step + config["recursion_limit"] + 1`（计的是 superstep）。<https://github.com/langchain-ai/langgraph/blob/1.2.11/libs/langgraph/langgraph/_internal/_config.py>
- `[E42]` `Vinzent03/obsidian-git`：`docs/Features.md`（"The interval works across Obsidian sessions…"）与 `src/automaticsManager.ts`（`diff()` 的 `Math.max(0, diff)`；per-vault `localStorage` 键 `obsidian-git:lastAutoBackup`；`reload()` 注释「This does not calculate any differences to last autos or commits」；三处 `if (time > 2147483647) time = 2147483647;`）。<https://github.com/Vinzent03/obsidian-git>
- `[E43]` Zotero：官方同步文档（"whenever changes are made"、"within a few seconds"）<https://www.zotero.org/support/sync>；源码 `chrome/content/zotero/xpcom/sync/syncRunner.js`（`_editTimeout` / `_idleTimeout` / `_backTimeout`、`Zotero.serial` 与 `_syncInProgress` 双保险、`_queueSyncOptions` 去重）与 `syncEngine.js`（`libraryVersion` / `storageVersion` 两个独立版本号及其注释、失败退避表 `_syncQueueIntervals`）。<https://github.com/zotero/zotero>
- `[E44]` OpenAI Agents SDK Python `0.22.0`：`src/agents/run_error_handlers.py`（`RunErrorHandlers` 的三个 key、`RunErrorData` / `RunErrorHandlerResult`）与 `src/agents/run.py`（超限时先解析 handler、`if handler_result is None: raise`）；`DEFAULT_MAX_TURNS = 10` 在 `src/agents/run_config.py:44`（`run.py` 只 re-export）。<https://github.com/openai/openai-agents-python/blob/v0.22.0/src/agents/run_error_handlers.py>
- `[E45]` LangGraph Python `1.2.11`：`langgraph/runtime.py`（`RunControl.request_drain()`）与 `langgraph/errors.py`（`GraphDrained` 的 docstring：「stopped cooperatively at a superstep boundary … The checkpoint is saved and the run can be resumed later.」）。另 `langgraph/types.py` 的 `Durability = Literal["sync","async","exit"]`，`pregel/main.py` 文档写默认 `"async"`。
- `[E46]` Anthropic 官方文档「Tool runner (SDK)」：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner>（"The runner loops until Claude returns a message without a tool use, or until it reaches `max_iterations` **if you set it**."；工具异常转 `is_error`；compaction 段落与「deprecated this client-side option in favor of server-side context editing」）。检索日 2026-08-21。
- `[E47]` Prefect / Airflow 的立场：Prefect《You Probably Don't Need a DAG》(2023-08-07) 的 "Most data engineers think of a DAG as a visualization of their workflow graph… You don't need to define a DAG, though, to create a workflow graph."；Prefect《Our Second-Generation Workflow Engine》(2021-10-05)。Airflow PMC 关于「UI 不做 DAG 编辑」是 conscious choice 的表态。**注意：不存在标题为「The DAG is dead」的 Prefect 官方文章——那是社区转述，未能确认。**
- `[E48]` 「Deutsch limit」的来源追溯：维基百科条目（归入 `Category:Computer programming folklore`）→ comp.lang.visual FAQ Q12（最早可读版 1997-01-02，原文自认是 "Deutsch said something like…"，且同页紧接着就是反驳）。**民间传说，非研究结论。** Brooks《No Silver Bullet》全文不含此句（PDF grep，"Deutsch" 零命中）。
- `[E49]` Jenkins Blue Ocean Pipeline Editor 的 **Deprecated** 状态与推荐替代品（Stage View / Graph View 等只读渲染 + 语法片段生成器）：<https://plugins.jenkins.io/blueocean-pipeline-editor/>
- `[E50]` n8n 官方源码控制文档「Merge behaviors and conflicts」：<https://docs.n8n.io/source-control-environments/understand/>（"n8n can't detect conflicts on workflows."；"The Git repository acts as the source of truth."；"you shouldn't view n8n's source control as full version control"）。另有三个仍开放且被团队 triage 的 source-control 漂移类 issue（#34292 / #34528 / #34529）。**注意：n8n 的 GitHub tracker 只收 bug，功能请求会被机器人秒关并导流论坛——所以「GitHub 上搜不到 diff 抱怨」不构成反证。**
- `[E51]` Retool Toolscript 文档："Retool recommends you not modify Toolscript files directly"；YAML → Toolscript 的动机 "to simplify code review"。<https://docs.retool.com/apps/toolscript>
- `[E52]` Nx：`inputs` / `namedInputs` 的默认全包与其理由（"…but it ensures that by default, Nx always re-runs the task when it should"）、`dependsOn` 相对手写依赖列表的论证（"would duplicate information already available in the project graph…"）、环处理（默认 `process.exit(1)` 打印 `a --> b --> a`；`NX_IGNORE_CYCLES=true` 降级 warn 并 `makeAcyclic()`，实现为 `deps.splice(idx, 1)`）、`nx graph` 的定位（"It always stays up to date without having to actively maintain a document"）。<https://nx.dev> 与 <https://github.com/nrwl/nx>
- `[E53]` Temporal Activity 的执行语义与幂等：<https://docs.temporal.io/activity-definition>（"observed as completed exactly once… may be executed multiple times and may even partially complete more than once"；Worker "crashes just before it notifies the Temporal Service" 的边界案例；"idempotency keys… **are enforced by the service you are calling from your Activity, not by the Activity itself**"）。**注意：主 Activity 文档页并不使用 "at-least-once" 一词**；该词出现在 Local Activity / Standalone Activity / Global Namespace / Glossary 等页与官方 blog。检索日 2026-08-21。
- `[E54]` Anthropic 没有 idempotency key，三条独立证据：① Messages `create` 的 Header Parameters 只有可选的 `anthropic-user-profile-id`（<https://platform.claude.com/docs/en/api/messages>）；② 把 `https://platform.claude.com/llms.txt` 列出的 384 个 `/docs/en/api/**` 页全量下载后 grep `idempoten*`，无任何调用方可用的 key，唯一正面表述在 <https://platform.claude.com/docs/en/api/claude-code/routines-fire>：「**There is no idempotency key.** If a webhook caller retries, the endpoint creates multiple sessions.」；③ 两个官方 SDK 的 idempotency header 字段是 Stainless 脚手架死代码——TS 的 `protected idempotencyHeader?: string` 与其 `if (this.idempotencyHeader && method !== 'get')` 发送分支、Python 的 `self._idempotency_header = None`，**全包 grep 无任何赋值**，故永不发送。SDK 默认自动重试 **2** 次（connection error / 408 / 409 / 429 / ≥500），重试只附加 `X-Stainless-Retry-Count`。
- `[E55]` write-ahead intent（先记意图、再执行）的四个一手来源：AWS Durable Execution SDK 文档（按「checkpoint 与执行的先后」定义两种 step 语义、at-most-once per retry 需配 no-retry）；Restate 文档「Generate idempotency key, persist in Restate, register compensation…, then do action… **Register compensation first in case action succeeded but confirmation was lost.**」；Azure Durable Functions（"a failure occurs after the activity completes but before the result is recorded"）；Temporal 官方 blog。另 Restate 内部张力：架构页把「步骤已发生」定义为 journal 追加达成 quorum，而其数据库指南的代码注释承认「a very small window … where the query gets re-executed after success」。
- `[E8]` Windows 任务计划程序 `MultipleInstancesPolicy`：<https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element>（Restricted Values 里 `IgnoreNew` 行自带 "Default."）；枚举定义 <https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_instances_policy>（`TASK_INSTANCES_PARALLEL/QUEUE/IGNORE_NEW/STOP_EXISTING` = 0/1/2/3）。检索日 2026-08-21。
- `[E9]` Temporal Schedules（Overlap Policy 六值与默认 `Skip`、Catchup Window 默认一年/最小十秒、pause-on-failure、jitter、时区建议 UTC）：<https://docs.temporal.io/schedule>；文档源码逐字可核对 <https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/schedule.mdx>。检索日 2026-08-21。
- `[E10]` Windows `RestartOnFailure` / `RestartInterval`：<https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element>、<https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartinterval>（"The maximum time allowed is 31 days, and the minimum time allowed is 1 minute."；`Count` 为 `unsignedByte`）。
- `[E11]` Windows `StartWhenAvailable`：<https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable>（"The default is False."；"The default delay is 10 minutes."）；schema 侧 `default="false"` <https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-startwhenavailable-settingstype-element>；`RandomDelay` 默认 `PT0M` <https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-randomdelay-calendartriggertype-element>。
- `[E12]` Temporal 排障文档「Schedule missed actions」：<https://docs.temporal.io/troubleshooting/schedule-missed-actions>。
- `[E13]` Windows `ExecutionTimeLimit`：<https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit>（"By default, a task will be stopped 72 hours after it starts to run."）。
- `[E14]` git 源码里对 rebase 状态文件的注释：<https://github.com/git/git/blob/master/sequencer.c>（`rebase_path_todo` / `rebase_path_done` / `rebase_path_msgnum` / `rebase_path_msgtotal` / `rebase_path_stopped_sha` / `rebase_path_amend` 各自的注释，约 L75-L212）；状态目录常量 <https://github.com/git/git/blob/master/builtin/rebase.c>（约 L50-L53）；`interactive` 空文件的写与读 <https://github.com/git/git/blob/master/wt-status.c>；后端差异见 <https://github.com/git/git/blob/master/Documentation/git-rebase.adoc>「Miscellaneous differences」。检索日 2026-08-21。
- `[E4]` GNU Make 手册 Errors 附录（`Circular xxx <- yyy dependency dropped.` 条）与实现 `src/remake.c`（`error()` 而非 `fatal()`；把 `d` 从 `file->deps` unlink）。来源：GNU Make **4.4.1** 官方 tarball <https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz> 内的 `doc/make.texi` 与 `src/remake.c`（检索日 2026-08-21；`gnu.org` 网页版本环境不可达，故取 tarball）。
- `[E5]` 同上 tarball，`doc/make.texi` §4.3「Types of Prerequisites」（order-only prerequisites）。镜像：<https://docs.w3cub.com/gnu_make/prerequisite-types>
- `[E6]` 同上 tarball，`doc/make.texi` §4.6「Phony Targets」。镜像：<https://docs.w3cub.com/gnu_make/phony-targets>
- `[E7]` 同上 tarball，`doc/make.texi` §9.7「Options Summary」的 `-p, --print-data-base`。
- `[E3]` GNU Make 手册「Generating Prerequisites Automatically」（§4.14）。**`gnu.org` 网页版在本次环境不可达**；引文取自两处一致来源：官方 tarball make-4.4.1 的 `doc/make.texi`，与 w3cub 镜像 <https://docs.w3cub.com/gnu_make/automatic-prerequisites>（检索日 2026-08-21）。
- `[E1]` Mastra 官方文档「Suspend and Resume」：<https://mastra.ai/docs/workflows/suspend-and-resume> —— "When a workflow is suspended, its current execution state is saved as a snapshot."；"Snapshots are stored in your configured storage provider and persist across deployments and application restarts."（检索日 2026-08-21）
- `[E2]` Mastra 官方文档「Storage」：<https://mastra.ai/docs/server-db/storage> —— libSQL 的 `url: 'file:./mastra.db'`；"The default in-memory store is useful for tests and short local experiments, but it loses data when the process exits."；"Workflows: Durable snapshots for suspended and resumed workflow runs."（检索日 2026-08-21）

> **未收录**：Restate 与 Inngest 的官方文档（本轮没查到定稿所需的深度，见 §9.2）。

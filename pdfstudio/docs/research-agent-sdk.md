# 调研：为 PDF Studio 嵌入 agent 的 SDK / 框架选型

> 一句话结论：**基础层（现在用）选 Vercel AI SDK**；它最贴合 local-first 打包应用 +
> 用户自配 OpenAI 兼容端点的约束，且 agent 原语（tool loop、streaming、subagent、
> MCP、tool approval）已内置。**OpenAI Agents SDK (JS) 是接近的备选**。
> 多 agent 编排层（Blog Studio 的 Loom）是**另一个待定决策**——留到做 Loom 时，
> 在「LangGraph JS」与「在 AI SDK 原语上自建领域图」之间选；Loom 的设计本身（§9.2
> 节点类型是封闭集合、图要可 diff 可重构）意味着没有现成框架能直接满足，最终都要自建一层。

数据采集于 2026-08，全部来自一手源（npm / PyPI registry、GitHub 仓库与 LICENSE、官方文档）。

---

## 1. 背景与约束

来自现有 ADR 与设计文档：

- **ADR-0005**：模型调用走**用户配置的一个 OpenAI 兼容端点**（base URL + API key + model），
  默认 GPT。代码直连模型，不经服务器代理。选型必须「一套代码同时覆盖云端与本地」。
- **ADR-0006**：PDF Studio 是 **local-first** 的跨平台应用（后续 Tauri 打包），核心循环本地完成、
  不依赖服务器。agent SDK 必须能跑在打包产物里（Tauri/Electron 的 Node sidecar 或 webview），
  不能要求独立服务进程 / Docker / 托管平台。
- **Blog Studio workflow（Loom，§9）**：未来要把「research → coverage → gate → draft → eval → revise」
  组织成**一张可调度、可执行、可重构的图**。今天选的基础层要能长到那里去。
- **architecture.md**：`ModelClient` 已是真缝（HTTP adapter + mock adapter），
  是模型调用唯一的对外端口。agent SDK 的 model 层应当落到这条缝后面。

因此「现在要的」是：一个能跑 tool loop、有 streaming、工具可注入、模型可换的**基础循环**；
「以后要的」是：多 agent 图编排的**可行路径**，而不是今天就背上一个重编排框架。

---

## 2. 评估标准与权重

前三条权重最高（各 30%），后两条各 5%。

| # | 标准 | 说明 |
|---|---|---|
| 1 | **可嵌入性**（30%） | 能打进 Tauri/Electron 打包产物；纯 library，不要求独立 server / Docker / 托管平台 |
| 2 | **OpenAI 兼容端点**（30%） | 支持用户自配 base URL + key + model；不被锁定到单一 vendor |
| 3 | **语言**（30%） | TypeScript 优先（App 是 React/TS）；Python-only 直接标红 |
| 4 | **基础质量**（5%） | 活跃维护、文档、streaming、tool use、模型无关性、到多 agent 的可行路径 |
| 5 | **现在轻、以后可扩展**（5%） | 起步负担小；能力可渐进加上 |

---

## 3. 方法

- npm registry（`registry.npmjs.org`，含 install-v1 缩写元数据与 downloads API）、PyPI JSON API。
- GitHub API（stars / forks / pushed_at / license）与仓库内一手文件（README、LICENSE、
  `pyproject.toml`、源码如 `langchain-openai/src/chat_models/base.ts`）。
- 官方文档站（ai-sdk.dev、openai.github.io/openai-agents-js、本机 pi SDK 的 `docs/sdk.md`
  与 `docs/models.md` / `docs/custom-provider.md`）。

不使用任何 blog 汇总或第三方「best of」列表。

---

## 4. 候选速览（一手数据）

| 候选 | 包 / 版本 | 语言 | License | stars | 周下载 | 运行要求 | 关键依赖数 |
|---|---|---|---|---|---|---|---|
| **Vercel AI SDK** | `ai@7.0.64`（`@ai-sdk/openai-compatible@3.0.30`） | TypeScript | Apache-2.0 | 26,160 | 20.56M | Node ≥22 | `ai` 核心 3（+ zod peer） |
| **OpenAI Agents SDK** | `@openai/agents@0.15.0`（Py `openai-agents@0.20.0`） | TypeScript / Python | MIT | JS 3,578 · Py 28,602 | 1.55M | Node ≥22 | 5（+ zod peer） |
| **pi coding agent SDK** | `@earendil-works/pi-coding-agent@0.84.1` | TypeScript | MIT | 89,046（monorepo） | 1.65M | Node ≥22.19 | 21 |
| **Mastra** | `@mastra/core@1.58.0` | TypeScript | Apache-2.0（`ee/` 为商业许可） | 27,160 | 1.34M | Node ≥22.13 | 32 |
| **LangGraph JS** | `@langchain/langgraph@1.4.9` | TypeScript | MIT | JS 3,198 · Py 39,590 | 3.24M | Node ≥18 | 4（+ `@langchain/core`、zod peer） |
| **smolagents** | `smolagents@1.26.0`（PyPI） | **Python** | Apache-2.0 | 28,790 | — | Python ≥3.10 | 53 |
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk@0.3.231` | TypeScript | Anthropic 商业条款 | 1,692 | — | Node ≥18（需 Claude Code CLI） | 0（子进程调 CLI） |
| **CrewAI** | `crewai@1.15.15`（PyPI） | **Python** | MIT | 57,015 | — | Python 3.10–3.13 | 56 |
| **OpenHands** | `openhands-ai@1.11.0`（PyPI） | Python 核心（前端 TS） | MIT | 83,881 | — | Python ≥3.12 + Docker | 85 |

---

## 5. 逐候选分析

### 5.1 Vercel AI SDK —— 推荐（基础层）

- **可嵌入（✓）**：纯 TS library，`generateText` / `streamText` / `ToolLoopAgent` 在任意 Node 环境运行；
  已被 React / Node / Expo / Svelte 等前端栈官方覆盖。`ai` 核心仅 3 个依赖，最轻。
- **OpenAI 兼容（✓✓）**：`@ai-sdk/openai-compatible` 提供 `createOpenAICompatible({ name, baseURL, apiKey })`，
  直接匹配 ADR-0005 的「base URL + key + model」。官方还给出 custom provider 完整指南
  （`OpenAICompatibleChatLanguageModel` 等基类 + Language Model Spec）。已有 app 的 `ModelClient`
  可以就是这层 provider 的生产 adapter。
- **语言（✓）**：TypeScript，第一等。
- **基础质量（✓）**：Apache-2.0；26k stars、20.56M 周下载（全候选最大）；文档最全。
  agent 层 v7 已是一等公民：`ToolLoopAgent`（loop + 上下文管理 + `stopWhen`/`prepareStep`）、
  subagents、workflow patterns、`WorkflowAgent`（durable/resumable，`@ai-sdk/workflow`）、
  MCP、tool approval（human-in-the-loop）、`HarnessAgent`（可驱动 Claude Code / Codex / **Pi**）。
  streaming、structured output、middleware、telemetry 全有。
- **轻量/可扩展（✓）**：核心极轻，能力按需从 `@ai-sdk/*` 增量引入。
- **注意点**：文档默认入口是 Vercel AI Gateway（托管），但只是默认值——provider 完全可换。
  v7 的 agent/workflow 层较新、仍在演进；它不是声明式图引擎（见 §7）。

### 5.2 OpenAI Agents SDK (JS) —— 紧邻的备选

- **可嵌入（✓）**：纯 TS，无 server 依赖；README 标注支持 Node / Deno / Bun。
- **OpenAI 兼容（✓）**：`OpenAIProvider({ baseURL })` 支持任意 OpenAI 兼容端点
  （Chat Completions 与 Responses 两种 API，可用 `setOpenAIAPI('chat_completions')` 切到本地服务都支持的
  Chat Completions）；也可注入自建 `OpenAI` client。
- **语言（✓）**：TypeScript（Python 版更成熟，但 JS 版是官方一等公民）。
- **基础质量（✓）**：MIT；官方维护、活跃（2026-08 仍在发布）。**多 agent 是一等公民**：
  handoffs、agents-as-tools、guardrails、sessions、human-in-the-loop、tracing、MCP、sandbox agents。
  轻量（5 依赖）。
- **轻量/可扩展（✓/△）**：很轻；但生态与心智默认偏向 OpenAI 味（默认模型 GPT-5.x、Responses API、
  hosted tools / tracing UI），与「用户自配本地端点」的默认路径略有摩擦（需显式切到 chat_completions）。
  JS 仓库 0.x、社区远小于 Python 版与 AI SDK。

### 5.3 pi coding agent SDK —— 模型兼容最深的特殊项

- **可嵌入（△）**：TS，SDK 明确「embed pi in other applications」，有 `createAgentSession`、
  `SessionManager.inMemory()`、事件订阅。但它是**编码 agent** 的循环（read/bash/edit/write 工具），
  且包体带 TUI、client、telemetry、`@silvia-odwyer/photon-node`（WASM）等与 PDF Studio 无关的重量。
- **OpenAI 兼容（✓✓）**：**全候选最深的兼容层**。`models.json` / `registerProvider` 声明
  `api: "openai-completions"` + `baseUrl` + `apiKey`，并有一整套 `compat` 旗标
  （`supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField`、`thinkingFormat` 等），
  对 Ollama / vLLM / SGLang 这类「半兼容」本地服务是真实卖点。
- **语言（✓）**：TS。
- **基础质量（✓）**：MIT，monorepo 89k stars、1.65M 周下载、活跃；streaming（text_delta /
  thinking_delta / tool 事件）、自定义工具（`defineTool`）、会话树/分支、compaction、retry 都齐。
- **多 agent / 编排（△）**：有 subagent 扩展例子（spawn 子会话），但**没有图 / checkpoint /
  手递手（handoff）类编排原语**。Loom 的 graph 要全部自建。
- **结论**：模型兼容与 agent loop 质量高，但「编码 agent」定位 + 重量级包体对 PDF Studio
  是错配；仅当希望复刻 pi 的 loop 语义时才值得。

### 5.4 LangGraph JS —— 未来编排层的头号候选（不是现在的基础层）

- **可嵌入（△）**：纯 TS、MIT、可跑在 Node；但它是**编排框架**而非 agent SDK——没有内置
  tool loop，得自己组装（或用 `createReactAgent` / Deep Agents 预构建件），起步负担最大。
- **OpenAI 兼容（✓）**：经 LangChain 模型集成；`@langchain/openai` 的 `ChatOpenAI` 支持
  `configuration.baseURL`（源码 `base.ts` L529），任意 OpenAI 兼容端点可用。
- **语言（✓）**：TS（与 Python 版同 API 家族，Python 版 39.6k stars、生态更厚）。
- **基础质量（✓）**：MIT；durable execution（checkpoint）、human-in-the-loop（`interrupt`）、
  memory、streaming；「can be used without LangChain」。
- **与 Loom 的贴合度（✓✓）**：Loom §9 的「task 即 graph + 节点 + 边 + gate + 回边」与
  LangGraph 的 `StateGraph` / checkpoint / interrupt 一一对应。**这是 Loom 编排层的最强现成底座。**
- **结论**：现在不选它做基础层（太底层、要自己搭 loop）；做 Loom 时它是首选候选（见 §7）。

### 5.5 Mastra —— 能力全但重、偏 server 产品

- **可嵌入（△）**：TS，可嵌入 React/Node；但定位是「standalone server / Mastra Studio / Mastra Cloud」，
  `@mastra/core` 32 依赖（含 `posthog-node` 遥测、`@a2a-js/sdk`、MCP server），Node ≥22.13，偏重。
- **OpenAI 兼容（✓）**：底层包 Vercel AI SDK providers，故 `createOpenAICompatible` 可用。
- **多 agent / 编排（✓）**：Agents + 图式 Workflows（`.then`/`.branch`/`.parallel`）+
  suspend/resume（storage 支撑的 human-in-the-loop）+ evals + observability，是 TS 里最接近
  「现成多 agent 编排」的框架。
- **结论**：能力与 Loom 目标最重叠，但「现在轻」不满足、偏 server/平台化；若 Loom 阶段想买现成
  编排+可观测，它才进入候选。

### 5.6 其余（Python-only 或形态不符，标红）

- **smolagents**（Python）：模型无关性好（LiteLLM，支持 `api_base` 指向 OpenAI 兼容端点）、
  核心 ~1000 行、Apache-2.0、28.8k stars——但 **Python-only**，需 sidecar 进程 + IPC，直接违背标准 3。
- **CrewAI**（Python）：57k stars、企业级 role-playing 编排，56 依赖，重且 Python-only。
- **Claude Agent SDK**（TS 但锁定）：0 依赖但**靠子进程调 Claude Code CLI**，绑定 Claude 模型
  （走 `ANTHROPIC_BASE_URL` 也只能到 Anthropic 兼容代理），受 Anthropic 商业条款约束、采集反馈遥测。
  违背标准 2，且要在打包产物里塞一个 CLI 二进制。
- **OpenHands**（Python + Docker）：已转向「Agent Canvas」自托管控制中心，agent 跑在
  Docker / VM / agent-server 后端。85 依赖、要求 Python ≥3.12 + Docker——**是产品不是可嵌入 library**，
  与 Tauri 打包形态完全不符（与「可嵌入性」标准冲突最严重）。

---

## 6. 对比矩阵

| 候选 | ① 可嵌入 | ② OpenAI 兼容端点 | ③ TypeScript | ④ 基础质量 | ⑤ 轻→可扩展 | 综合 |
|---|---|---|---|---|---|---|
| **Vercel AI SDK** | ✓ | ✓✓ | ✓ | ✓ | ✓ | **最推荐** |
| OpenAI Agents SDK (JS) | ✓ | ✓ | ✓ | ✓ | ✓ | 备选 |
| pi coding agent SDK | △ | ✓✓ | ✓ | ✓ | △ | 特定场景 |
| LangGraph JS | △ | ✓ | ✓ | ✓ | △（起步重/编排强） | 编排层候选 |
| Mastra | △ | ✓ | ✓ | ✓ | ✗（重） | Loom 阶段再看 |
| smolagents | ✗（sidecar） | ✓ | ✗ Python | ✓ | △ | 否 |
| CrewAI | ✗ | ✓ | ✗ Python | △ | ✗ | 否 |
| Claude Agent SDK | ✗（CLI 子进程） | ✗ 锁定 | ✓ | △ | ✗ | 否 |
| OpenHands | ✗（Docker/产品） | ✓ | ✗ Python 核心 | ✓ | ✗ | 否 |

---

## 7. 结论与推荐

1. **现在（PDF Studio 基础层）选 Vercel AI SDK。**
   理由：三个高权重标准全部拿满——纯 TS 可嵌入（最轻）、`@ai-sdk/openai-compatible`
   精确命中 ADR-0005、社区与文档全候选最强；agent 原语（`ToolLoopAgent`、streaming、
   tool call、MCP、tool approval、subagents）现在够用且不多余。
   落地方式：agent 循环跑在打包产物的 Node sidecar（或 Electron main）里，
   模型请求从既有 `ModelClient` 缝发出——`ModelClient` 的生产 adapter 用
   `createOpenAICompatible({ baseURL, apiKey })` 实现，测试 adapter 保持不变。

2. **OpenAI Agents SDK (JS) 是紧邻备选**——若更想要「开箱即用」的 handoffs / guardrails /
   tracing，可换它；代价是更 OpenAI 味的默认路径与较小的 JS 社区。

3. **pi SDK 是特殊项**：OpenAI 兼容深度（`compat` 旗标）无出其右，但「编码 agent」定位 +
   TUI/telemetry/WASM 包体对 PDF Studio 是错配；除非要复刻 pi 的 loop 语义，否则不选。

4. **明确没有现成框架能直接满足 Loom**：Loom §9 要求「图本身是第一类对象、可 diff、可对齐、
   重构要记 cause」——这是领域设计，不是任何编排框架的内置能力。因此 Loom 编排层是**另一个
   待定决策**，两条路线届时二选一：
   - **(a) 自建领域图**（在 AI SDK 原语 + 持久化上实现 Loom 节点/边/gate/回边）——最贴合
     Loom §9.2「节点类型封闭、领域词」的设计意图，且与今天的基础层一致；
   - **(b) 换/加 LangGraph JS 做图引擎**——若想要现成的 checkpoint / interrupt / durable execution，
     Loom 的节点与 gate 可映射到 `StateGraph` + `interrupt`，代价是引入 LangChain 生态与更多抽象。
   **倾向 (a)**，理由：Loom 的图 diff / 对齐 / cause 记录是框架给不了的、本来就要自建；
   自建时把 AI SDK 的 model/tool 原语嵌进节点即可，避免两层抽象叠加。

5. **可立即排除**：smolagents / CrewAI（Python-only）、Claude Agent SDK（锁定 + CLI 子进程 +
   商业条款）、OpenHands（Docker/产品形态）、Mastra（现在太重、偏 server）。

---

## 8. 附录：一手数据来源

- npm registry：`ai@7.0.64`、`@ai-sdk/openai-compatible@3.0.30`、`@openai/agents@0.15.0`、
  `@earendil-works/pi-coding-agent@0.84.1`、`@mastra/core@1.58.0`、`@langchain/langgraph@1.4.9`、
  `@anthropic-ai/claude-agent-sdk@0.3.231`；downloads API（2026-08-09 周窗口）。
- PyPI：`openai-agents@0.20.0`、`smolagents@1.26.0`、`crewai@1.15.15`、`openhands-ai@1.11.0`。
- GitHub（stars / pushed_at 采于 2026-08-13）：`vercel/ai`、`openai/openai-agents-js`、
  `openai/openai-agents-python`、`earendil-works/pi`、`mastra-ai/mastra`、
  `langchain-ai/langgraphjs`、`langchain-ai/langgraph`、`huggingface/smolagents`、
  `anthropics/claude-agent-sdk-typescript`、`crewAIInc/crewAI`、`OpenHands/OpenHands`。
- 关键文件：`vercel/ai/LICENSE`（Apache-2.0）、`mastra-ai/mastra/LICENSE.md`（Apache-2.0 + ee/ 商业许可）、
  `langchain-ai/langchainjs/libs/providers/langchain-openai/src/chat_models/base.ts`（`configuration.baseURL`）、
  `openai/openai-agents-js/docs/.../guides/models.mdx`（`OpenAIProvider({ baseURL })`）、
  OpenHands `README.md`（Agent Canvas / Docker / VM 后端）、smolagents `README.md`（LiteLLM、CodeAgent）。
- pi SDK 一手文档（本机安装）：`docs/sdk.md`、`docs/models.md`（`api: "openai-completions"` + `compat`）、
  `docs/custom-provider.md`（`registerProvider` / `openAICompletionsApi`）。
- Vercel AI SDK 官方文档：`ai-sdk.dev/docs/agents/overview.md`（ToolLoopAgent / subagents /
  WorkflowAgent / HarnessAgent）、`ai-sdk.dev/providers/openai-compatible-providers/custom-providers.md`。

# ADR-0007：Vercel AI SDK 作为 Agent / Model 基础层

## 状态

Accepted

## 背景

PDF Studio 需要一个可以逐步长成完整 agent 的基础层，未来 Blog Studio 的自动化流程也要复用这套基础能力。当前应用是 TypeScript/React 的 local-first packaged app，模型由用户配置 OpenAI-compatible `URL + key + model`，因此基础层必须可嵌入、支持 streaming 和 tool loop，并且不能把业务模块锁定到某一家模型供应商或某个 SDK 的对象模型。

候选方案包括 OpenHands、OpenAI Agents SDK、pi agent SDK、Vercel AI SDK、LangGraph JS 等。研究结果见 `research-agent-sdk.md`。

## 决策

**选择 Vercel AI SDK 作为 Agent / Model 的基础实现层。**

它负责提供可替换的底层能力，例如 model provider、text generation、streaming、tool loop、structured output 和后续需要的 agent primitives。当前先使用其中最小必要子集，不提前引入完整 workflow 或 multi-agent graph。

业务模块仍然只依赖 PDF Studio 自有的 `ModelClient`、`ModelRequest`、`ModelResponse` 和 `ModelChunk` 契约。Vercel AI SDK 的类型、agent class、provider object、workflow state 和 tool-loop state 不得泄漏到 `Recognizer`、`Chat`、`Clip`、`KnowledgeBase` 或 Blog Studio 的领域 interface。

生产 adapter 将用户配置转换为 Vercel AI SDK provider；测试使用确定性的 `ModelClient` fake。未来若 SDK、provider 或 agent loop 需要替换，变更限制在 adapter 和 agent infrastructure 层。

## 边界

- 本 ADR 选择的是**基础实现层**，不是 PDF Studio 的领域 agent interface。
- `Agent`、`Chat`、`Recognizer` 的输入、输出和状态由业务模块自己拥有。
- 当前不锁定 `ToolLoopAgent`、`WorkflowAgent` 或任何具体 SDK class 的长期使用方式。
- Blog Studio 的 Loom graph 是另一个决策。等真实 graph workflow 出现后，再决定在 Vercel AI SDK 原语上自建领域图，还是引入 LangGraph JS 等编排实现。
- 用户的 API key 只存在应用系统数据目录，通过 runtime 配置传入 adapter，不进入源码或构建产物。

## 后果

正面结果是：现在可以用轻量 TypeScript 基础层完成 streaming 和 tools，同时保留未来更换模型 provider、SDK 或编排实现的空间。代价是我们需要维护一层自己的 `ModelClient` adapter，并自行定义长期稳定的 agent 领域契约。

## 参考

- `pdfstudio/docs/research-agent-sdk.md`
- ADR-0005：用户配置 OpenAI-compatible 模型端点
- ADR-0006：local-first packaged app

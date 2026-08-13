# Chat 前端技术栈研究 — PDF Studio 问文档 UI（流式 + Markdown/LaTeX + 引用 + 附件）

- **范围：** PDF Studio「问文档（chat）」的 UI 层选型，三个问题：① chat UI 基础（消息列表、气泡、copy/regenerate/stop、附件、可点击引用）；② Markdown 渲染（**含公式/LaTeX**——内联 + 展示数学、KaTeX/MathJax）与代码高亮，以及**流式半成品 markdown 与半成品公式**的处理；③ 客户端直连 OpenAI 兼容端点的流式（SSE/ReadableStream）消费。
- **硬约束（ADR-0005/0006）：** 应用**直接从客户端调模型**——用户配置的 OpenAI 兼容端点（base URL + API key + model name），key 存在应用本地 config JSON，**不经任何服务器代理**。所以选型必须能在浏览器/Tauri 里直连模型，或提供不用 Next.js route handler 的消费方式；**凡默认假设服务器 route 的东西都要标记出来**。
- **方法：** 仅用一手来源——npm registry 元数据（`registry.npmjs.org/<pkg>/latest`）、官方文档的 markdown 镜像（`ai-sdk.dev` 的 `.md` 页与 `llms.txt`、`assistant-ui.com` 的 `.md` 页与 `sitemap.md`、`katex.org`/KaTeX 仓库的 `docs/options.md`）、官方源码仓库 README 与源码（`vercel/ai`、`vercel/streamdown`、`remarkjs`、`micromark`、`openai/openai-node`、`openai/openai-openapi`、`shadcn-ui/ui`）。没有博客总结，没有第三方基准聚合站。
- **检索时间：** 2026-08-13。
- **引用键：** `[S1]…[S48]` 对应 [Sources](#sources) 里的 URL。没有引用的论断是我自己的分析，不是一手来源事实。

> ⚠️ 环境说明：任务里提到的包名与现版本一致（Vercel AI SDK 已在 v7，`useChat` 从 `@ai-sdk/react` 导出；`streamText` 在 `ai` 核心包）。Vercel 另出了一个专门为 AI 流式渲染设计的 markdown 库 **Streamdown**（本文 2.2），不在任务点名的名单里，但对「流式 + 数学」这个核心需求是决定性的一手发现。

---

## 问题 1 — Chat UI 基础

三个候选：**Vercel AI SDK**（`useChat`/`streamText` + React hooks）、**assistant-ui**（shadcn 风格的 chat 组件 + runtime）、**shadcn/ui 原语**（自己搭）。

### 1.1 Vercel AI SDK

现版本（npm registry）：`ai@7.0.64`、`@ai-sdk/react@4.0.67`、`@ai-sdk/openai@4.0.41`、`@ai-sdk/openai-compatible@3.0.30`，全部 Apache-2.0 `[S1][S2][S3][S4]`。

`useChat`（`@ai-sdk/react`）开箱给的东西 `[S5]`：

- **消息流式**：chunk 实时进 `messages`；
- **托管状态**：`status`（`submitted` / `streaming` / `ready` / `error`）、输入、消息、错误；
- **`stop()`**（中止 fetch）、**`regenerate()`**（重生成最后一条）、**`setMessages`**（改历史/删除）；
- **附件**：`sendMessage({ text, files })` 把 `FileList`/file object 自动转 data URL 并作为多模态 part 发出 `[S5]`；
- **回调**：`onFinish` / `onError` / `onData`；`throttle` 选项限流渲染 `[S5]`。

**但它的默认布线假设一个服务器 route**。官方示例的 `useChat` 配 `DefaultChatTransport({ api: '/api/chat' })`，对应一个 `app/api/chat/route.ts`，里面 `streamText` + `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })` `[S5]`。`useChat` 与端点之间讲的是 **AI SDK 自己的 UI message stream 协议**（`start`/`text-delta`/`finish` 等 part），不是 OpenAI chat completions 协议——所以**不能把 `api` 直接指到 OpenAI 端点**，必须有一个讲这套协议的服务器（或自己实现 transport）。

无服务器的官方出路有三条 `[S6][S7][S8][S10]`：

1. **`streamText` 直接在浏览器跑**：AI SDK Core 的环境兼容表明确写 "Any JS environment (e.g. Node.js, Deno, Browser)" `[S8]`。`streamText({ model })` 返回 `result.textStream`，"both a `ReadableStream` and an `AsyncIterable`"，支持 `abortSignal` 取消 `[S7]`。配 `@ai-sdk/openai-compatible` 的 `createOpenAICompatible({ baseURL, apiKey })` 就直连用户配的端点 `[S9]`——**这条路完全不用服务器**，代价是**丢掉了 `useChat` 的状态管理**（status/stop/regenerate/setMessages 全部要自己用 `useState` + `AbortController` 手写）。
2. **`DirectChatTransport`**（`useChat` 的 transport）：文档明说面向 "Single-process applications"（"Desktop or CLI apps where client and agent run together"），不进 HTTP、直接调 agent 的 `stream()` `[S6][S10]`。但它的 `agent` 参数是**必需的、类型是 `Agent`**（如 `ToolLoopAgent`）`[S10]`——纯聊天也被迫套上 agent/tool-loop 抽象，比需要更重。
3. **自定义 transport**：实现 `ChatTransport` 接口（文档指路到 `default-chat-transport.ts` / `chat-transport.ts` 源码）`[S6]`。可行但属于「自己写胶水」。

**小结（AI SDK）：** 引擎（`streamText` + provider）在浏览器可用、能直连 OpenAI 兼容端点 `[S7][S8][S9]`；但「React 状态管理 + 流式 UI」这一层（`useChat`）默认长在服务器 route 上，客户端直连要么退到 `streamText` 自己管状态，要么套 agent 抽象、要么自写 transport。**三选一都有可见成本。**

### 1.2 assistant-ui

现版本：`@assistant-ui/react@0.15.14`（MIT）、`@assistant-ui/react-ai-sdk@1.4.5`、`@assistant-ui/react-markdown@0.14.10`、`@assistant-ui/react-streamdown@0.3.10` `[S11][S12][S45][S46]`。

架构三大支柱 `[S13]`：

1. **Frontend components** —— shadcn 风格 chat 组件（thread、message、composer、action bar、attachment 等），自带状态管理；
2. **Runtime** —— 状态管理层，把 UI 接到 LLM/后端；
3. **Assistant Cloud** —— 可选的托管持久化（thread/history/用户），**不是必需**。

关键事实一：assistant-ui 架构文档**明确画了「Direct Integration with External Providers」这条线**——`Frontend Components → Runtime → External Providers / LLM APIs`，即**不经后端、客户端直连模型是官方支持的一等形态** `[S13]`。

关键事实二：assistant-ui 有两条 runtime 路线，**选哪条决定了是否被迫上服务器 route**：

- **`useChatRuntime`（`@assistant-ui/react-ai-sdk`）**：就是 Vercel AI SDK `useChat` 的包装（peer/deps 直接是 `ai@^7` + `@ai-sdk/react@^4`）`[S12]`，其 quickstart 同样要求一个 `app/api/chat/route.ts` 里跑 `streamText` `[S15]`。**选了它就继承了 1.1 的服务器假设。**
- **`LocalRuntime`（`useLocalRuntime`）**：**不依赖 AI SDK**。你只实现一个 `ChatModelAdapter.run()`（一个函数），runtime 替你管 "messages, threads, branching, editing, regeneration, cancellation" `[S14]`。官方文档原话："Quickest path to a working chat. Handles state while you handle the API." `[S14]`

`LocalRuntime` 的流式写法是 `async *run` 生成器，**每轮 yield 全量累计文本**（不是 delta），官方示例就是直接 `new OpenAI().chat.completions.create({ stream: true, signal: abortSignal })` + `for await` 逐 chunk 累计 `[S14]`。**这正好是 ADR-0005 的形态**：`abortSignal` 支持 stop；把 `baseURL` 指成用户配置的 OpenAI 兼容端点（或干脆复用 PDF Studio 已有的 `ModelClient` 端口）即可，无需任何服务器 route。

附件是 assistant-ui 的一等特性：内建 image/text attachment adapter（base64 data URL、拖拽/粘贴、vision 模型），`useChatRuntime` 下开箱即用，`LocalRuntime` 下配 adapter 即可 `[S19]`。

**小结（assistant-ui）：** 三个候选里**唯一提供「官方、客户端直连模型、且带完整 chat 状态机」的一手路径**（`LocalRuntime`）。代价：它是一套 shadcn 风格的组件体系（Radix + zustand + Tailwind），要按它的方式装组件（`npx shadcn@latest add …`），且样式绑定 shadcn 设计 token。当前仓库是 Tailwind v4 + React 19、**尚未引入 shadcn/ui**，所以这是「引入一套组件体系」而非「引入一个 hook」。

### 1.3 shadcn/ui 原语

shadcn/ui 的 registry 里确有 chat 相关 building block：`message`、`message-scroller`、`attachment`、`bubble`、`item`、`questionnaire`、`marker` `[S43]`。但看 `message.tsx` 源码：纯 `React.ComponentProps<"div">` 的展示组件（`Message`/`MessageAvatar`/`MessageContent`/`MessageHeader` + Tailwind class），**没有 streaming、没有 fetch/model、没有 markdown/math、没有状态机** `[S44]`。它只是「气泡长什么样」，流式/状态/模型调用/SSE 解析全要自己写。

### 1.4 对比（一手）

| 轴 | Vercel AI SDK `useChat` | assistant-ui（`LocalRuntime`） | shadcn/ui 原语 |
| --- | --- | --- | --- |
| 消息列表/气泡 | 只给 state，UI 自己写 `[S5]` | 预置组件（thread/message/composer/action bar）`[S13]` | 只有气泡样式 `[S44]` |
| 流式状态机 | `useChat` 给（status/stop/regenerate/setMessages）`[S5]` | runtime 给（branching/editing/regeneration/cancellation）`[S14]` | 无，自己写 |
| **客户端直连模型** | 默认**要服务器 route** `[S5]`；直连需退 `streamText` 或 `DirectChatTransport`(须 Agent) 或自写 transport `[S6][S7][S10]` | **一等支持**（`LocalRuntime` + `ChatModelAdapter.run()`）`[S13][S14]` | 无模型层 |
| 附件/图片 | `sendMessage({files})` 转 data URL `[S5]` | 内建 adapter（image/text、粘贴/拖拽）`[S19]` | 只有 `attachment` 样式 `[S43]` |
| copy/regenerate/stop | `stop()`/`regenerate()` 内建 `[S5]` | 内建（action bar + runtime）`[S14]` | 自己写 |
| 引入成本 | 轻（几个包） | 重（shadcn 组件体系 + zustand + radix）`[S11]` | 最轻但功能最少 |

### 1.5 建议 — 问题 1：**assistant-ui `LocalRuntime` 为主选；AI SDK `streamText` 直连为轻量备选；`useChat` 不用**

- **主选 assistant-ui（`LocalRuntime`，不是 `useChatRuntime`）**：需求清单（气泡列表、copy/regenerate/stop、附件/粘贴图片、可点击引用）里，只有 assistant-ui 把这些状态机**开箱**给齐，同时提供一个**官方、客户端直连模型**的单一 seam（`ChatModelAdapter.run()` 生成器 + `abortSignal`）`[S14]`。这个 seam 可以套在 PDF Studio 已有的 `ModelClient` 端口上（或直接指 OpenAI 兼容 baseURL），不引入服务器 route，正好落在 ADR-0005/0006 的约束里。
- **轻量备选 AI SDK `streamText`（浏览器）+ 自己 `useState` 管消息列表**：如果不想引入 shadcn 组件体系，就用 `streamText` + `@ai-sdk/openai-compatible` 直连 `[S7][S9]`，自己实现 status/stop/regenerate（`abortSignal` 已内建 `[S7]`）。功能要自己写，但薄、且与仓库「复用 `ModelClient` 端口」的既有哲学一致。
- **明确不用 `useChat`（`@ai-sdk/react`）的默认形态**：它默认假设服务器 route `[S5]`，客户端直连的官方出路要么套 `Agent`（`DirectChatTransport` 的 `agent` 是必填 `[S10]`）要么自写 transport，都比上面两条更绕。除非将来真有同步服务器，`useChat` 的价值才兑现。

---

## 问题 2 — Markdown + LaTeX

**硬需求：内联 + 展示数学（公式是 PDF Studio 的主食）、代码高亮、流式半成品也能平稳渲染。**

### 2.1 `react-markdown` + `remark-math` + `rehype-katex` + `KaTeX`（事实标准组合）

现版本：`react-markdown@10.1.0`（MIT，peer `react >=18`，兼容 React 19）`[S26]`；`remark-math@6.0.0`（remark 插件，解析/序列化 math，dep `micromark-extension-math`）`[S27]`；`rehype-katex@7.0.1`（rehype 插件，"transform inline and block math with KaTeX"，dep `katex`）`[S28]`；`katex@0.18.4`（MIT，"Fast math typesetting for the web"）`[S29]`。

- **分隔符**：`micromark-extension-math` 的 `singleDollarTextMath` 默认 `true`——`$...$` 内联、`$$...$$` 展示 `[S31]`。**注意**：很多模型发的是 `\(...\)` / `\[...\]`，remark-math 默认不认，需要预处理（见 2.4）`[S16]`。
- **KaTeX 需要 CSS**：remark-math 的 README 明说 "KaTeX requires CSS to render correctly"，要 `import 'katex/dist/katex.min.css'` `[S48]`。
- **错误处理决定流式是否崩**：KaTeX `throwOnError` **默认 `true`**——遇到不支持的指令/非法 LaTeX 直接抛 `ParseError`；设 `false` 则把非法 LaTeX 按源码渲染（红色 `errorColor`，默认 `#cc0000`）而不是抛 `[S30]`。**流式时一个没闭合的 `$$...$$` 就是「非法 LaTeX」，默认会抛**——这是整条 react-markdown 链上唯一会在流式时炸的点，且它不来自 react-markdown 而是来自 KaTeX。
- `react-markdown` 本身是**同步重解析**：每 render 一次就把整段 markdown 走 `unified`（remark-parse → remark-rehype → hast-to-jsx）`[S26]`。它**没有**任何「流式半成品」处理——半成品 markdown 能否渲染、半成品公式是否崩，全由调用方决定（要么缓冲、要么 `throwOnError:false`，见 2.4）。

### 2.2 Streamdown（Vercel 专为 AI 流式设计的 `react-markdown` 替代品）

**这是本次研究最重要的非名单内发现。** `streamdown@2.5.0`（Apache-2.0，Vercel 官方），npm 描述 "A drop-in replacement for react-markdown, designed for AI-powered streaming" `[S21]`；README 第一句 "when you tokenize and stream it, new challenges arise. Streamdown is built specifically to handle the unique requirements of streaming Markdown" `[S22]`。它同时是 Vercel AI SDK "AI Elements" 的 `Message` 组件背后的渲染器 `[S22]`。

它对三个硬需求的对应：

- **数学**：`@streamdown/math@1.0.2` 插件，dep 就是 `katex` + `remark-math` + `rehype-katex` `[S23]`——**底层引擎仍是 KaTeX**，只是把 `remark-math`/`rehype-katex`/CSS 打包成 `plugins={{ math }}` 一个开关。
- **代码高亮**：`@streamdown/code@1.1.1` 插件，dep `shiki` `[S24]`，开箱 Shiki 双主题。
- **流式半成品**：核心依赖 **`remend@1.3.0`**（"Self-healing markdown. Intelligently parses and styles incomplete Markdown blocks"）`[S25]`，可配 `remend.katex: true` 自动补全未闭合的 `$$equation$$`、`remend.links/images/bold/italic/inlineCode/strikethrough` 等 `[S17]`。
- 另有 `@streamdown/cjk`（中文/东亚文本处理）`[S17]`——对中文输出的答案正文直接相关。

assistant-ui 把两者都包好了：`@assistant-ui/react-markdown`（react-markdown 路线，轻、自带 `SyntaxHighlighter` 挂点）与 `@assistant-ui/react-streamdown`（Streamdown 路线，重、内建 Shiki/KaTeX/Mermaid）`[S20][S46]`。对照表见官方文档 `[S17]`：

| Feature | react-markdown | react-streamdown |
| --- | --- | --- |
| Bundle | 更小 | 更大（带插件） |
| 语法高亮 | 自带高亮器 | 内建 Shiki |
| 数学 | 手工配 | 内建 KaTeX |
| 流式 | `smooth` prop | `mode` + block-based |

### 2.3 备选：MDX / markdown-it / marked

- **MDX（`@mdx-js/mdx@3.1.1`）**：是「markdown + JSX」的**编译/创作**格式（dep 一堆 recma/estree 编译链）`[S37]`。对**运行时渲染模型流式输出**是错工具——它解决的是「作者在 markdown 里写组件」，不是「把 LLM 吐的半成品 markdown 安全地渲染进 React」。数学也得自己接 remark-math/rehype-katex，且多一层 JSX 编译。不选。
- **markdown-it@15.0.0 / marked@18.0.9**：纯 parser `[S35][S36]`。数学需要另装插件（markdown-it 的 mathjax/katex 插件、marked 的 katex 扩展），且**都没有流式半成品处理**。它们比 unified/remark 生态更薄，但数学生态是 remark 系的事实标准（remark-math/rehype-katex 都在 remarkjs 组织下 `[S27][S28]`），marked 里没有等价的一手级方案。

### 2.4 流式半成品 markdown 与数学的处理（三个可叠加的机制）

1. **`throwOnError: false`（KaTeX）**：未闭合公式按红色源码显示而不是抛，流式全程不崩、闭合后自动变正常 `[S30]`。这是「数学流式不炸」的最低成本开关，任何路线都要做。
2. **`useSmooth` 缓冲（assistant-ui）**：`MarkdownTextPrimitive` 的流水线是 `preprocess`（分隔符归一化）→ `useSmooth`（逐字符累积）→ parser；官方明确说 "a partially received delimiter is accumulated in the smoothing buffer rather than parsed mid fragment"，即**半截分隔符不进 parser** `[S16]`。react-streamdown 的 `smooth` prop 同款 `[S17]`。
3. **`remend`（Streamdown）**：半成品语法自动补全，含 `katex: true` 补 `$$…$$` `[S17][S25]`。
4. **分隔符归一化（模型往往不按 remark-math 的方言写）**：`@assistant-ui/react-markdown` 导出 `normalizeMathDelimiters`（把 `\(...\)`/`\[...\]` 改写成 `$...$`/`$$...$$`）与 `escapeCurrencyDollars`（保护 `$5` 这类货币），经 `preprocess` prop 在 parser 之前跑 `[S16]`。这是「模型输出格式杂」的现实工程需要，react-markdown 原生态没有。

### 2.5 代码高亮（顺带）

- **shiki@4.4.3**（MIT）`[S32]`，`react-shiki@0.11.1`（dep shiki）`[S33]`，`rehype-pretty-code@0.14.5`（peer shiki）`[S47]`，`react-syntax-highlighter@16.1.1`（Prism + highlight.js，较重、双引擎）`[S34]`。
- assistant-ui 推荐 `react-shiki` 并给了关键流式技巧：**消息还在流式时渲染纯文本（不高亮），等 part settle 再 tokenize**，省 CPU `[S18]`。Streamdown 路线则内建 Shiki `[S24]`。

### 2.6 建议 — 问题 2：**KaTeX 做数学引擎（无争议）；渲染层推荐 Streamdown，react-markdown 为轻量备选**

- **数学引擎选 KaTeX，不是 MathJax**：所有一手路线（remark-math→rehype-katex `[S28]`、`@streamdown/math` `[S23]`、assistant-ui 的 LaTeX guide `[S16]`）最终都落在 KaTeX 上；MathJax 在这套生态里没有一等公民地位。KaTeX 是纯静态、无运行时脚本，适合 local-first 打包 `[S29]`。
- **渲染层：Streamdown（`@assistant-ui/react-streamdown` 或裸 `streamdown`）是「流式 + 数学」的直接答案**——它专为流式半成品而生（`remend` 自愈 + KaTeX + Shiki + CJK 开箱）`[S21][S22]`，且和问题 1 的 assistant-ui 主选天然同栈 `[S17]`。若想更薄，`react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `throwOnError:false` 是成熟保守的组合 `[S26][S27][S30]`，但要自己处理半成品（缓冲/归一化）。
- **必须做的最小集（无论选哪个渲染层）**：① `import 'katex/dist/katex.min.css'` `[S48]`；② KaTeX `throwOnError: false` `[S30]`；③ 分隔符归一化（`normalizeMathDelimiters` 或自写）处理 `\(...\)`/`\[...\]` `[S16]`。
- **不用 MDX**（创作格式，不是运行时流式渲染器）`[S37]`；markdown-it/marked 无流式处理、数学生态弱于 remark 系，不选 `[S35][S36]`。

---

## 问题 3 — 流式：客户端消费 OpenAI 兼容端点的 SSE

**事实锚点：** OpenAI 兼容端点的流式是 `text/event-stream`，token 以 data-only SSE（`data: {…}`）逐条下发，以 `data: [DONE]` 收尾 `[S42]`。

各库的处理方式：

| 库 | 怎么处理 | 客户端直连是否干净 |
| --- | --- | --- |
| **AI SDK `@ai-sdk/openai-compatible`** | `createOpenAICompatible({ baseURL, apiKey, fetch, ... })`，provider 内部完成 fetch + SSE 解析 + `textStream` 产出；`includeUsage` 支持流式 usage `[S9]`。配合 `streamText`（浏览器可用 `[S8]`）就是客户端直连 | ✅ 干净，且 baseURL/key 正好映射 ADR-0005 |
| **`openai` 官方 SDK** | `openai.chat.completions.create({ stream: true })` 返回可 `for await` 的流（assistant-ui `LocalRuntime` 官方示例即此 `[S14]`） | ⚠️ **浏览器默认禁用**：SDK 检测到浏览器环境会抛，必须显式 `dangerouslyAllowBrowser: true` `[S38][S39]`（Tauri 的 WebView 同理，要开这个开关） |
| **`eventsource-parser`** | "Streaming, source-agnostic EventSource/SSE parser"，零依赖，从 `ReadableStream` 喂 `data:` 帧解析 `[S40]` | ✅ 若已自写 `ModelClient` HTTP adapter、只想补 SSE 解析，这是最小件 |
| **`@microsoft/fetch-event-source`** | 带 fetch 全部能力（POST + header + abort）的 EventSource `[S41]` | ✅ 备选，功能比原生 `EventSource`（只支持 GET）强 |
| **assistant-ui `LocalRuntime`** | 不规定传输：`ChatModelAdapter.run()` 里你爱用什么用什么（OpenAI SDK / 原生 fetch + 自解析 / AI SDK provider），`async *` yield 累计文本即可 `[S14]` | ✅ 传输无关，最灵活 |

**要点：**

- 若采纳问题 1 的主选（assistant-ui `LocalRuntime`），流式消费发生在 `ChatModelAdapter.run()` 这个**你自己写**的函数里——它跟渲染层/状态层解耦，所以第 3 问实际上被第 1 问吸收：run 里用 `@ai-sdk/openai-compatible` 或 `openai` SDK 或 `eventsource-parser` 都行 `[S14]`。
- 若采纳轻量备选（AI SDK `streamText`），`@ai-sdk/openai-compatible` 把 SSE 解析直接藏掉，`result.textStream` 就是干净的 AsyncIterable `[S7][S9]`。
- `openai` 官方 SDK 的 `dangerouslyAllowBrowser` 是本地优先应用最容易被踩的坑：本地存 key + 客户端直连意味着 key 本来就在用户自己设备上（ADR-0005 明确接受），所以开这个开关在 PDF Studio 语境**合理**，但要知道它是显式声明 `[S39]`。README 原话：浏览器支持默认关闭 "to avoid exposing your secret API credentials"，开启需 "explicitly setting `dangerouslyAllowBrowser` to `true`" `[S39]`。

### 3.1 建议 — 问题 3：**传输层选 `@ai-sdk/openai-compatible`（或 `eventsource-parser` 兜底），不要手写 SSE 状态机**

- **首选 `@ai-sdk/openai-compatible`**：baseURL + apiKey + model 三件套正是 ADR-0005 的配置形状 `[S9]`；它在浏览器里跑（AI SDK Core 环境兼容表 `[S8]`），把 SSE 解析、错误、usage 都处理掉，产出干净的 `textStream`/AsyncIterable `[S7]`。
- **若坚持复用仓库已有的薄 `ModelClient` HTTP adapter**（design 文档的 category-4 端口），给它的 `complete` 加一个流式方法，用 **`eventsource-parser`**（零依赖、source-agnostic）从 `Response.body` 解析 `data:` 帧 `[S40]`——这是最小改动，且不引入整套 provider。
- **`openai` 官方 SDK 可用但要记住 `dangerouslyAllowBrowser: true`**（Tauri WebView 也在「浏览器环境」范畴）`[S39]`；它在 `LocalRuntime` 的官方示例里是默认写法 `[S14]`，说明 assistant-ui 官方认可这条客户端直连路径。

---

## 综合推荐（一页收口）

| 问题 | 选型 | 理由（一手） |
| --- | --- | --- |
| 1. Chat UI 基础 | **assistant-ui `LocalRuntime`**（`@assistant-ui/react`），配 `ChatModelAdapter.run()` 直连模型 | 唯一官方支持「客户端直连 + 完整状态机（streaming/stop/regenerate/branch/edit）+ 预置组件 + 附件」的路径 `[S13][S14][S19]`；`useChat` 的服务器假设被避开 `[S5]` |
| 2. Markdown + LaTeX | **KaTeX**（引擎）+ **Streamdown**（渲染，`remend` 自愈 + Shiki + CJK）；轻量备选 react-markdown 链 | KaTeX 是所有一手路线的最终引擎 `[S23][S28][S29]`；Streamdown 专为流式半成品设计 `[S21][S22]`；至少做 `throwOnError:false` + 分隔符归一化 + KaTeX CSS `[S16][S27][S30]` |
| 3. 流式/SSE | **`@ai-sdk/openai-compatible`**（或 `eventsource-parser` 自写薄 adapter） | baseURL/apiKey/model 即 ADR-0005 形状、浏览器可用、SSE 解析内建 `[S9][S8]`；`openai` SDK 要开 `dangerouslyAllowBrowser` `[S39]` |

**没有「无争议赢家」的地方，如实标注：**

- 问题 1 有一个真实的**重 vs 轻**张力：assistant-ui 功能全但要引入 shadcn 组件体系（仓库目前未用 shadcn `[S43]`），AI SDK `streamText` 薄但状态机全要自写 `[S7]`。**判定线**：若需求清单（copy/regenerate/stop/分支/附件/引用）确实全要，assistant-ui 的省工大于引入成本；若想守住「薄 + 复用 `ModelClient` 端口」的既有哲学，`streamText` 直连 + 自写 `useState` 状态更贴合。**能一锤定音的试验**：用 `LocalRuntime` 的 `ChatModelAdapter.run()` 对接现有 `ModelClient` 端口跑通一个流式冒烟，量一下「引入组件体系」的实际摩擦（Tailwind v4 `@source`、CSS 变量、包体积）。
- 问题 2 里 react-markdown vs Streamdown **没有独立于问题 1 的赢家**：Streamdown 对流式更内行（`remend`）`[S22][S25]`，但它依赖 shadcn 设计 token（无 shadcn 时要手补 `--background` 等 CSS 变量）`[S22]`；react-markdown 薄、成熟，但半成品数学要靠 `throwOnError:false` + 缓冲兜底 `[S30]`。**若选 assistant-ui**，两者都是官方接线（`@assistant-ui/react-markdown` / `@assistant-ui/react-streamdown`）`[S20]`，可以都跑一遍流式数学冒烟再定。

---

## Sources

- `[S1]` https://www.npmjs.com/package/ai
- `[S2]` https://www.npmjs.com/package/@ai-sdk/react
- `[S3]` https://www.npmjs.com/package/@ai-sdk/openai
- `[S4]` https://www.npmjs.com/package/@ai-sdk/openai-compatible
- `[S5]` https://ai-sdk.dev/docs/ai-sdk-ui/chatbot
- `[S6]` https://ai-sdk.dev/docs/ai-sdk-ui/transport
- `[S7]` https://ai-sdk.dev/docs/ai-sdk-core/generating-text
- `[S8]` https://ai-sdk.dev/docs/getting-started/navigating-the-library
- `[S9]` https://ai-sdk.dev/providers/openai-compatible-providers
- `[S10]` https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport
- `[S11]` https://www.npmjs.com/package/@assistant-ui/react
- `[S12]` https://www.npmjs.com/package/@assistant-ui/react-ai-sdk
- `[S13]` https://www.assistant-ui.com/docs/architecture
- `[S14]` https://www.assistant-ui.com/docs/runtimes/custom/local-runtime
- `[S15]` https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7
- `[S16]` https://www.assistant-ui.com/docs/guides/latex
- `[S17]` https://www.assistant-ui.com/docs/ui/streamdown
- `[S18]` https://www.assistant-ui.com/docs/ui/syntax-highlighting
- `[S19]` https://www.assistant-ui.com/docs/guides/attachments
- `[S20]` https://www.assistant-ui.com/docs/ui/markdown
- `[S21]` https://www.npmjs.com/package/streamdown
- `[S22]` https://github.com/vercel/streamdown (README)
- `[S23]` https://www.npmjs.com/package/@streamdown/math
- `[S24]` https://www.npmjs.com/package/@streamdown/code
- `[S25]` https://www.npmjs.com/package/remend
- `[S26]` https://www.npmjs.com/package/react-markdown
- `[S27]` https://www.npmjs.com/package/remark-math
- `[S28]` https://www.npmjs.com/package/rehype-katex
- `[S29]` https://www.npmjs.com/package/katex
- `[S30]` https://github.com/KaTeX/KaTeX/blob/main/docs/options.md
- `[S31]` https://github.com/micromark/micromark-extension-math (README)
- `[S32]` https://www.npmjs.com/package/shiki
- `[S33]` https://www.npmjs.com/package/react-shiki
- `[S34]` https://www.npmjs.com/package/react-syntax-highlighter
- `[S35]` https://www.npmjs.com/package/marked
- `[S36]` https://www.npmjs.com/package/markdown-it
- `[S37]` https://www.npmjs.com/package/@mdx-js/mdx
- `[S38]` https://www.npmjs.com/package/openai
- `[S39]` https://github.com/openai/openai-node (README, `dangerouslyAllowBrowser`)
- `[S40]` https://www.npmjs.com/package/eventsource-parser
- `[S41]` https://www.npmjs.com/package/@microsoft/fetch-event-source
- `[S42]` https://github.com/openai/openai-openapi (openapi.yaml, streaming `[DONE]`)
- `[S43]` https://ui.shadcn.com/r/index.json (registry 索引)
- `[S44]` https://github.com/shadcn-ui/ui (registry 里 `message.tsx` 源码)
- `[S45]` https://www.npmjs.com/package/@assistant-ui/react-markdown
- `[S46]` https://www.npmjs.com/package/@assistant-ui/react-streamdown
- `[S47]` https://www.npmjs.com/package/rehype-pretty-code
- `[S48]` https://github.com/remarkjs/remark-math (README)

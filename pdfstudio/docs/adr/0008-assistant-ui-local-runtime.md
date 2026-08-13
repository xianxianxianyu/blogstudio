# ADR-0008：Chat UI 采用 assistant-ui LocalRuntime + Streamdown / KaTeX

## 状态

Accepted

## 背景

PDF Studio 的 Chat 需要支持 streaming、Markdown、LaTeX、代码高亮、图片/摘录附件、citation 展示、停止、重新生成和后续会话操作。应用当前是 local-first，并由客户端直接调用用户配置的 OpenAI-compatible endpoint，不依赖 server route 或 server proxy。

候选包括 Vercel AI SDK 的 `useChat`、assistant-ui、shadcn/ui 原语，以及自行实现消息状态机。研究结果见 `research-chat-frontend.md`。

## 决策

**Chat UI 采用 assistant-ui 的 `LocalRuntime`。**

`LocalRuntime` 通过 `ChatModelAdapter.run()` 连接业务侧 Chat / Agent adapter。它负责 UI 需要的消息列表、streaming 生命周期、停止、重新生成、分支、编辑和附件状态；业务侧负责把 PDF Studio 自有的 `ModelClient` / `Chat` 契约接到 adapter。

**Markdown 渲染采用 Streamdown，数学公式采用 KaTeX。** Streamdown 负责流式 Markdown 半成品的处理，KaTeX 负责 inline/display math；代码高亮和 CJK 处理按实际依赖启用。流式期间必须允许不完整的 Markdown/数学分隔符，不得因为尚未闭合的 `$$` 让整个消息渲染失败。

## 边界

- 选择的是 UI runtime 和渲染实现，不把 assistant-ui 的 thread、message、runtime 类型写入 `Chat` 或 `Answer` 领域 interface。
- 由于当前 client-direct，**不采用默认依赖 server route 的 `useChatRuntime`**。如果未来增加服务器同步或 server-side model proxy，可另行评估是否增加 AI SDK transport。
- `ChatModelAdapter.run()` 是前端 adapter seam，不是领域 Chat 的公共 interface。
- Chat 的正文、`citations` 和 `grounding` 仍由 PDF Studio 自有 `Answer` 契约提供；引用的页码跳转由 PDF Studio UI 负责。
- API key 不交给 server route。客户端直连的安全边界由 ADR-0005/0006 约束，设置页和系统应用数据目录负责配置保存。

## 后果

可以用较少的自建状态机获得完整 Chat UI，同时保持客户端直连模型。代价是引入 assistant-ui 的组件和样式体系，并需要编写一个 `ChatModelAdapter` 把领域 `Chat` 的流式结果转换成 UI runtime 所需的累计文本事件。

Streamdown/KaTeX 让流式公式更可靠，但仍需配置 KaTeX CSS、数学分隔符归一化和错误降级。具体组件视觉风格、citation 点击行为和 PDF 页面定位属于 PDF Studio UI 实现，不在本 ADR 固定。

## 参考

- `pdfstudio/docs/research-chat-frontend.md`
- `pdfstudio/docs/chat-retrieval-interface.md`
- ADR-0005：用户配置 OpenAI-compatible 模型端点
- ADR-0006：local-first packaged app

# ADR-0009：ModelClient 同时支持一次性和流式调用

## 状态

Accepted

## 背景

`Recognizer` 的 OCR、翻译和图像理解需要拿到完整结果后再解析 `ClipContent`，一次性调用最简单。Chat 则需要 token-by-token streaming，才能让阅读者及时看到回答，并支持 stop/cancel。

两者共享同一个外部模型依赖。如果为 Chat 另造一个模型端口，会重复配置、重复测试和重复实现 OpenAI-compatible adapter；如果只保留一次性 `complete`，又无法提供完整 Chat UI。

## 决策

`ModelClient` 保留一次性 `complete`，并新增 `streamComplete`：

```ts
interface ModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ModelImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
  width?: number;
  height?: number;
}

interface ModelRequest {
  messages: ModelMessage[];
  images?: ModelImage[];
  signal?: AbortSignal;
}

interface ModelResponse {
  text: string;
}

interface ModelChunk {
  textDelta: string;
}

interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  streamComplete(request: ModelRequest): AsyncIterable<ModelChunk>;
}
```

- `Recognizer` / OCR 使用 `complete`，因为视觉模型输出需要完整 JSON/Markdown 后才能校验和组装 `ClipContent`。
- `Chat` 使用 `streamComplete`，由 Chat 或其 UI adapter 累积 `ModelChunk.textDelta`；结束时再生成最终 `Answer`、`citations` 和 `grounding`。
- `AbortSignal` 是调用级取消机制。调用方显式取消时，adapter 应停止读取远端流；没有隐式后台调用。取消时流**优雅结束、不抛**——读者按下停止不是异常，已收到的部分答案照样留着；调用方要区分就看 `signal.aborted`。网络中途断掉仍然会抛，两种情况依旧分得开。
- 两个方法共享同一套 `ModelRequest`，但 response 形态不同：一次性返回完整结果，流式返回增量 chunk。

## 边界

- 这是 PDF Studio 自有的 SDK-agnostic port。Vercel AI SDK 的 `LanguageModel`、`ToolLoopAgent`、provider 类型、SSE event 类型不能出现在该契约中。
- `ModelChunk` 只表达文本增量。tool call、reasoning、usage、provider metadata 暂不进入公共契约；真实需求出现后再增加明确的 domain-neutral event，而不是直接暴露第三方类型。
- `streamComplete` 不改变 Recognizer 的同步语义，也不要求 OCR 进入 streaming 状态机。
- `complete` 和 `streamComplete` 必须由同一个配置 adapter 实现，使用相同的 URL、key、model 和错误映射规则。
- 流结束前产生的部分文本不是最终 `Answer`；完整引用解析和 `grounding` 判定在 Chat 的最终化阶段完成。

## 后果

Recognizer 可以保持简单的 promise + 完整结果模型，Chat 可以连接 assistant-ui `LocalRuntime` 并支持 stop。模型配置、HTTP adapter 和 mock adapter 只有一套。

代价是测试需要覆盖两条路径：完整调用的错误映射，以及流式调用的增量、abort、空流和中途失败。未来若要显示 tool call 或 reasoning，需要先扩展 `ModelChunk` 的领域契约和 UI 状态，而不是绕过 `ModelClient`。

## 参考

- `pdfstudio/docs/recognizer-interface.md`
- `pdfstudio/docs/chat-retrieval-interface.md`
- `pdfstudio/docs/research-chat-frontend.md`
- ADR-0005：用户配置 OpenAI-compatible 模型端点

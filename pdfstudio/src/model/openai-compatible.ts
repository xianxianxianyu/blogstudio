import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import type { ModelChunk, ModelClient, ModelRequest, ModelResponse } from "./model-client";

/**
 * 生产 adapter：把用户配置的 OpenAI 兼容端点接成 ModelClient（ADR-0005 / ADR-0007）。
 * Vercel AI SDK 只活在这一层——它的 provider、model、message 类型不得泄漏进
 * ModelClient 契约，业务模块只认 ADR-0009 那套。
 */
export interface ModelClientConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 注入点，测试用确定性 fetch；生产留空走全局 fetch。 */
  fetch?: typeof fetch;
}

export function createModelClient(config: ModelClientConfig): ModelClient {
  const provider = createOpenAICompatible({
    name: "pdfstudio",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });
  const model = provider.chatModel(config.model);

  const toMessages = (request: ModelRequest) =>
    request.messages.map((message) => ({ role: message.role, content: message.content }));

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const { text } = await generateText({
        model,
        messages: toMessages(request),
        abortSignal: request.signal,
      });
      return { text };
    },

    streamComplete(request: ModelRequest): AsyncIterable<ModelChunk> {
      const { textStream } = streamText({
        model,
        messages: toMessages(request),
        abortSignal: request.signal,
      });

      return (async function* () {
        for await (const textDelta of textStream) yield { textDelta };
      })();
    },
  };
}

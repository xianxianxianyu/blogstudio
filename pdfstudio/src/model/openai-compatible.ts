import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import type { ModelMessage } from "ai";
import { ModelError } from "./model-client";
import type { ModelChunk, ModelClient, ModelRequest, ModelResponse } from "./model-client";

/** SDK 的错误对象在这里被翻译成契约里的 ModelError，不往外漏。 */
function toModelError(cause: unknown): ModelError {
  const status = (cause as { statusCode?: number; status?: number } | null)?.statusCode ??
    (cause as { status?: number } | null)?.status;

  if (typeof status === "number") {
    return new ModelError("http", `模型端点返回 HTTP ${status}`, { cause, status });
  }
  return new ModelError("http", "模型调用失败", { cause });
}

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

  /**
   * 图挂在最后一条 user 消息上——Recognizer 的视觉路由就是「一段 prompt + 一张区域截图」。
   * 这里是 ModelRequest 的扁平 images 与 SDK 的多模态 content 之间唯一的转换点。
   */
  const toMessages = (request: ModelRequest): ModelMessage[] => {
    const images = request.images ?? [];
    const lastUserIndex = request.messages.findLastIndex((message) => message.role === "user");

    return request.messages.map((message, index): ModelMessage => {
      if (images.length === 0 || index !== lastUserIndex) {
        return { role: message.role, content: message.content } as ModelMessage;
      }
      return {
        role: "user",
        content: [
          { type: "text", text: message.content },
          // 用 file part 而非已弃用的 image part（SDK 会按 mediaType 认出它是图）。
          ...images.map((image) => ({
            type: "file" as const,
            data: image.bytes,
            mediaType: image.mime,
          })),
        ],
      };
    });
  };

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let text: string;
      try {
        ({ text } = await generateText({
          model,
          messages: toMessages(request),
          abortSignal: request.signal,
        }));
      } catch (cause) {
        throw toModelError(cause);
      }

      if (text.trim() === "") {
        throw new ModelError("empty-response", "模型返回了空回答");
      }
      return { text };
    },

    streamComplete(request: ModelRequest): AsyncIterable<ModelChunk> {
      // 用 fullStream 而非 textStream：流内错误（比如坏掉的 SSE）在 textStream 上
      // 会被静默吞掉、只剩一个空流，在 fullStream 上则是一个 error part。
      const { fullStream } = streamText({
        model,
        messages: toMessages(request),
        abortSignal: request.signal,
      });

      return (async function* () {
        try {
          for await (const part of fullStream) {
            if (part.type === "text-delta") yield { textDelta: part.text };
            else if (part.type === "error") {
              throw new ModelError("malformed-stream", "模型返回的流无法解析", {
                cause: part.error,
              });
            }
          }
        } catch (cause) {
          throw cause instanceof ModelError ? cause : toModelError(cause);
        }
      })();
    },
  };
}

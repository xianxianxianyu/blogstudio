import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";
import type { ModelMessage } from "ai";
import { ModelError } from "./model-client";
import { backoffMs, realSleep, retryable, statusOf, toModelError } from "./retry";
import type { ModelChunk, ModelClient, ModelRequest, ModelResponse } from "./model-client";

/**
 * 流内错误的一句话原因。
 *
 * SDK 在 `error` part 里塞的**不一定是 Error**（可能是一个普通对象、一个字符串），
 * 而且真正有用的那句话常常在 `cause` 里再套一层。这里只负责把它压成一行能看的字，
 * 类型不外泄——外面拿到的仍然是 `ModelError`（ADR-0007）。
 */
function reasonOf(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (let current: unknown = error; current !== null && current !== undefined; ) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current instanceof Error) parts.push(current.message);
    else if (typeof current === "object" && "message" in current) parts.push(String(current.message));
    else {
      parts.push(String(current));
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" ← ") || "没有更多信息";
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
  /** 同上，退避用的等待。测试注一个不等的，省得为了看重试真睡几秒。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * **一次调用只发一次请求。**
 *
 * SDK 默认 `maxRetries: 2`，也就是一次失败最多发三次；它把 408／409／429／5xx 都当作
 * 可重试。问题是 Anthropic 的 Messages API **没有 idempotency key**，同一个请求发两次
 * 在计费上就是两次。
 *
 * 而 5xx 与超时这两类，「上游到底跑没跑」是**分不出来的**：请求可能已经被完整处理
 * 并计过费，我们只是没拿到响应。这时重试就是在已经付过的钱上再付一次，两边都不知道。
 *
 * 所以默认一次都不重试。真正安全的那一类单独放行，见 `RETRY_STATUS`。
 */
const NO_RETRY = { maxRetries: 0 } as const;


export function createModelClient(config: ModelClientConfig): ModelClient {
  const sleep = config.sleep ?? realSleep;
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
      for (let attempt = 0; ; attempt++) {
        let text: string;
        try {
          ({ text } = await generateText({
            model,
            messages: toMessages(request),
            allowSystemInMessages: true,
            abortSignal: request.signal,
            ...NO_RETRY,
          }));
        } catch (cause) {
          const error = toModelError(cause);
          if (!retryable(error, attempt)) throw error;
          await sleep(backoffMs(attempt));
          continue;
        }

        if (text.trim() === "") {
          throw new ModelError("empty-response", "模型返回了空回答");
        }
        return { text };
      }
    },

    streamComplete(request: ModelRequest): AsyncIterable<ModelChunk> {
      return (async function* () {
        for (let attempt = 0; ; attempt++) {
        // 用 fullStream 而非 textStream：流内错误（比如坏掉的 SSE）在 textStream 上
        // 会被静默吞掉、只剩一个空流，在 fullStream 上则是一个 error part。
        const result = streamText({
          model,
          messages: toMessages(request),
          allowSystemInMessages: true,
          abortSignal: request.signal,
          ...NO_RETRY,
        });

        /**
         * **已经吐出去的字不能收回。**
         *
         * 流一旦开始出字，重试就意味着读者会看到同一段话出现两次——而且第二次多半
         * 跟第一次不一样（模型不是确定性的），看起来像是它自己改口了。所以重试只在
         * 第一个字之前有效。
         *
         * **这一条没有测试守着**：走到这个 adapter 的中途错误都是 SSE 层面的，
         * 不带 HTTP 状态码，因而本来就不可重试——也就构造不出「吐过字之后遇到一个
         * 可重试的错误」。留着它是因为一旦哪天有了这种错误，少了它这个循环就是错的。
         */
        let yielded = false;
        try {
          for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
              yielded = true;
              yield { textDelta: part.text };
            } else if (part.type === "error") {
              // **把真正的原因说出来。** 此前这里只有「模型返回的流无法解析」这一句，
              // 而流内错误的成因差得很远：上游 4xx、SSE 断在半路、SDK 在发请求之前就
              // 拒收了这批消息。三种情形同一句话，界面上无从分辨，只能靠猜——排查
              // 「一次请求都没发出去」那回就是这么卡住的。
              // **流里的错误未必是「流坏了」。** 上游用一个 HTTP 状态码回绝时，它也
              // 从这里出来。说成「流无法解析」不只是话说得不准——状态码会跟着丢掉，
              // 而 429（该等一下再来）和真的解析失败（重来也没用）该做的处置正相反。
              throw statusOf(part.error) !== undefined
                ? toModelError(part.error)
                : new ModelError(
                    "malformed-stream",
                    `模型返回的流无法解析：${reasonOf(part.error)}`,
                    { cause: part.error },
                  );
            }
          }
          return;
        } catch (cause) {
          const error = cause instanceof ModelError ? cause : toModelError(cause);
          if (yielded || !retryable(error, attempt)) throw error;
          // **放弃一条流之前要把它排空。** `streamText` 内部还挂着几个 promise
          // （`.text`、`.usage` 等），这条流已经 reject 了而没人去接——扔下不管的话
          // 就是一个 unhandled rejection，在 Electron 主进程里足以把整个应用带下去。
          await result.consumeStream({ onError: () => {} });
          await sleep(backoffMs(attempt));
        }
        }
      })();
    },
  };
}

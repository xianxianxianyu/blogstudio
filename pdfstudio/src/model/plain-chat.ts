import { ModelError } from "./model-client";
import { backoffMs, realSleep, retryable, toModelError } from "./retry";

/**
 * 不依赖任何 SDK 的 OpenAI 兼容客户端，**给 Electron 主进程用**。
 *
 * 为什么不能直接用 `openai-compatible.ts`：主进程是 esbuild 打成一个 ESM bundle 的，
 * 而 Vercel AI SDK 的依赖链上有 `@vercel/oidc`，它用 CommonJS 的动态 `require("path")`
 * ——打进 ESM 里一加载就抛 `Dynamic require of "path" is not supported`，**应用当场
 * 起不来**。（这也正是 `forwardModel` 存在的理由：主进程只转发 HTTP，SDK 只活在
 * 渲染进程。）
 *
 * 所以这里只做一件事：一段话进，一段话出。没有流、没有工具、没有图——Loop 要的就这些。
 * **重试策略与那边共用同一份**（`retry.ts`），不另立一套。
 */
export interface PlainChat {
  complete(request: {
    messages: { role: "user" | "assistant" | "system"; content: string }[];
  }): Promise<{ text: string }>;
}

export function createPlainChat(config: {
  baseURL: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): PlainChat {
  const send = config.fetch ?? fetch;
  const sleep = config.sleep ?? realSleep;
  const url = `${config.baseURL.replace(/\/$/, "")}/chat/completions`;

  return {
    async complete(request) {
      for (let attempt = 0; ; attempt++) {
        const response = await send(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: config.model, messages: request.messages }),
        });

        if (!response.ok) {
          const error = toModelError({ status: response.status });
          if (!retryable(error, attempt)) throw error;
          await sleep(backoffMs(attempt));
          continue;
        }

        const body: unknown = await response.json().catch(() => null);
        const text = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]
          ?.message?.content;
        if (typeof text !== "string") {
          // **说清楚是形状不对，不说「调用失败」。** 端点填错、被网关挡在登录页都是
          // 这个形状；说成「模型调用失败」的话，排查的人会去查模型，而问题在地址。
          throw new ModelError("malformed-stream", "模型端点回来的东西看不懂，不是一份回答");
        }
        if (text.trim() === "") {
          // 空回答当错误。**一份空 report 落了盘，看起来跟真的干过一样**，
          // 而阶段③ 会拿它当一件完成了的事去写最终报告。
          throw new ModelError("empty-response", "模型返回了空回答");
        }
        return { text };
      }
    },
  };
}

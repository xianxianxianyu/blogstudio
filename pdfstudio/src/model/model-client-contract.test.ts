import { createModelClient } from "./openai-compatible";
import { createFakeModelClient } from "../../test/fake-model-client";
import { describeModelClientContract } from "../../test/model-client-contract";
import type { ModelScript } from "../../test/model-client-contract";

const CONFIG = { baseURL: "https://example.invalid/v1", apiKey: "sk-test", model: "gpt-test" };

/** 把脚本变成 OpenAI 兼容的 HTTP 回答，喂给真 adapter。 */
function scriptedFetch(script: ModelScript): typeof fetch {
  const encoder = new TextEncoder();

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(await new Request(input, init).text()) as { stream?: boolean };

    if (!body.stream) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: CONFIG.model,
          choices: [
            { index: 0, message: { role: "assistant", content: script.text }, finish_reason: "stop" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (script.malformed) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: {不是 JSON\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }

    const events = (script.deltas ?? [script.text]).map(
      (content) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 0,
          model: CONFIG.model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })}\n\n`,
    );

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          // hang：不发 [DONE] 也不关流，等 abort 掐断底层连接。真 fetch 就是这么做的，
          // fake fetch 不照做的话，abort 那条断言测的是流自己结束了，白给。
          if (script.hang) {
            const request = new Request(input, init);
            request.signal.addEventListener("abort", () =>
              controller.error(new DOMException("Aborted", "AbortError")),
            );
            return;
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
}

describeModelClientContract("生产 adapter（OpenAI 兼容）", (script) =>
  createModelClient({ ...CONFIG, fetch: scriptedFetch(script) }),
);

describeModelClientContract("测试 fake", (script) =>
  createFakeModelClient({
    completeText: script.text,
    deltas: script.deltas,
    hang: script.hang,
    malformed: script.malformed,
  }),
);

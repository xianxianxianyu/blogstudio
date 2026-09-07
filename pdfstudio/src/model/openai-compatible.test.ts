import { describe, expect, it } from "vitest";
import { createModelClient } from "./openai-compatible";
import { ModelError } from "./model-client";

const CONFIG = {
  baseURL: "https://example.invalid/v1",
  apiKey: "sk-test-key",
  model: "gpt-test",
};

/** 一次 OpenAI 兼容的完整回答。 */
function completionResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: CONFIG.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 记录请求的 fake fetch——adapter 是真外部缝，跨过它的 HTTP 才是被测对象。 */
function recordingFetch(response: (request: Request) => Response) {
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(await request.clone().text()),
    });
    return response(request);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** OpenAI 兼容的 SSE 流。 */
function streamResponse(
  deltas: string[],
  options: { hang?: boolean; signal?: AbortSignal } = {},
): Response {
  const events = deltas.map(
    (content) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: CONFIG.model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
  );

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      // hang 模式不发 [DONE]，也不关流——留给 abort 去掐断。
      // 真 fetch 在 signal abort 时会断开底层连接，fake 必须照做，否则测的是假象。
      if (options.hang) {
        options.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("Aborted", "AbortError")),
        );
        return;
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("ModelClient adapter — complete", () => {
  it("把完整 response 转成 ModelResponse", async () => {
    const { fetchImpl } = recordingFetch(() => completionResponse("四张人脸样本"));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    const response = await client.complete({
      messages: [{ role: "user", content: "描述这个区域" }],
    });

    expect(response.text).toBe("四张人脸样本");
  });

  it("baseURL、key、model 都送到了 provider", async () => {
    const { calls, fetchImpl } = recordingFetch(() => completionResponse("ok"));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    await client.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.invalid/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(calls[0].body).toMatchObject({ model: CONFIG.model });
  });
});

describe("ModelClient adapter — streamComplete", () => {
  it("把 SSE 转成 ModelChunk，累积起来就是完整回答", async () => {
    const { fetchImpl } = recordingFetch(() => streamResponse(["四张", "人脸", "样本"]));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    const deltas: string[] = [];
    for await (const chunk of client.streamComplete({
      messages: [{ role: "user", content: "描述这个区域" }],
    })) {
      deltas.push(chunk.textDelta);
    }

    expect(deltas.join("")).toBe("四张人脸样本");
    // 是增量而不是一次性整段。
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("AbortSignal 能中止流式回答", async () => {
    const { fetchImpl } = recordingFetch((request) =>
      streamResponse(["四张", "人脸"], { hang: true, signal: request.signal }),
    );
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });
    const controller = new AbortController();

    const deltas: string[] = [];
    for await (const chunk of client.streamComplete({
      messages: [{ role: "user", content: "描述这个区域" }],
      signal: controller.signal,
    })) {
      deltas.push(chunk.textDelta);
      if (deltas.length === 1) controller.abort();
    }

    // 关键断言是「循环走到了这里」——远端流永不结束，abort 没生效的话上面会挂到超时。
    // 优雅结束、不抛：读者按下停止不是异常，已收到的部分答案照样留着。
    // 网络中途断掉仍然会抛，两种情况依旧分得开。
    expect(controller.signal.aborted).toBe(true);
    // 具体切在第几个 delta 取决于缓冲，只断言收到的是真实前缀、且没有凭空多出内容。
    expect("四张人脸".startsWith(deltas.join(""))).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
  });
});

describe("ModelClient adapter — 图片", () => {
  it("ModelRequest.images 进到请求里，Recognizer 的视觉路由才有图可读", async () => {
    const { calls, fetchImpl } = recordingFetch(() => completionResponse("ok"));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    await client.complete({
      messages: [{ role: "user", content: "描述这个区域" }],
      images: [{ mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
    });

    const body = calls[0].body as {
      messages: { role: string; content: string | { type: string; image_url?: { url: string } }[] }[];
    };
    const parts = body.messages.at(-1)!.content;

    expect(Array.isArray(parts)).toBe(true);
    const image = (parts as { type: string; image_url?: { url: string } }[]).find(
      (part) => part.type === "image_url",
    );
    expect(image?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe("ModelClient adapter — 错误映射", () => {
  it("HTTP 错误映射成 ModelError，不漏 SDK 的错误类型", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    const error = await client
      .complete({ messages: [{ role: "user", content: "hi" }] })
      .catch((thrown: unknown) => thrown);

    // ADR-0007：SDK 的 provider / error 类型不得泄漏出 adapter。
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe("http");
    expect((error as ModelError).status).toBe(401);
  });

  it("200 但没有内容，映射成 empty-response", async () => {
    const { fetchImpl } = recordingFetch(() => completionResponse(""));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    const error = await client
      .complete({ messages: [{ role: "user", content: "hi" }] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe("empty-response");
  });
  it("坏掉的流映射成 malformed-stream", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {不是 JSON\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    const drain = async () => {
      const chunks: string[] = [];
      for await (const chunk of client.streamComplete({
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk.textDelta);
      }
      return chunks;
    };

    const error = await drain().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe("malformed-stream");
  });

  describe("system 消息（ADR-0009 的契约里有它）", () => {
    it("**system 消息要原样发到线上**——SDK 7 默认拒收它，得显式放行", async () => {
      const { calls, fetchImpl } = recordingFetch(() => completionResponse("好"));

      await createModelClient({ ...CONFIG, fetch: fetchImpl }).complete({
        messages: [
          { role: "system", content: "你是写作搭子" },
          { role: "user", content: "这段怎么改" },
        ],
      });

      expect((calls[0].body as { messages: unknown[] }).messages).toEqual([
        { role: "system", content: "你是写作搭子" },
        { role: "user", content: "这段怎么改" },
      ]);
    });

    it("多条 system **保持原来的顺序**——交错时位置就是语义", async () => {
      const { calls, fetchImpl } = recordingFetch(() => streamResponse(["嗯"]));
      const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

      let text = "";
      for await (const chunk of client.streamComplete({
        messages: [
          { role: "system", content: "规矩" },
          { role: "system", content: "材料" },
          { role: "user", content: "问" },
        ],
      })) {
        text += chunk.textDelta;
      }

      expect(text).toBe("嗯");
      expect((calls[0].body as { messages: { content: string }[] }).messages.map((one) => one.content)).toEqual([
        "规矩",
        "材料",
        "问",
      ]);
    });
  });
});

/**
 * 重试就是重新计费。
 *
 * Anthropic 的 Messages API **没有 idempotency key**（OpenAI 的 `Idempotency-Key`
 * 那套它没有对应物），所以「同一个请求发两次」在计费上就是两次。而 SDK 默认
 * `maxRetries: 2`——一次失败最多发三次。
 *
 * 更要命的是 5xx 和超时这两类：请求**可能已经被完整处理并计费了**，我们只是没拿到
 * 响应。这时重试是在已经付过的钱上再付一次，而且两边都不知道。
 */
describe("重试与计费", () => {
  it("**上游 5xx 不重试**——那次调用可能已经跑完并计过费了，我们只是没拿到响应", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response("upstream boom", { status: 502 }));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      ModelError,
    );

    expect(calls).toHaveLength(1);
  });

  it("流式的那条路一样不重试", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response("upstream boom", { status: 502 }));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl });

    await expect(async () => {
      // 把流抽干：要的是「抽干这件事」本身，不是每一片的内容。
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 循环变量用不上，抽干才是目的
      for await (const _ of client.streamComplete({ messages: [{ role: "user", content: "hi" }] }));
    }).rejects.toThrow(ModelError);

    expect(calls).toHaveLength(1);
  });

  it("**429 重试**——限流是上游明确回话说「我没做」，那一次不可能计过费", async () => {
    let n = 0;
    const { calls, fetchImpl } = recordingFetch(() =>
      ++n === 1 ? new Response("slow down", { status: 429 }) : completionResponse("好的"),
    );
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl, sleep: async () => {} });

    const answer = await client.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(answer.text).toBe("好的");
    expect(calls).toHaveLength(2);
  });

  it("一直 429 也不会无限重试", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response("slow down", { status: 429 }));
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl, sleep: async () => {} });

    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      ModelError,
    );

    expect(calls).toHaveLength(3);
  });

  it("流还没吐出第一个字之前的 429，也重试", async () => {
    let n = 0;
    const { calls, fetchImpl } = recordingFetch(() =>
      ++n === 1 ? new Response("slow down", { status: 429 }) : streamResponse(["好", "的"]),
    );
    const client = createModelClient({ ...CONFIG, fetch: fetchImpl, sleep: async () => {} });

    const out: string[] = [];
    for await (const chunk of client.streamComplete({ messages: [{ role: "user", content: "hi" }] })) {
      out.push(chunk.textDelta);
    }

    expect(out.join("")).toBe("好的");
    expect(calls).toHaveLength(2);
  });

  it("**退避要越等越久**——限流时立刻重来，只是把同一堵墙再撞一次", async () => {
    const waits: number[] = [];
    const { fetchImpl } = recordingFetch(() => new Response("slow down", { status: 429 }));
    const client = createModelClient({
      ...CONFIG,
      fetch: fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });

    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();

    expect(waits).toEqual([1000, 2000]);
  });
});

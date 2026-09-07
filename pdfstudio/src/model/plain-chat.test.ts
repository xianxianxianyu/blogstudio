import { describe, expect, it } from "vitest";
import { createPlainChat } from "./plain-chat";
import { ModelError } from "./model-client";

const CONFIG = { baseURL: "https://example.invalid/v1", apiKey: "sk-test", model: "gpt-test" };

const answer = (text: string) =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function recording(reply: (n: number) => Response) {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      auth: request.headers.get("authorization"),
      body: JSON.parse(await request.clone().text()),
    });
    return reply(calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("主进程用的裸模型客户端", () => {
  it("发到 /chat/completions，带上钥匙，拿回一段话", async () => {
    const { calls, fetchImpl } = recording(() => answer("好的"));
    const chat = createPlainChat({ ...CONFIG, fetch: fetchImpl });

    const out = await chat.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(out.text).toBe("好的");
    expect(calls[0].url).toBe("https://example.invalid/v1/chat/completions");
    expect(calls[0].auth).toBe("Bearer sk-test");
    expect(calls[0].body).toEqual({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
  });

  it("**上游 5xx 不重试**——那次调用可能已经跑完并计过费了", async () => {
    const { calls, fetchImpl } = recording(() => new Response("boom", { status: 502 }));
    const chat = createPlainChat({ ...CONFIG, fetch: fetchImpl, sleep: async () => {} });

    await expect(chat.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      ModelError,
    );

    expect(calls).toHaveLength(1);
  });

  it("429 重试——限流是上游明确说「我没做」", async () => {
    const { calls, fetchImpl } = recording((n) =>
      n === 1 ? new Response("slow down", { status: 429 }) : answer("好的"),
    );
    const chat = createPlainChat({ ...CONFIG, fetch: fetchImpl, sleep: async () => {} });

    expect((await chat.complete({ messages: [{ role: "user", content: "hi" }] })).text).toBe("好的");
    expect(calls).toHaveLength(2);
  });

  it("一直 429 也不会无限重试", async () => {
    const { calls, fetchImpl } = recording(() => new Response("slow down", { status: 429 }));
    const chat = createPlainChat({ ...CONFIG, fetch: fetchImpl, sleep: async () => {} });

    await expect(chat.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();

    expect(calls).toHaveLength(3);
  });

  it("**空回答当错误**——一份空 report 落了盘，看起来跟真的干过一样", async () => {
    const { fetchImpl } = recording(() => answer("   "));
    const chat = createPlainChat({ ...CONFIG, fetch: fetchImpl });

    await expect(chat.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /空回答/,
    );
  });

  it("回来的不是预期的形状，说清楚是形状不对，不说「调用失败」", async () => {
    const { fetchImpl } = recording(() => new Response("<html>登录页</html>", { status: 200 }));
    const chat = createPlainChat({ ...CONFIG, fetch: fetchImpl });

    // 端点填错、被网关挡在登录页，都是这个形状。说成「模型调用失败」的话，
    // 排查的人会去查模型，而问题在地址。
    await expect(chat.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /看不懂/,
    );
  });

  it("退避越等越久——限流时立刻重来，只是把同一堵墙再撞一次", async () => {
    const waits: number[] = [];
    const { fetchImpl } = recording(() => new Response("slow down", { status: 429 }));
    const chat = createPlainChat({
      ...CONFIG,
      fetch: fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });

    await expect(chat.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();

    expect(waits).toEqual([1000, 2000]);
  });
});

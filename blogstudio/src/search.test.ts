import { describe, expect, it } from "vitest";
import { createTavilySearch } from "./search";

/** 记下请求、按给定的 body 回。 */
function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const call = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { call, seen };
}

describe("Tavily", () => {
  it("带 key 去问，回来的结果只留标题、地址、摘录", async () => {
    const { call, seen } = fakeFetch(200, {
      results: [
        { title: "A", url: "https://a", content: " 甲 ", score: 0.9 },
        { title: "", url: "https://b", content: "乙" },
        { title: "C", url: "", content: "没地址的不要" },
      ],
    });
    const hits = await createTavilySearch({ apiKey: "k", fetch: call }).search("kv cache");

    expect(hits).toEqual([
      { title: "A", url: "https://a", content: "甲" },
      // 没标题就拿地址顶着——列表里总得有一行字能点。
      { title: "https://b", url: "https://b", content: "乙" },
    ]);
    expect(seen[0].url).toBe("https://api.tavily.com/search");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(seen[0].init.body as string).query).toBe("kv cache");
  });

  it("**把它自己的话带上来**：401 是 key 错了，432 是额度用完，一句「失败」分不出来", async () => {
    const { call } = fakeFetch(401, "Unauthorized: invalid API key");
    await expect(createTavilySearch({ apiKey: "bad", fetch: call }).search("x")).rejects.toThrow(
      /HTTP 401.*invalid API key/,
    );
  });
});

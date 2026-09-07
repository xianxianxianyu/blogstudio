import { describe, expect, it } from "vitest";
import { createLiveClient } from "./live-client";
import type { ModelClient } from "./model-client";

/** 一个只会报自己名字的客户端。 */
const named = (name: string): ModelClient => ({
  complete: async () => ({ text: name }),
  async *streamComplete() {
    yield { textDelta: name };
  },
});

describe("createLiveClient", () => {
  it("**每次调用都用此刻的配置**——设置改完不用重启", async () => {
    let current = named("旧 key");
    const client = createLiveClient(() => current);
    expect((await client.complete({ messages: [] })).text).toBe("旧 key");

    current = named("新 key");
    expect((await client.complete({ messages: [] })).text).toBe("新 key");
  });

  it("流式那条路也一样", async () => {
    let current = named("旧");
    const client = createLiveClient(() => current);
    current = named("新");
    const chunks: string[] = [];
    for await (const chunk of client.streamComplete({ messages: [] })) chunks.push(chunk.textDelta);
    expect(chunks).toEqual(["新"]);
  });
});

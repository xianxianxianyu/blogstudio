import { describe, expect, it } from "vitest";
import { bindConversation, createConversation } from "./conversation";
import type { Answer, AskOptions, Chat, Turn } from "../chat/chat";

/** 由测试规定这次问答怎么走：这一层验的是编排与单文档封闭，不是检索。 */
function fakeChat(script: {
  deltas?: string[];
  answer?: Partial<Answer>;
  seen?: Turn[][];
  fail?: Error;
}): Chat {
  return {
    async ask(turns: Turn[], options?: AskOptions): Promise<Answer> {
      script.seen?.push(turns);
      if (script.fail) throw script.fail;
      let text = "";
      for (const delta of script.deltas ?? ["答案"]) {
        text += delta;
        options?.onText?.(text);
        if (options?.signal?.aborted) break;
      }
      return { text, citations: [], grounding: "none", ...script.answer };
    },
    reindex: async () => undefined,
  };
}

describe("对话", () => {
  it("问一句，问答都留在记录里", async () => {
    const conversation = createConversation();
    conversation.attach(fakeChat({ deltas: ["注意", "力"] }));

    await conversation.send("什么是注意力");

    expect(conversation.state.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(conversation.state.turns[1].parts[0]).toEqual({ kind: "text", text: "注意力" });
    expect(conversation.state.streaming).toBeNull();
  });

  it("生成过程中能看到累计文本", async () => {
    const conversation = createConversation();
    const seen: (string | null)[] = [];
    conversation.subscribe(() => seen.push(conversation.state.streaming));
    conversation.attach(fakeChat({ deltas: ["一", "二", "三"] }));

    await conversation.send("数数");

    expect(seen).toContain("一二");
  });

  it("停止之后已生成的半段留下来，不白问一次", async () => {
    const conversation = createConversation();
    conversation.attach(
      fakeChat({ deltas: ["一", "二", "三", "四"] }),
    );

    const pending = conversation.send("数数");
    conversation.stop();
    await pending;

    const last = conversation.state.turns.at(-1)!;
    expect(last.role).toBe("assistant");
    expect((last.parts[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  it("换一本书，对话清空", async () => {
    // **单文档封闭**：`CONTEXT.md` 说 chat「绝不跨 PDF」。不清的话，上一篇论文的问答会
    // 作为上下文一起发给下一篇——模型会拿 A 的内容回答关于 B 的问题，而且不报任何错。
    // 与「换书时摘录跟着换」是同一个形状的洞。
    const conversation = createConversation();
    conversation.attach(fakeChat({ deltas: ["A 的答案"] }));
    await conversation.send("A 篇讲了什么");
    expect(conversation.state.turns).toHaveLength(2);

    conversation.attach(fakeChat({ deltas: ["B 的答案"] }));

    expect(conversation.state.turns).toEqual([]);
    expect(conversation.state.error).toBeNull();
  });

  it("换书之后再问，发出去的历史里没有上一本的内容", async () => {
    // 上一条只看了界面上还剩什么。这一条看真正发给模型的是什么——两者不是一回事，
    // 清了界面却仍把旧 turns 传下去，是同样静默的错。
    const seen: Turn[][] = [];
    const conversation = createConversation();
    conversation.attach(fakeChat({ deltas: ["A 的答案"], seen }));
    await conversation.send("A 篇讲了什么");

    conversation.attach(fakeChat({ deltas: ["B 的答案"], seen }));
    await conversation.send("B 篇讲了什么");

    expect(seen.at(-1)!.map((turn) => (turn.parts[0] as { text: string }).text)).toEqual([
      "B 篇讲了什么",
    ]);
  });

  it("没有打开文档时问不了，也不假装在生成", async () => {
    const conversation = createConversation();

    const result = await conversation.send("随便问问");

    expect(result.ok).toBe(false);
    expect(conversation.state.turns).toEqual([]);
    expect(conversation.state.streaming).toBeNull();
  });

  it("出错时把原因带出来，问题留在记录里好重试", async () => {
    const conversation = createConversation();
    conversation.attach(fakeChat({ fail: Object.assign(new Error("模型调用失败"), { kind: "http" }) }));

    const result = await conversation.send("什么是注意力");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("模型调用失败");
    // 报错也进状态：它属于这次对话，换书时跟着清；留在视图局部 state 里，
    // 换本书还会挂着上一本的报错。
    expect(conversation.state.error).toContain("模型调用失败");
    // 问题留着：重试不该让读者重新打一遍字。
    expect(conversation.state.turns.map((turn) => turn.role)).toEqual(["user"]);
    expect(conversation.state.streaming).toBeNull();
  });
});

describe("绑定到 Workspace", () => {
  it("换文档时自动换 Chat 并清空对话", async () => {
    // 这条规则放在有测试的地方，不指望视图记得调 attach——「换书时某个东西没跟着换」
    // 这一路上已经踩过一次（标签画到了别人的页面上），而且不报任何错。
    const chats = [fakeChat({ deltas: ["A"] }), fakeChat({ deltas: ["B"] })];
    let current: Chat | null = chats[0];
    const listeners = new Set<() => void>();
    const workspace = {
      get chat() {
        return current;
      },
      get state() {
        return { docId: current === chats[0] ? "a" : "b" };
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const conversation = createConversation();
    bindConversation(workspace as never, conversation);
    await conversation.send("A 篇讲了什么");
    expect(conversation.state.turns).toHaveLength(2);

    current = chats[1];
    listeners.forEach((listener) => listener());

    expect(conversation.state.turns).toEqual([]);
  });

  it("同一本书里状态变化不清空对话", async () => {
    // 框一条摘录也会触发 Workspace 的通知。见变化就清的话，读者划一下译文，
    // 刚问到一半的对话就没了。
    const chat = fakeChat({ deltas: ["A"] });
    const listeners = new Set<() => void>();
    const workspace = {
      get chat() {
        return chat;
      },
      get state() {
        return { docId: "a" };
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const conversation = createConversation();
    bindConversation(workspace as never, conversation);
    await conversation.send("问一句");

    listeners.forEach((listener) => listener());

    expect(conversation.state.turns).toHaveLength(2);
  });
});

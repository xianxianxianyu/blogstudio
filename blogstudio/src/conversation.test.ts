import { describe, expect, it, vi } from "vitest";
import { createWritingTalk } from "./conversation";
import type { AskOptions, WriterChat, WriterTurn } from "./writer-chat";

const chatSaying = (text: string): WriterChat & { seen: { turns: WriterTurn[]; draft: string }[] } => {
  const seen: { turns: WriterTurn[]; draft: string }[] = [];
  return {
    seen,
    async ask(turns: WriterTurn[], options: AskOptions) {
      seen.push({ turns, draft: options.draft });
      options.onText?.(text);
      return { text, recalled: [], cited: [], hits: [], searchFailed: null };
    },
  };
};

describe("写作时的对话", () => {
  it("答完之后，问和答都在记录里", async () => {
    const talk = createWritingTalk({ chat: chatSaying("这样开头"), draft: () => "正文" });
    talk.attach("d1");

    await talk.send("怎么开头");

    expect(talk.state.turns).toEqual([
      { role: "user", text: "怎么开头" },
      { role: "assistant", text: "这样开头" },
    ]);
    expect(talk.state.streaming).toBeNull();
  });

  it("**每次发问现取正文**——稿子一直在变，钉住快照就是在答上一版", async () => {
    let text = "第一版";
    const chat = chatSaying("嗯");
    const talk = createWritingTalk({ chat, draft: () => text });
    talk.attach("d1");

    await talk.send("问");
    text = "第二版";
    await talk.send("再问");

    expect(chat.seen.map((one) => one.draft)).toEqual(["第一版", "第二版"]);
  });

  it("选中的那一段跟着这一问走，**发完就撤掉**", async () => {
    const chat = chatSaying("嗯");
    const talk = createWritingTalk({ chat, draft: () => "正文" });
    talk.attach("d1");

    talk.quote("  召回率会掉  ");
    await talk.send("这段怎么改");
    await talk.send("那这一句呢");

    expect(chat.seen[0].turns[0]).toEqual({ role: "user", text: "这段怎么改", quoted: "召回率会掉" });
    expect(chat.seen[1].turns[2]).toEqual({ role: "user", text: "那这一句呢" });
    expect(talk.state.quoted).toBeNull();
  });

  it("**换一篇稿子就换一场对话**——不清的话模型会拿上一篇回答这一篇", async () => {
    const talk = createWritingTalk({ chat: chatSaying("嗯"), draft: () => "正文" });
    talk.attach("d1");
    await talk.send("问");

    talk.attach("d2");

    expect(talk.state.turns).toEqual([]);
    expect(talk.state.answer).toBeNull();
  });

  it("切回同一篇不算换——那只是从案头点回来", async () => {
    const talk = createWritingTalk({ chat: chatSaying("嗯"), draft: () => "正文" });
    talk.attach("d1");
    await talk.send("问");

    talk.attach("d1");

    expect(talk.state.turns).toHaveLength(2);
  });

  it("没开稿子时问不出去", async () => {
    const chat = chatSaying("嗯");
    const talk = createWritingTalk({ chat, draft: () => "" });

    await talk.send("问");

    expect(chat.seen).toEqual([]);
  });

  it("失败了，问题留在记录里，理由摆出来", async () => {
    const talk = createWritingTalk({
      chat: { ask: () => Promise.reject(new Error("模型不通")) },
      draft: () => "正文",
    });
    talk.attach("d1");

    await talk.send("问");

    expect(talk.state.error).toBe("模型不通");
    expect(talk.state.turns).toEqual([{ role: "user", text: "问" }]);
    expect(talk.state.streaming).toBeNull();
  });

  it("停止会把 signal 掐掉", async () => {
    const aborted = vi.fn();
    const talk = createWritingTalk({
      chat: {
        ask: async (_turns, options) => {
          options.signal?.addEventListener("abort", aborted);
          return { text: "半段", recalled: [], cited: [], hits: [], searchFailed: null };
        },
      },
      draft: () => "正文",
    });
    talk.attach("d1");

    const asking = talk.send("问");
    talk.stop();
    await asking;

    expect(aborted).toHaveBeenCalled();
  });
});

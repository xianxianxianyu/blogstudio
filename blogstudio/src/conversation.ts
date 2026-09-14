import type { WriterAnswer, WriterChat, WriterTurn } from "./writer-chat";

/**
 * 写作那一屏的对话状态。同 PDF Studio 的 `conversation.ts`：**状态只在这里存一份**，
 * 视图只做投影。
 *
 * 与那边的区别只有两处：贴进来的不是摘录而是**正文里选中的一段**；出处不是页码而是
 * context 的 id。
 */

export interface WritingTalkState {
  turns: WriterTurn[];
  /** 正在生成时的累计文本；空闲时为 null。 */
  streaming: string | null;
  /** 最后一次回答，连同它召回与引用了的材料。 */
  answer: WriterAnswer | null;
  /** 选中、还没发出去的那一段正文。看得见也撤得掉，同那边贴摘录的规矩。 */
  quoted: string | null;
  error: string | null;
  /** 发问时先联网搜一下。**默认开**：接了搜索就是为了用它；不想搜的那一问关掉就是。 */
  web: boolean;
}

export interface WritingTalk {
  readonly state: WritingTalkState;
  subscribe(listener: () => void): () => void;
  /** 换一篇稿子就换一场对话。传 null 表示现在没开着任何一篇。 */
  attach(draftId: string | null): void;
  quote(text: string): void;
  unquote(): void;
  send(text: string): Promise<void>;
  stop(): void;
  setWeb(on: boolean): void;
}

export function createWritingTalk(deps: {
  chat: WriterChat;
  /** 现在的正文。**每次发问现取**——稿子一直在变，钉住快照就是在答上一版。 */
  draft: () => string;
}): WritingTalk {
  let draftId: string | null = null;
  let turns: WriterTurn[] = [];
  let streaming: string | null = null;
  let answer: WriterAnswer | null = null;
  let quoted: string | null = null;
  let error: string | null = null;
  let web = true;
  let controller: AbortController | null = null;

  let snapshot: WritingTalkState = { turns, streaming, answer, quoted, error, web };
  const listeners = new Set<() => void>();

  function publish(): void {
    snapshot = { turns, streaming, answer, quoted, error, web };
    for (const listener of listeners) listener();
  }

  return {
    get state() {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attach(next: string | null): void {
      // **一篇稿子一场对话。** 不清的话，上一篇的问答会作为上下文一起发出去，模型拿
      // A 的内容回答关于 B 的问题，而且不报任何错——PDF Studio 那边为同一个形状的洞
      // 写过一条不变量（单文档封闭）。
      if (next === draftId) return;
      draftId = next;
      turns = [];
      streaming = null;
      answer = null;
      quoted = null;
      error = null;
      controller?.abort();
      controller = null;
      publish();
    },

    quote(text: string): void {
      const trimmed = text.trim();
      if (trimmed === "") return;
      quoted = trimmed;
      publish();
    },

    unquote(): void {
      quoted = null;
      publish();
    },

    async send(text: string): Promise<void> {
      if (draftId === null || streaming !== null) return;

      turns = [...turns, { role: "user", text, ...(quoted !== null ? { quoted } : {}) }];
      // 发完就撤掉：不撤的话第二问、第三问都还带着它，模型会以为人一直在问那一段。
      quoted = null;
      streaming = "";
      error = null;
      publish();

      controller = new AbortController();
      try {
        const result = await deps.chat.ask(turns, {
          draft: deps.draft(),
          signal: controller.signal,
          web,
          onText: (accumulated) => {
            streaming = accumulated;
            publish();
          },
        });
        answer = result;
        turns = [...turns, { role: "assistant", text: result.text }];
      } catch (cause) {
        // 问题留在记录里：重试不该让人重打一遍字。
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        streaming = null;
        controller = null;
        publish();
      }
    },

    stop(): void {
      controller?.abort();
    },

    setWeb(on: boolean): void {
      web = on;
      publish();
    },
  };
}

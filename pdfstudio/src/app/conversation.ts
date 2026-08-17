import { errorChain } from "./error-chain";
import type { Answer, Chat, ClipSnapshot, Part, Turn } from "../chat/chat";
import type { Result, Workspace } from "./workspace";

export interface ConversationState {
  turns: Turn[];
  /** 正在生成时的累计文本；空闲时为 null。 */
  streaming: string | null;
  /** 最后一次回答的出处与依据成色，供界面显眼地摆出来。 */
  answer: Answer | null;
  /**
   * 贴进来、还没发出去的摘录（ADR-0016 的「问这段」）。
   *
   * 要能看见也要能撤掉：看不见读者不知道自己贴了什么，撤不掉就只能整段重来。
   */
  attached: ClipSnapshot[];
  /**
   * 上一次失败的原因。放在这里而不是视图里：它属于**这次对话**，换书时该跟着一起清
   * ——留在视图的局部 state 里，换本书还挂着上一本的报错。
   */
  error: string | null;
}

export interface Conversation {
  readonly state: ConversationState;
  subscribe(listener: () => void): () => void;
  /** 换文档就换一个 Chat。传 null 表示当前没有打开任何文档。 */
  attach(chat: Chat | null): void;
  /** 把一条摘录贴进下一句问题。 */
  attachClip(snapshot: ClipSnapshot): void;
  detachClip(clipId: string): void;
  send(text: string): Promise<Result>;
  stop(): void;
}

/**
 * 问答这一屏的应用层（ADR-0013 按屏切分）。
 *
 * 状态只在这里存一份。assistant-ui 的 LocalRuntime 本身也是个状态持有者，把对话同时
 * 交给两边管，就是这一路上反复在躲的「同一条规则写在两处」——迟早有一处漏掉单文档封闭
 * 或停止后的半段。所以视图那侧只做投影。
 */
export function createConversation(): Conversation {
  let chat: Chat | null = null;
  let turns: Turn[] = [];
  let streaming: string | null = null;
  let answer: Answer | null = null;
  let error: string | null = null;
  let attached: ClipSnapshot[] = [];
  let controller: AbortController | null = null;

  let snapshot: ConversationState = { turns, streaming, answer, error, attached };
  const listeners = new Set<() => void>();

  function publish(): void {
    // 引用要稳：React 的 useSyncExternalStore 拿它做相等性判断（同 Workspace）。
    snapshot = { turns, streaming, answer, error, attached };
    for (const listener of listeners) listener();
  }

  /** 贴着的摘录排在问题前面：模型先看到材料，再看到问题。 */
  const askOf = (text: string): Turn => ({
    role: "user",
    parts: [
      ...attached.map((clip): Part => ({ kind: "clip", snapshot: clip })),
      { kind: "text", text },
    ],
  });

  return {
    get state() {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attachClip(clip: ClipSnapshot): void {
      // 同一条不贴两次：读者点两下「问这段」不该发两份一样的材料。
      if (attached.some((existing) => existing.clipId === clip.clipId)) return;
      attached = [...attached, clip];
      publish();
    },

    detachClip(clipId: string): void {
      attached = attached.filter((clip) => clip.clipId !== clipId);
      publish();
    },

    attach(next: Chat | null): void {
      // **单文档封闭**：`CONTEXT.md` 说 chat「绝不跨 PDF」。不清空的话，上一篇论文的
      // 问答会作为上下文一起发给下一篇——模型拿 A 的内容回答关于 B 的问题，而且不报
      // 任何错。与「换书时摘录跟着换」是同一个形状的洞，那个已经踩过一次。
      chat = next;
      turns = [];
      streaming = null;
      answer = null;
      error = null;
      // 贴着的也清掉：单文档封闭，上一本的摘录不该跟着发给下一本。
      attached = [];
      controller?.abort();
      controller = null;
      publish();
    },

    async send(text: string): Promise<Result> {
      if (!chat) return { ok: false, reason: "还没有打开任何文档。" };

      turns = [...turns, askOf(text)];
      // 发完就清空：不清的话第二问、第三问都会带上它——既费 token，也会让模型以为
      // 读者还在问那一段。
      attached = [];
      streaming = "";
      error = null;
      publish();

      controller = new AbortController();
      try {
        const result = await chat.ask(turns, {
          signal: controller.signal,
          onText: (accumulated) => {
            streaming = accumulated;
            publish();
          },
        });
        // 停止时已生成的半段照样是合法 Answer（不变量 ⑥），照样收进记录
        // ——白问一次却什么都不留，读者只能重打一遍字。
        answer = result;
        turns = [...turns, { role: "assistant", parts: [{ kind: "text", text: result.text }] }];
        return { ok: true };
      } catch (cause) {
        // 问题留在记录里：重试不该让读者重新打一遍字。
        error = errorChain(cause) || "问答失败";
        return { ok: false, reason: error, error: cause };
      } finally {
        streaming = null;
        controller = null;
        publish();
      }
    },

    stop(): void {
      controller?.abort();
    },
  };
}

/**
 * 把对话绑到 Workspace：换文档时自动换 `Chat` 并清空。
 *
 * 这条规则放在这里而不是让视图记得调 `attach`——「换书时某个东西没跟着换」已经踩过
 * 一次（上一本的标签画到了这一本的页面上），而且不报任何错。
 *
 * 只认 `docId` 变化，不见通知就清：框一条摘录同样会触发 Workspace 的通知，见变化就清
 * 的话，读者划一下译文，刚问到一半的对话就没了。
 */
export function bindConversation(workspace: Workspace, conversation: Conversation): () => void {
  let openedDoc = workspace.state.docId;
  conversation.attach(workspace.chat);

  return workspace.subscribe(() => {
    if (workspace.state.docId === openedDoc) return;
    openedDoc = workspace.state.docId;
    conversation.attach(workspace.chat);
  });
}

import { useCallback, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
import type { Conversation } from "../../src/app/conversation";
import type { Progress } from "../../src/app/progress";
import type { Citation, Turn } from "../../src/chat/chat";

/**
 * 问答界面：`conversation.state` 的投影。
 *
 * 对话状态只在应用层存一份（`conversation.ts`）。ADR-0008 选的 assistant-ui
 * `LocalRuntime` 本身也是个状态持有者，两边各存一份就是这一路上反复在躲的
 * 「同一条规则写在两处」——迟早有一处漏掉单文档封闭或停止后的半段。所以这里只用它的
 * 渲染件（Streamdown + KaTeX 负责流式 Markdown 与数学），状态不交出去。
 */
export function ChatPanel({
  conversation,
  progress,
  onJump,
}: {
  conversation: Conversation;
  progress: Progress;
  onJump: (page: number) => void;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => conversation.subscribe(listener), [conversation]),
    () => conversation.state,
  );
  const working = useSyncExternalStore(
    useCallback((listener: () => void) => progress.subscribe(listener), [progress]),
    () => progress.text,
  );
  const [draft, setDraft] = useState("");
  const busy = state.streaming !== null;

  async function send() {
    const text = draft.trim();
    if (text === "" || busy) return;
    setDraft("");
    await conversation.send(text);
  }

  return (
    <div>
      {state.turns.length === 0 && (
        <p className="empty">
          问这一篇文档。答案只依据检索到的原文——首次提问要下载一次本地向量模型，
          之后就快了。
        </p>
      )}

      {state.turns.map((turn, index) => (
        <Message key={index} turn={turn} />
      ))}

      {/* streaming 为空串表示「在干活但还没有一个字」——建索引、跑向量都在这一段。
          原本这里渲染的是一个空气泡，界面上什么都没有，跟卡死没有区别。 */}
      {state.streaming !== null && (
        <div className="msg bot">
          {state.streaming === "" ? (
            <span className="empty">{working ?? "正在检索…首次提问要先准备本地向量模型，可能要几分钟"}</span>
          ) : (
            <Streamdown>{state.streaming}</Streamdown>
          )}
        </div>
      )}

      {/* 出处要显眼且可点。`grounding: 'retrieved'` 承诺的只是「找到了主题相关的原文」，
          不是「这段话能回答问题」——**显眼的引用是这个语义成立的必要条件**，不是装饰。 */}
      {!busy && state.answer && <Citations answer={state.answer} onJump={onJump} />}

      {state.error !== null && <pre className="err">{state.error}</pre>}

      <div className="row">
        <textarea
          rows={2}
          value={draft}
          placeholder="问点什么…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送，Shift+Enter 换行。中文输入法组词时的 Enter 不能当发送
            // ——那会把没选完的候选词直接发出去。
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button className="btn" onClick={() => conversation.stop()}>
            停止
          </button>
        ) : (
          <button className="btn" onClick={() => void send()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}

function Message({ turn }: { turn: Turn }) {
  const text = turn.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("")
    .trim();
  if (text === "") return null;

  return (
    <div className={turn.role === "user" ? "msg me" : "msg bot"}>
      {turn.role === "user" ? text : <Streamdown>{text}</Streamdown>}
    </div>
  );
}

/**
 * 说的是**上面**那段回答：这块横幅渲染在答案之后。
 * 原本写的是「下面这段」，而它就贴在答案下方——文案和位置对不上。
 */
const GROUNDING: Record<string, string> = {
  retrieved: "以上回答的依据：文档原文",
  pasted: "以上回答的依据：你贴进来的摘录",
  none: "文档里没有找到依据——以上回答没有出处",
};

function Citations({
  answer,
  onJump,
}: {
  answer: { grounding: string; citations: Citation[] };
  onJump: (page: number) => void;
}) {
  return (
    <div className={answer.grounding === "none" ? "cite err" : "cite"}>
      <div>{GROUNDING[answer.grounding]}</div>
      {answer.citations.map((citation, index) => (
        <button key={index} className="btn" onClick={() => onJump(citation.page)}>
          {citation.kind === "clip" ? "我的摘录" : "原文"} · 第 {citation.page} 页
        </button>
      ))}
    </div>
  );
}

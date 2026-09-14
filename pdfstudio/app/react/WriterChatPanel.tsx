import { useCallback, useState, useSyncExternalStore } from "react";
import { Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
import type { WritingTalk } from "../../../blogstudio/src/conversation";
import type { WriterAnswer, WriterTurn } from "../../../blogstudio/src/writer-chat";
import type { Progress } from "../../src/app/progress";

/**
 * 写的时候在右边说话的那一栏——`talk.state` 的投影。
 *
 * 与「问文档」那一栏是同一个形状（`ChatPanel`），差别只在材料和出处：那边是这一篇 PDF
 * 的原文、出处是页码；这边是**正在写的稿子 + 从知识库召回的 context**，出处是 context。
 *
 * 状态只在应用层存一份（`blogstudio/src/conversation.ts`），这里只做渲染。
 */
export function WriterChatPanel({
  talk,
  progress,
  count,
}: {
  talk: WritingTalk;
  progress: Progress;
  /** 知识库里现在有多少条 context。空库时要说清楚，否则「一条都没召回」像是坏了。 */
  count: number | null;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => talk.subscribe(listener), [talk]),
    () => talk.state,
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
    await talk.send(text);
  }

  return (
    <div className="pane" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
      <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
        {state.turns.length === 0 && (
          <p className="muted">
            边写边问。它看得见整篇稿子；开着「联网」它会先搜一下，引用的网页写成链接，
            粘进正文时链接跟着一起走。
            {count !== null && count > 0 && " 知识库里相关的 context 也会当材料摆出来。"}
            <br />
            <br />
            <span className="faint">它只说，不动正文——改哪里由你自己落笔。</span>
          </p>
        )}

        {state.turns.map((turn, index) => (
          <Message key={index} turn={turn} />
        ))}

        {state.streaming !== null && (
          <div className="msg bot">
            {state.streaming === "" ? (
              <span className="muted">{working ?? "正在翻材料…"}</span>
            ) : (
              <Streamdown>{state.streaming}</Streamdown>
            )}
          </div>
        )}

        {!busy && state.answer && <Materials answer={state.answer} />}
        {!busy && state.answer && <Hits answer={state.answer} />}

        {state.error !== null && <pre className="err">{state.error}</pre>}
      </div>

      {/* 选中的那一段要看得见、能撤掉：看不见就不知道自己带了什么进去。 */}
      {state.quoted !== null && (
        <div style={{ padding: "0 10px 6px" }}>
          <div className="cite">
            <div className="what">
              带上选中的这一段一起问{" "}
              <button className="btn" onClick={() => talk.unquote()}>
                撤掉
              </button>
            </div>
            <div className="faint clamp2">{state.quoted}</div>
          </div>
        </div>
      )}

      <div className="composer">
        {/* 联网是这一问的事，不是设置里的事：查最新动态时要，改一句措辞时不要。 */}
        <label className="faint" title="发问前先联网搜一次，引用的网页写成链接">
          <input type="checkbox" checked={state.web} onChange={(event) => talk.setWeb(event.target.checked)} /> 联网
        </label>
        <textarea
          rows={2}
          className="grow"
          value={draft}
          placeholder="这段怎么改…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送，Shift+Enter 换行。中文输入法组词时的 Enter 不能当发送。
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button className="btn" onClick={() => talk.stop()}>
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

function Message({ turn }: { turn: WriterTurn }) {
  return (
    <div className={turn.role === "user" ? "msg me" : "msg bot"}>
      {turn.quoted !== undefined && <div className="quoted">{turn.quoted}</div>}
      {turn.role === "user" ? turn.text : <Streamdown>{turn.text}</Streamdown>}
    </div>
  );
}

/**
 * 用到的材料。**这是一条硬要求，不是装饰**：一段带着出处的话和一段没有出处的话，
 * 在稿子里的分量完全不同（`docs/workflow.md` §1.5——不存在既无 provenance 又未标记
 * authored 的断言）。
 *
 * 召回了却没被引用的也报一句数：那说明库里有相关的东西没被用上，值得自己去看一眼。
 */
function Materials({ answer }: { answer: WriterAnswer }) {
  const unused = answer.recalled.length - answer.cited.length;

  if (answer.cited.length === 0) {
    return (
      <div className="cite none">
        <div className="what">
          以上没有引用任何材料——它是照着你的稿子说的
          {unused > 0 && `（库里还召回了 ${unused} 条，它一条都没用上）`}
        </div>
      </div>
    );
  }

  return (
    <div className="cite">
      <div className="what">
        以上引用的材料
        {unused > 0 && ` · 另有 ${unused} 条召回了没用上`}
      </div>
      {answer.cited.map((context) => (
        <div key={context.id} className="material">
          <b>{context.claim ?? "（这条还没写断言）"}</b>
          <span className="evidence">{context.evidence}</span>
          <span className="faint">
            《{context.source.title}》{context.source.locator}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 联网查到的网页。**全列，不只列引用了的**：网页的引用是 markdown 链接，模型写没写、
 * 写对没写对都不好机器判；把搜到的摆出来，人自己对。搜不成那句也在这儿。
 */
function Hits({ answer }: { answer: WriterAnswer }) {
  if (answer.searchFailed !== null) {
    return (
      <div className="cite none">
        <div className="what">联网没搜成，以上是不带网页材料答的：{answer.searchFailed}</div>
      </div>
    );
  }
  if (answer.hits.length === 0) return null;
  return (
    <div className="cite">
      <div className="what">这一问联网查到的</div>
      {answer.hits.map((hit) => (
        <div key={hit.url} className="material">
          <a href={hit.url} target="_blank" rel="noreferrer">
            <b>{hit.title}</b>
          </a>
          <span className="evidence clamp2">{hit.content}</span>
        </div>
      ))}
    </div>
  );
}

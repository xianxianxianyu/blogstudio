import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Writer } from "../../../blogstudio/src/writing";
import type { WritingTalk } from "../../../blogstudio/src/conversation";
import type { Context } from "../../../contextstudio/src/context";
import { check, type Report } from "../../../blogstudio/src/checks";
import { outlineOf, type Heading } from "../../../blogstudio/src/outline";
import type { Progress } from "../../src/app/progress";
import { DraftEditor } from "./DraftEditor";
import { WriterChatPanel } from "./WriterChatPanel";
import { DraftPane } from "./DraftPane";

/**
 * 写这一篇——左边正文，右边两栏：**稿子**（查出来的问题、留过的版本）与**问稿子**。
 *
 * 与阅读页是同一个骨架，连右栏两栏的分法都一样（那边是「摘录 | 问文档」）：两侧是同一个
 * 应用的两种工作，不该有两套布局语言。
 */
export function DraftPage({
  writer,
  talk,
  progress,
  contexts,
  onBack,
}: {
  writer: Writer;
  talk: WritingTalk;
  progress: Progress;
  /**
   * 知识库现在有哪些 context。检查要拿正文里的 `[ctx:id]` 对着它核，右栏也用它的条数。
   * **读不出来要给 null**，不能给空数组——那会让每一条引用都变成「库里找不到」。
   */
  contexts: () => Promise<Context[]>;
  onBack: () => void;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => writer.subscribe(listener), [writer]),
    () => writer.state,
  );
  const [pane, setPane] = useState<"draft" | "chat">("draft");
  /**
   * 左边那块画布的 DOM 节点。**只用来滚动，不用来改内容**——改内容必须走编辑器自己的
   * 那条路（非受控，见 DraftEditor）。滚动不是编辑，为它多开一个命令接口不划算。
   */
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [pool, setPool] = useState<Context[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    contexts().then(
      (many) => alive && setPool(many),
      // 读不出来就是 null：检查那一层会跳过引用相关的两条，而不是满屏报「找不到」。
      () => alive && setPool(null),
    );
    return () => {
      alive = false;
    };
  }, [contexts]);

  /**
   * 查一遍。**在渲染期算，不放 effect 里**——`check` 是纯函数（正文 + 库进去，报告出来），
   * 而 effect 里 setState 会多触发一次渲染，React 的 lint 正是拦这个。
   *
   * 依赖就是**正文本身**（渲染期现取）。什么时候重渲染，什么时候重算——而重渲染发生在
   * 存住了、换稿子、正文被从外面换掉、库读回来这几拍上。**按键不重渲染**：正文压根
   * 不进 state（`writing.ts` 里说明了为什么），所以这一栏跟着的是人停手的那一拍，
   * 也就是他会抬眼看右栏的那一拍。
   */
  const text = state.openId === null ? null : writer.text();
  const report: Report | null = useMemo(
    () => (text === null ? null : check(text, pool)),
    [text, pool],
  );
  const outline: Heading[] = useMemo(() => (text === null ? [] : outlineOf(text)), [text]);

  /**
   * 点大纲跳过去：按**第几个标题**找 DOM 里的第几个 `h1`–`h6`。
   *
   * 不按行号找位置：markdown 的行与 ProseMirror 的文档位置之间没有现成的映射，自己维护
   * 一份迟早会与正文错位（而错位时不会报错，只会跳到别处）。标题的顺序则是一一对应的
   * ——第 n 个标题就是第 n 个标题，正文怎么改都成立。
   */
  const jumpTo = (headingIndex: number) => {
    const headings = stage?.querySelectorAll("h1, h2, h3, h4, h5, h6");
    headings?.[headingIndex]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (state.openId === null) return null;

  /** 留一版 / 取回旧版都会写盘，跑的时候把两个按钮按住，别让人点出两条并发的写。 */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="book-view">
      <div className="topbar">
        <button className="btn" onClick={onBack}>
          ← 稿子
        </button>
        <div className="title grow">{state.title}</div>

        {/* 顶栏没有设置按钮：设置在外壳左下角，同一张表两个入口正是要躲的毛病。 */}
        <span className={state.error !== null ? "err" : "faint"}>
          {state.error !== null ? `没存住：${state.error}` : SAVED[state.status]}
        </span>
      </div>

      <div className="panes">
        <div className="stage paper" ref={setStage}>
          {/* `key` 换了才换文本：编辑器是非受控的（见 DraftEditor）。换稿子换 `openId`，
              取回旧版和打记号换 `epoch`——日常打字两个都不动。 */}
          <DraftEditor
            key={`${state.openId}:${state.epoch}`}
            initial={writer.text()}
            onChange={(markdown) => writer.edit(markdown)}
            onSelect={(text) => (text === "" ? talk.unquote() : talk.quote(text))}
          />
        </div>

        <div className="side">
          <div className="seg">
            <button className={pane === "draft" ? "on" : undefined} onClick={() => setPane("draft")}>
              稿子 {report && report.findings.length > 0 && `· ${report.findings.length}`}
            </button>
            <button className={pane === "chat" ? "on" : undefined} onClick={() => setPane("chat")}>
              问稿子
            </button>
          </div>

          {pane === "draft" ? (
            <DraftPane
              outline={outline}
              report={report}
              onJump={jumpTo}
              revisions={state.revisions}
              busy={busy}
              onMarkAuthored={(line) => writer.markAuthored(line)}
              onSnapshot={() => void run(() => writer.snapshot("留一版"))}
              onRestore={(n) => void run(() => writer.restore(n))}
            />
          ) : (
            <WriterChatPanel talk={talk} progress={progress} count={pool?.length ?? null} />
          )}
        </div>
      </div>
    </div>
  );
}

const SAVED: Record<"saved" | "dirty" | "saving", string> = {
  saved: "已保存",
  dirty: "还没存",
  saving: "正在保存…",
};

import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

/**
 * 所见即所得的 markdown 编辑器（Milkdown 的 Crepe，见 `blogstudio/docs/adr/0001`）。
 *
 * **它是非受控的。** ProseMirror 这一类编辑器自己就是文本的持有者：每次按键把 React 里
 * 的值再灌回去，光标会当场跳到开头，输入法组词也会被打断。所以这里的数据流是反的——
 * 只在挂载时给一次初始值，之后由编辑器把新文本报上来。
 *
 * 换一篇稿子靠**外面给一个新的 `key`** 来整段重建，而不是改 `initial`：`initial` 不在
 * 依赖里，改它什么也不会发生，那种「传了没生效、也不报错」正是这一路上反复躲的东西。
 */
export function DraftEditor({
  initial,
  onChange,
  onSelect,
}: {
  /** 挂载时的正文。**之后改它无效**，见上。 */
  initial: string;
  onChange: (markdown: string) => void;
  /** 选中的正文，没选就是空串。「问这一段」的入口。 */
  onSelect: (text: string) => void;
}) {
  /**
   * 挂编辑器的那个节点。**用回调 ref 存进 state，不用 `useRef`**：切走再切回来是一个
   * 新的 DOM 节点，而 `useRef` 不会通知任何人，编辑器就会挂在一个已经脱离文档的节点上
   * （App.tsx 里的 `.stage` 为同一个理由踩过一次）。
   */
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  // 回调每次渲染都是新的，但编辑器只建一次——用 ref 取最新的那个，别把它写进依赖里，
  // 否则每渲染一次就重建一次编辑器。
  const changed = useRef(onChange);
  const selected = useRef(onSelect);
  useEffect(() => {
    changed.current = onChange;
    selected.current = onSelect;
  }, [onChange, onSelect]);

  useEffect(() => {
    if (!host) return;
    const crepe = new Crepe({
      root: host,
      defaultValue: initial,
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: "第一行写标题，它就是这篇稿子的名字…" },
      },
    });

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => changed.current(markdown));
      listener.selectionUpdated((ctx, selection) => {
        // 光标只是挪了一下（没框住东西）就是「没有选区」。这条快路顺带躲开了下面那个
        // 越界问题的绝大多数情形——光标移动比框选频繁得多。
        if (selection.empty) {
          selected.current("");
          return;
        }
        // 取 ProseMirror 自己的选区，而不是 `window.getSelection()`：后者在代码块、
        // 表格这些嵌套结构里给的是渲染后的文本，拿回来的东西跟正文对不上。
        const view = ctx.get(editorViewCtx);
        // **位置要夹一下**：这个回调拿到的 selection 与此刻 view 里的文档可能差着一拍
        // （换稿子、取回旧版都会整篇换掉），越界的位置会让 textBetween 在
        // `nodesBetween` 里读一个 undefined 的节点当场抛——实测就是这么炸的，
        // 而它一炸，整个编辑器的这次更新就断在半路。
        const size = view.state.doc.content.size;
        const from = Math.min(selection.from, size);
        const to = Math.min(selection.to, size);
        selected.current(from < to ? view.state.doc.textBetween(from, to, "\n") : "");
      });
    });

    // `create()` 是异步的：卸载可能发生在它落地之前（StrictMode 下必然如此），
    // 所以要等它建完再拆，否则拆的是一个还不存在的编辑器。
    const created = crepe.create();
    return () => {
      void created.then(() => crepe.destroy());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial 只在挂载时用，见上面的注释
  }, [host]);

  return <div className="draft-editor" ref={setHost} />;
}

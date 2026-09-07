import { useEffect, useRef, useState } from "react";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { imageBlock } from "@milkdown/crepe/feature/image-block";
import { latex } from "@milkdown/crepe/feature/latex";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { editorViewCtx } from "@milkdown/kit/core";
import { languages } from "@codemirror/language-data";
import { codeLook } from "./code-theme";
import { renderDiagram } from "./mermaid-view";
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
  onUploadImage,
}: {
  /** 挂载时的正文。**之后改它无效**，见上。 */
  initial: string;
  onChange: (markdown: string) => void;
  /** 选中的正文，没选就是空串。「问这一段」的入口。 */
  onSelect: (text: string) => void;
  /**
   * 粘进来的图存到哪，回报正文里该写的路径。
   *
   * **不接这个的后果是静悄悄的**：Crepe 的默认实现返回 `URL.createObjectURL(file)`，
   * 也就是一个 `blob:` URL——它只在这一个窗口的这一次会话里有效，**关窗即死**，
   * 而它会照常被存进文章文件、跟着同步上公网，变成一张永远坏掉的图。
   */
  onUploadImage: (file: File) => Promise<string>;
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
  const uploader = useRef(onUploadImage);
  useEffect(() => {
    changed.current = onChange;
    selected.current = onSelect;
    uploader.current = onUploadImage;
  }, [onChange, onSelect, onUploadImage]);

  useEffect(() => {
    if (!host) return;
    /**
     * **用 `CrepeBuilder` 而不是 `Crepe`，为的是甩掉 One Dark。**
     *
     * `Crepe` 会拿 `defaultsDeep(你的配置, 它的默认配置)` 合并，而它的默认配置里写死了
     * `theme: oneDark`。实测过：传数组它按下标补齐、传对象它把 oneDark 的两项塞成
     * `"0"` / `"1"` 属性——**「换主题」这件事在那个入口上根本做不到**。
     *
     * 代价只有下面这十行。查过 `Crepe` 的默认配置**只给 CodeMirror 一个 key 配了东西**
     * （`theme` 与 `languages`），别的 feature 全是自带默认值，所以不走它什么都不丢。
     *
     * **顺序照抄 Crepe 自己的顺序，尤其是 latex 必须排在 code-mirror 后面**：latex 会
     * 接住链上前一个的 `renderPreview` 再往上包（`latex` 自己认，其余的往下传，
     * 也就是传给 mermaid），而且 CodeMirror 没启用时它直接抛。
     */
    const crepe = new CrepeBuilder({ root: host, defaultValue: initial })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(imageBlock, { onUpload: (file) => uploader.current(file) })
      .addFeature(blockEdit)
      .addFeature(placeholder, { text: "第一行写标题，它就是这篇稿子的名字…" })
      .addFeature(toolbar)
      .addFeature(codeMirror, {
        // 一百多种语言，每一种的语法解析器都是用到才去下载的（`LanguageDescription.load`），
        // 所以这一行不会把它们打进包里。
        languages,
        // 排在 `basicSetup` 后面，所以盖得住默认那套配色。
        extensions: codeLook,
        renderPreview: renderDiagram,
        searchPlaceholder: "找语言",
        noResultText: "没有这种语言",
        copyText: "复制",
        previewLabel: "预览",
        previewToggleText: (previewOnly) => (previewOnly ? "改" : "收起"),
        // **不设 `previewOnlyByDefault`。** 设成 true 的话，你新建一个 mermaid 块、
        // 刚打出第一行能解析的语法，源码就当场被图盖住了——**正在写的东西不能藏**。
        // 想只看图，每一块自己有那个切换按钮。
      })
      .addFeature(table)
      .addFeature(latex, {
        katexOptions: {
          // **一定要 false。** 公式是一个字一个字打出来的，中间每一拍都是残缺的
          // LaTeX；抛异常的话编辑器这一次更新就断在半路。false 是把画不出来的地方
          // 标红留在原地，正是所见即所得该有的反馈。
          throwOnError: false,
          // 不认识的宏当普通文本处理，别为了一个拼错的 \alpah 整块罢工。
          strict: false,
        },
        inlineEditConfirm: "好",
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

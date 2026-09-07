import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * 代码块的样子。**每一个颜色都是 `var(--code-…)`，一个字面色都没有。**
 *
 * 这是「跟随系统深浅」唯一能做对的写法。CodeMirror 的主题是一个 extension，换主题要重配
 * 编辑器——而 macOS 日落会自动切深色，重配就等于**在读者打字打到一半把光标甩回开头**。
 * 把值挪进 CSS 之后，切换是浏览器自己的事：一套 extension，两套值（`app.css` 里那段
 * `@media (prefers-color-scheme: dark)`），瞬时，且编辑器完全不知道发生过。
 *
 * 顺带也就换掉了 Crepe 默认的 One Dark——它的颜色是写死的，做不到上面这件事。
 * （而且 `Crepe` 那个入口也塞不进来：它用 `defaultsDeep` 合并配置，传数组按下标补齐、
 * 传对象把 One Dark 的两项塞成 `"0"`/`"1"` 属性。所以 `DraftEditor` 走的是 `CrepeBuilder`。）
 */
const surface = EditorView.theme({
  "&": {
    background: "var(--code-bg)",
    color: "var(--code-ink)",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "var(--mono)",
    padding: "10px 0",
  },
  ".cm-gutters": {
    background: "var(--code-bg)",
    color: "var(--code-gutter)",
    border: "none",
  },
  // 光标不在这一行时不要画条带：代码块躺在正文里，一条常驻的高亮会把它读成「选中的东西」。
  ".cm-activeLine": { background: "transparent" },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--code-ink)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    background: "var(--code-select)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    background: "var(--code-select)",
    outline: "none",
  },
  ".cm-scroller": { lineHeight: "1.6" },
});

/**
 * 词法着色。**只分七类**，不是把 lezer 的几十个 tag 都点一遍。
 *
 * 代码块在一篇稿子里是配角：它要让人一眼看出「这是代码、这几个词是关键字」，不是替代 IDE。
 * 类别少的另一个好处是深浅两套值各自只有七个数，改配色时两边不会漂。
 */
const words = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: "var(--code-key)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--code-str)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-num)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--code-note)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--code-fn)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--code-type)" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "var(--code-mark)" },
]);

/** 装进 `codeMirror` feature 的 `extensions`——它排在 `basicSetup` 后面，所以能盖住默认那套。 */
export const codeLook: Extension[] = [surface, syntaxHighlighting(words)];

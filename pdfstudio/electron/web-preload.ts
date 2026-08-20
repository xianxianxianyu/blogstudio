import { ipcRenderer } from "electron";

/**
 * 注入到被打开网页里的选区叠层。
 *
 * **必须是 preload，不能用 `executeJavaScript`。** 后者跑在**主世界**——与页面自己的
 * 脚本共处一个 JS 环境，页面可以 hook `Range.prototype.toString`、
 * `getBoundingClientRect`、`JSON.stringify` 里的任何一个。**一个恶意站点完全可以让
 * 我们的摘录存下与读者所选完全不同的文字**（`docs/research-web-anchoring.md` §4.2，
 * 该结论是翻 Electron 源码坐实的，文档没有明说）。
 *
 * preload 在 `contextIsolation` 下跑在独立世界里，用的正是 Chrome Content Script 那套
 * 模型：**JS 全局与内置对象分离，DOM 共享**。所以这里照样能读选区、插叠层元素，
 * 而页面动不了我们的 `Array.prototype`。这恰好是需要的隔离级别。
 *
 * **沙箱下没有 `fs`/`path`**（Electron 20 起 `sandbox: true` 是默认），一切落盘走 IPC
 * 回主进程；也不能拆成多个文件，必须打包成单文件。
 */

/** 整页正文纯文本。orphan 之后唯一能「在当时的页面里重新搜」的东西。 */
function pageText(): string {
  return document.body?.innerText ?? "";
}

/**
 * 选区在正文里的字符偏移。
 *
 * 用 `innerText` 而不是 `textContent`：前者是**渲染后**的文本，与读者眼睛看到的一致；
 * 后者会把 `display: none` 的内容也算进来，于是偏移与肉眼所见对不上。
 */
function offsetsOf(selection: Selection): { start: number; end: number } | null {
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(document.body);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}

function report(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

  const text = selection.toString().trim();
  if (text === "") return;

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  ipcRenderer.send("studio:selection", {
    text,
    offsets: offsetsOf(selection),
    // 视口坐标。主进程把视图的位置加上去才是窗口坐标——**换算不在这里做**，
    // 这里不知道自己被摆在哪儿。
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    pageText: pageText(),
    url: location.href,
    title: document.title,
    viewportWidth: window.innerWidth,
  });
}

// 松手才报，不在拖动过程中报：`selectionchange` 每移动一个字符就触发一次。
document.addEventListener("pointerup", () => setTimeout(report, 0));
document.addEventListener("keyup", (event) => {
  if (event.shiftKey) setTimeout(report, 0);
});

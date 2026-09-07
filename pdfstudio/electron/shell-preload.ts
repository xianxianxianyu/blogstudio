import { contextBridge, ipcRenderer } from "electron";

/**
 * 主窗口的桥：只为**浏览器视图**存在。
 *
 * ## 为什么这一条不走本机 API（与 ADR-0014 的关系）
 *
 * ADR-0014 定的是「dev server 与打包应用共用一份本机 API」，理由是**两份适配器是
 * 「写好了没接上」的同一个形状，而且更隐蔽：dev 下全绿，打包后才出问题**。那条针对的是
 * **数据**——摘录、配置、模型、索引，它们在两种形态下都必须能用。
 *
 * 浏览器视图不是数据，是**原生能力**：`WebContentsView` 是 Electron 的东西，
 * dev server 里根本不存在这个概念，就像窗口本身一样。**没有第二份实现可写，也就没有
 * 两份会漂移的适配器。** 在浏览器里打开 `/react.html` 时这个功能干脆不存在，
 * 而那是诚实的——那时确实没有容器。
 *
 * 另一个硬理由：`setBounds` 是**高频**的（窗口缩放、侧栏折叠、每次布局变化），
 * 走 HTTP 每次都要一个请求往返，而且主进程还得**反向推**导航与选区事件回来——
 * HTTP 那条路上没有反向通道。
 *
 * ## 桥面要窄
 *
 * 只暴露这几个方法，不暴露 `ipcRenderer` 本身。暴露 `ipcRenderer` 等于把整个 IPC
 * 通道交给渲染进程里的任何一段代码（包括将来某个依赖）。
 */
const EVENTS = ["studio:web:navigated", "studio:web:blocked", "studio:web:selection"] as const;

contextBridge.exposeInMainWorld("studioWeb", {
  open: (url: string) => ipcRenderer.invoke("studio:web:open", url),
  /** 视图摆在窗口的哪一块（窗口坐标）。高频，用 send 不用 invoke。 */
  bounds: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("studio:web:bounds", rect),
  close: () => ipcRenderer.send("studio:web:close"),
  /** 订阅导航、拦截、选区三类事件。返回退订函数。 */
  on: (handler: (event: { type: string; payload: unknown }) => void) => {
    const listeners = EVENTS.map((name) => {
      const listener = (_e: unknown, payload: unknown) => handler({ type: name, payload });
      ipcRenderer.on(name, listener);
      return () => ipcRenderer.off(name, listener);
    });
    return () => listeners.forEach((off) => off());
  },
});

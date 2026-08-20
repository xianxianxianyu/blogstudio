import { WebContentsView, shell } from "electron";
import type { BaseWindow, Rectangle } from "electron";
import { allows } from "../src/web/allow";

/**
 * 应用内的浏览器视图。
 *
 * **用 `WebContentsView`，不用 `<webview>`。** 官方在 `<webview>` 页面第一段就写着
 * *"We currently recommend to not use the `webview` tag"*；`BrowserView` 在 Electron 30
 * 已废弃。而且 `<webview>` 的每次方法调用都要一次**同步 IPC**，拖框这种高频交互
 * 直接不能接受（`docs/research-web-anchoring.md` §4.1）。
 *
 * ## 安全姿态从第一行摆好，不是事后补
 *
 * Electron 官方对「显示网站」这件事本身有保留：*"If your goal is to display a website,
 * a browser will be a more secure option"*——因为 Electron 里 Safe Browsing 与
 * Certificate Transparency **都是关的**。所以：
 *
 * - **只加载读者显式加过的站点**（`allows`），别的一概拦下
 * - 站外链接交给系统浏览器，不在应用内打开
 * - 不开 `nodeIntegration`，开 `contextIsolation` 与 `sandbox`
 * - 一切权限请求（摄像头、麦克风、通知、地理位置…）**一律拒绝**
 * - 不许开新窗口
 */
export interface WebViewHandle {
  load(url: string): void;
  setBounds(bounds: Rectangle): void;
  /** **必须调**：`BaseWindow` 文档明说不显式关掉 `webContents` 会漏内存。 */
  close(): void;
}

export function createWebView(
  window: BaseWindow,
  options: {
    /** 允许加载的站点。变了要重新传——不缓存，读者随时会加。 */
    sites: () => readonly string[];
    preload: string;
    onBlocked: (url: string) => void;
    onNavigated: (info: { url: string; title: string }) => void;
  },
): WebViewHandle {
  const view = new WebContentsView({
    webPreferences: {
      preload: options.preload,
      // 三条一起：远程内容拿不到 Node，跑在独立的 JS 世界里，且在沙箱内。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 子框架里不给 Node——开了的话每个第三方 iframe 都拿到 IPC 通道。
      nodeIntegrationInSubFrames: false,
      // **不关 webSecurity**。关掉等于取消同源策略。
      webSecurity: true,
    },
  });
  window.contentView.addChildView(view);

  const contents = view.webContents;

  // 拦在导航之前，而不是加载之后：`will-navigate` 是页面自己发起的跳转
  // （点链接、脚本 location=），`will-redirect` 是服务端 3xx——两条都要拦，
  // 否则一个允许的站点可以把我们重定向到任何地方。
  const gate = (event: { preventDefault(): void }, url: string) => {
    if (allows(options.sites(), url)) return;
    event.preventDefault();
    options.onBlocked(url);
  };
  // 两条都要拦，签名不同所以分开写：`will-navigate` 是页面自己发起的跳转，
  // `will-redirect` 是服务端 3xx——只拦前者的话，一个允许的站点可以用一个 302
  // 把我们送到任何地方。
  contents.on("will-navigate", (event, url) => gate(event, url));
  contents.on("will-redirect", (event, url) => gate(event, url));

  // 新窗口一律不开。站外链接交给系统浏览器——**那里有 Safe Browsing，这里没有**。
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 权限请求一律拒绝。一个用来读文章的视图不需要摄像头、麦克风、通知或地理位置。
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);

  contents.on("did-navigate", () => {
    options.onNavigated({ url: contents.getURL(), title: contents.getTitle() });
  });
  contents.on("page-title-updated", (_event, title) => {
    options.onNavigated({ url: contents.getURL(), title });
  });

  return {
    load(url) {
      if (!allows(options.sites(), url)) {
        options.onBlocked(url);
        return;
      }
      void contents.loadURL(url);
    },
    setBounds(bounds) {
      view.setBounds(bounds);
    },
    close() {
      window.contentView.removeChildView(view);
      // 不显式关就漏内存（`BaseWindow` 文档原话）。读者会开很多页，这条很要紧
      // ——跟 llama-server 那些孤儿是同一类问题。
      contents.close();
    },
  };
}

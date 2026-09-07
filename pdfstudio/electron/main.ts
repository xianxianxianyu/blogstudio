import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFileSync, renameSync, statSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createWebView, type WebViewHandle } from "./web-view";
import { createLocalApi } from "../src/server/local-api";
import { errorChain } from "../src/app/error-chain";

/**
 * **必须在模块顶层、任何 getPath 之前。**
 *
 * `getPath("userData")` 用 package.json 的 `name`（`pdf-studio`），而数据目录早已叫
 * 「PDF Studio」——改了这一句，读者的书和摘录就会落进另一个目录。放在
 * `whenReady` 之后调用是没用的：那时 Electron 已经把 userData 定好了（试过一次）。
 */
app.setName("PDF Studio");

/**
 * 打包应用的主进程。
 *
 * 本机 API 与 dev server **共用同一份实现**（ADR-0014）：这里只是把同一批中间件挂到一个
 * 裸 http.Server 上。写两份适配器（dev 走 HTTP、打包走 IPC）是这个项目已经反复踩过的
 * 「写好了没接上」的同一个形状，而且更隐蔽——dev 下全绿，打包后才出问题。
 *
 * 数据放系统的应用数据目录（`app.getPath("userData")`），不是安装目录：安装目录在
 * macOS 上位于 /Applications，对普通用户不可写，而且升级时会被整个替换掉——读者的书和
 * 摘录不能跟着版本走。
 */
function dataPaths() {
  const root = app.getPath("userData");
  return {
    libraryRoot: path.join(root, "library"),
    modelsRoot: path.join(root, "models"),
    configFile: path.join(root, "config.json"),
    // pdf.js 的静态资源**跟着应用走，不跟着数据走**：它由版本决定，不是读者的东西。
    // node_modules 整个不进安装包（electron-builder.yml），所以构建时拷进了 dist/pdfjs。
    pdfjsRoot: path.join(app.getAppPath(), "pdfjs"),
  };
}

/**
 * 只绑 127.0.0.1，端口交给系统随机分配。
 *
 * 绑 0.0.0.0 会让同一网络里的任何人读到读者的摘录、甚至读到配置里的 apiKey
 * （ADR-0005）。固定端口则会在开着两个实例时撞车。
 */
/** 连上本机 API 需要的两样东西：地址和写保护的令牌。**一起给**，漏一个就是 403。 */
function startApi(): Promise<{ api: string; token: string }> {
  const paths = dataPaths();
  /**
   * 写保护的令牌，**每次启动新生成**（`src/server/guard.ts`）。
   *
   * 跟着地址一起从查询串进页面：注入路径已经在那儿了，而且它在页面脚本开始执行
   * **之前**就位——`executeJavaScript` 那条路会有竞态，适配器可能已经发出第一批请求。
   *
   * 网页拿不到它：它只活在主进程和我们自己那个 `file://` 页面的 URL 里。
   */
  const token = randomUUID();
  note(`数据目录 ${app.getPath("userData")}`);
  // 向量必须跑在 utilityProcess 里：onnxruntime-node 在主进程上加载并推理会直接
  // EXC_BREAKPOINT（实测崩溃点在 CrBrowserMain）。
  // 向量由本机 API 自己拉起 llama-server（与识别共用同一个二进制），主进程不碰
  // 任何原生推理库——onnxruntime-node 在 Electron 的进程里跑不起来，那条路已退役。
  const { routes, shutdown } = createLocalApi({ ...paths, token });
  note("本机 API 已构造");

  // **退出时停掉本地引擎。** 不停的话它们被系统收养，一个占 3 GB 继续跑着；实测重启
  // 五次留下四个孤儿、14 GB、机器卡死。`before-quit` 而不是 `window-all-closed`：
  // 后者在 ⌘Q 那条路上不一定先触发。
  //
  // 这条只管正常退出。被强杀或者崩溃时它跑不到——那种情况靠下次启动收尸
  // （`engine-registry.ts`），两条都要有。
  let stopped = false;
  const stopEngines = (why: string) => {
    if (stopped) return;
    stopped = true;
    note(`${why}，停掉本地引擎`);
    shutdown();
  };

  app.on("before-quit", () => stopEngines("退出"));
  // **`before-quit` 只走 ⌘Q / 关窗那条路，SIGTERM 下根本不触发**（实测：pkill 之后
  // 4 GB 的 llama-server 照样留着）。开发时的重启、以及系统关机，走的都是信号这条。
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      stopEngines(signal);
      app.quit();
      // Electron 在信号下不保证走完退出流程，兜一手；引擎已经停了，直接走也安全。
      setTimeout(() => process.exit(0), 500).unref();
    });
  }

  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    // 最长前缀优先：`/__models/__status` 必须排在 `/__models` 之前，否则状态查询会被
    // 静态文件服务接走，然后 404。
    const match = [...routes]
      .sort((a, b) => b.prefix.length - a.prefix.length)
      .find((route) => url === route.prefix || url.startsWith(`${route.prefix}/`));

    if (!match) {
      response.statusCode = 404;
      response.end("no route");
      return;
    }
    // 中间件按「前缀已被剥掉」的约定写（vite 的 middlewares 就是这个约定），
    // 这里要保持一致，否则路径会多出一段而处处对不上。
    request.url = url.slice(match.prefix.length) || "/";
    match.handler(request, response);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token });
    });
  });
}

/**
 * 启动过程写进日志文件。
 *
 * 打包应用没有终端——console 里的东西读者和排查的人都看不到，而一个「活着但没有窗口」
 * 的进程在外面看来就是「点了图标什么都没发生」。这条路踩过一次：主进程未捕获的
 * rejection 让 startApi 停在半路，而外部什么线索都没有。
 */
function note(line: string): void {
  const file = path.join(app.getPath("userData"), "startup.log");
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  console.log(`[pdfstudio] ${line}`);
}

/**
 * 启动日志超过 1 MB 就换一份：老的改名成 `.1`（只留一份），新的从头写。
 *
 * `note` 是只追加的，不轮转的话它会一直长——两周就是两千行。放在启动时做而不是
 * 每次 `note` 时查，是因为一次启动写不了几行，够不着这个上限。
 */
function rotateLog(): void {
  const file = path.join(app.getPath("userData"), "startup.log");
  try {
    if (statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {
    // 还没有日志，或者读不到——都不值得为此不启动。
  }
}

async function createWindow(): Promise<void> {
  rotateLog();
  note("createWindow 开始");
  const { api, token } = await startApi();
  note(`本机 API ${api}`);

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "PDF Studio",
    webPreferences: {
      // 渲染侧不需要 Node：数据一律通过本机 API 说话，与开发形态完全一致。
      nodeIntegration: false,
      contextIsolation: true,
      // 桥只为**浏览器视图**存在——那是原生能力，不是数据（见 shell-preload.ts 里
      // 关于 ADR-0014 的那段）。桥面很窄，且不暴露 ipcRenderer 本身。
      preload: path.join(import.meta.dirname, "shell-preload.js"),
    },
  });

  wireWebView(window, api, token);


  /**
   * 把渲染进程的报错转发到主进程日志。
   *
   * 渲染进程一挂就是**白屏**，而主进程日志里什么都没有——只能靠猜是哪一行。这条
   * 加上之后，那类问题第一时间就能看见。
   */
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) note(`渲染进程 ${source}:${line} ${message}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    note(`渲染进程没了：${details.reason}`);
  });

  // 外链走系统浏览器，别在应用窗口里打开——那会把应用变成一个没有地址栏的浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // API 地址通过查询串传给渲染侧：`file://` 下没有 origin，相对路径直接失效。
  // 不用 executeJavaScript 注入——那在页面脚本开始执行**之后**才跑，适配器可能已经
  // 发出第一批请求了，而这种竞态只在打包形态下偶发，最难查。
  const devServer = process.env.PDFSTUDIO_DEV_SERVER;
  if (devServer) {
    // 开发时指向 vite，享受热更新；本机 API 仍由这个进程提供，与打包形态同一份实现。
    await window.loadURL(`${devServer}/?api=${encodeURIComponent(api)}&token=${token}`);
  } else {
    await window.loadFile(path.join(import.meta.dirname, "renderer/index.html"), {
      search: `api=${encodeURIComponent(api)}&token=${token}`,
    });
  }
}

/**
 * 浏览器视图的接线：开、摆位置、关，以及把事件推回渲染进程。
 *
 * **同一时刻只留一个视图。** 案头上可以有多个网页条目，但只有活着的那一个需要渲染
 * ——切过去就 `load()` 到新地址。代价是**丢滚动位置**，这是这一版明确接受的：
 * 多留几个视图意味着多份内存和多个后台在跑的页面（还会自己播视频、发请求），
 * 而 `BaseWindow` 文档已经警告过不显式关就漏内存。
 */
function wireWebView(window: BrowserWindow, api: string, token: string): void {
  let view: WebViewHandle | null = null;
  let sites: string[] = [];

  const send = (channel: string, payload: unknown) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  /** 允许的站点在本机 API 那边（跟着配置走），每次开之前现取——读者随时会加。 */
  async function loadSites(): Promise<void> {
    try {
      const response = await fetch(`${api}/__sites`, { headers: { "x-studio-token": token } });
      sites = response.ok ? ((await response.json()) as string[]) : [];
    } catch {
      sites = [];
    }
  }

  function ensure(): WebViewHandle {
    view ??= createWebView(window, {
      sites: () => sites,
      preload: path.join(import.meta.dirname, "web-preload.js"),
      onBlocked: (url) => send("studio:web:blocked", { url }),
      onNavigated: (info) => send("studio:web:navigated", info),
    });
    return view;
  }

  ipcMain.handle("studio:web:open", async (_event, url: string) => {
    await loadSites();
    ensure().load(url);
    return { ok: true };
  });

  // 高频：窗口缩放、侧栏折叠、切换案头条目都会发。用 send 不用 invoke。
  ipcMain.on("studio:web:bounds", (_event, rect: Electron.Rectangle) => {
    // 还没开过视图时忽略——不要为了「摆位置」把一个空视图创建出来，
    // 那会在读者根本没打开网页时凭空多一个渲染进程。
    view?.setBounds(rect);
  });

  ipcMain.on("studio:web:close", () => {
    view?.close();
    view = null;
  });

  // 选区从被打开的网页的 preload 直接来，原样转给渲染进程。
  ipcMain.on("studio:selection", (_event, payload: unknown) => send("studio:web:selection", payload));

  // 窗口没了要把视图一起收掉，否则它的 webContents 继续活着（同 llama-server 那类孤儿）。
  window.on("closed", () => {
    view?.close();
    view = null;
  });
}

app.whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    // **主进程里未捕获的 rejection = 一个活着但没有窗口的进程。** 读者看到的是
    // 「点了图标什么都没发生」，日志里一个字都没有。宁可弹个框说清楚。
    const message = errorChain(error) || String(error);
    note(`启动失败 ${message}`);
    dialog.showErrorBox("PDF Studio 启动失败", message);
    app.quit();
  });

app.on("window-all-closed", () => {
  // macOS 的惯例是关窗不退出，但这是个单窗口工具应用——留一个没有窗口的进程在后台，
  // 读者只会觉得它没退干净。
  app.quit();
});

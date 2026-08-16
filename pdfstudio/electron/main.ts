import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { createLocalApi } from "../src/server/local-api";

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
  };
}

/**
 * 只绑 127.0.0.1，端口交给系统随机分配。
 *
 * 绑 0.0.0.0 会让同一网络里的任何人读到读者的摘录、甚至读到配置里的 apiKey
 * （ADR-0005）。固定端口则会在开着两个实例时撞车。
 */
function startApi(): Promise<string> {
  const routes = createLocalApi(dataPaths());

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
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function createWindow(): Promise<void> {
  const api = await startApi();
  // 打出来好排查：端口是随机的，出问题时读者能直接 curl 一下看是主进程还是界面的事。
  console.log(`[pdfstudio] 本机 API ${api}`);
  console.log(`[pdfstudio] 数据目录 ${app.getPath("userData")}`);

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "PDF Studio",
    webPreferences: {
      // 渲染侧不需要 Node：它只通过本机 API 说话，与开发形态完全一致。
      nodeIntegration: false,
      contextIsolation: true,
    },
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
    await window.loadURL(`${devServer}/react.html?api=${encodeURIComponent(api)}`);
  } else {
    await window.loadFile(path.join(import.meta.dirname, "../renderer/react.html"), {
      search: `api=${encodeURIComponent(api)}`,
    });
  }
}

void app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  // macOS 的惯例是关窗不退出，但这是个单窗口工具应用——留一个没有窗口的进程在后台，
  // 读者只会觉得它没退干净。
  app.quit();
});

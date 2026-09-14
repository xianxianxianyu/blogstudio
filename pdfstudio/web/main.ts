import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createWritingApi } from "../src/server/writing-api";
import { guarded, type Route } from "../src/server/http";

/**
 * `/write` 的服务端：**只有写作那一半**（`writing-api.ts`），加一份静态的 `write.html`。
 *
 * 它站在 Panel（research.moyutianzun.com）后面：Panel 验过 session 之后把 `/write/*`
 * 转给它，转发时带一个共享密钥头。这里**只信那个头**，自己一行登录代码都没有——
 * 账号、密码、2FA、限流全是 Panel 的（research-panel `deploy/README.md`）。
 *
 * 只听 127.0.0.1。同一台机器上的别的进程（robot 的执行器）拿不到密钥，也就进不来。
 *
 * 环境变量（systemd 的 EnvironmentFile 给）：
 *   WRITE_PORT          默认 8095
 *   WRITE_DATA_ROOT     数据根：config.json / destinations.json / contexts/ / loops/ / 索引
 *   WRITE_RENDERER      构建好的渲染层目录（含 write.html 与 assets/）
 *   WRITE_SHARED_SECRET Panel 转发时带在 `x-write-secret` 头里的那个值。**必填**
 */
const PREFIX = "/write";
const SECRET_HEADER = "x-write-secret";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`缺环境变量 ${name}`);
  return value;
}

const port = Number(env("WRITE_PORT", "8095"));
const dataRoot = env("WRITE_DATA_ROOT");
const renderer = env("WRITE_RENDERER");
const secret = env("WRITE_SHARED_SECRET");

const api = createWritingApi({ dataRoot, configFile: path.join(dataRoot, "config.json") });
// 写保护令牌留空：跨站写的防线在 Panel（session cookie 是 SameSite=Lax）和那个
// 共享密钥头上，不在页面 URL 里再塞一个令牌。
const routes: Route[] = guarded(api.routes, "");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

/** 静态文件：只出 `write.html` 和 `assets/`，**不出 `index.html`**——那是桌面版的入口，这台机器上跑不起来。 */
async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const wanted = pathname === "/" || pathname === "" ? "/write.html" : pathname;
  if (!(wanted === "/write.html" || wanted.startsWith("/assets/"))) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  const file = path.join(renderer, path.normalize(wanted));
  // 别让 `..` 走出渲染层目录。
  if (!file.startsWith(renderer)) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  try {
    await stat(file);
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    response.setHeader("content-type", type);
    // 带哈希的资源永久缓存；页面本身不缓存，否则发新版之后旧页面会引用已经不在的 chunk。
    response.setHeader("cache-control", wanted.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  if (request.headers[SECRET_HEADER] !== secret) {
    response.statusCode = 403;
    response.end("只接受来自 Panel 的请求。");
    return;
  }
  const full = request.url ?? "/";
  if (!(full === PREFIX || full.startsWith(`${PREFIX}/`) || full.startsWith(`${PREFIX}?`))) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  const url = full.slice(PREFIX.length) || "/";
  const pathname = url.split("?")[0];

  // 最长前缀优先（同 `electron/main.ts`）：`/__blog/images` 不能被 `/__blog` 之外的谁接走。
  const match = [...routes]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
  if (match) {
    // 中间件按「前缀已被剥掉」的约定写（vite 的 middlewares 就是这个约定）。
    request.url = url.slice(match.prefix.length) || "/";
    match.handler(request, response);
    return;
  }
  void serveStatic(pathname, response);
}

const server = createServer(handle);
server.listen(port, "127.0.0.1", () => {
  console.log(`[write] http://127.0.0.1:${port}${PREFIX}  data=${dataRoot}`);
});

// 退出时停掉 Loop 的秒表，别让一次 systemctl restart 留下半个巡查。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    api.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { errorChain } from "../app/error-chain";
import { authorize } from "./guard";

/**
 * 本机 API 两半（`local-api.ts` 的 PDF 那组、`writing-api.ts` 的写作那组）共用的
 * HTTP 形状与帮手。两边都是「一串带前缀的中间件」，挂到 vite 的 `server.middlewares`
 * 或裸 `http.Server` 上都行（ADR-0014）。
 */
export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface Route {
  prefix: string;
  handler: Handler;
}

/**
 * 把写保护挡在收口处，不逐条路由加。逐条加就是「漏一条就默认开门」，而这类洞会一直
 * 长出来（同 `clip.ts` 里 GUARDS 那张表的理由）。`token` 为空串 = 不设防（`guard.ts`）。
 */
export const guarded = (routes: Route[], token: string): Route[] =>
  routes.map((route) => ({
    prefix: route.prefix,
    handler: (request, response) => {
      if (!authorize(request.method, request.headers, token)) {
        response.statusCode = 403;
        response.end("需要令牌。");
        return;
      }
      route.handler(request, response);
    },
  }));

export const JSON_TYPE = "application/json";
export const json = (data: unknown) => ({ type: JSON_TYPE, data: JSON.stringify(data) });

export function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export const readBody = async (request: IncomingMessage): Promise<string> =>
  (await readBytes(request)).toString("utf8");

/** 路径切成段，顺带解码——文件名和书名可能是中文。 */
export const segments = (request: IncomingMessage): string[] =>
  (request.url ?? "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);

/** 把一条 handler 的成败统一收口，别让异常悄悄变成 200。 */
export function respond(
  response: ServerResponse,
  body: () => Promise<{ type: string; data: string | Buffer }>,
): void {
  body()
    .then(({ type, data }) => {
      response.setHeader("content-type", type);
      response.end(data);
    })
    .catch((error: Error) => {
      // 500 + 原因。静默成功会让调用方以为已落盘（内存有、磁盘空）
      // ——ADR-0011 说文件才是唯一真相。
      response.statusCode = 500;
      response.end(error.message);
    });
}

/**
 * 把模型端点转发一道，**目标由调用方在路径里给**：`/__model/<编码过的 baseURL>/...`。
 *
 * 起初这里是写死到配置里默认组的地址。那样一来「每个功能各配各的端点」（ADR-0010）
 * 就是假的——给识别配了本地端点，请求照样发去云端，而设置页的自检还会说「通了」。
 *
 * 为什么需要转发：实测那个端点的 OPTIONS 预检返回 403、也没有任何 access-control-*
 * 头，浏览器直连必被拦在预检那一步。

 */
/**
 * 不往模型端点带的头。
 *
 * `host` 必须去掉，否则上游按它路由会 404；`content-length` 让 fetch 自己算。其余几个是
 * **我们自己这条链上的凭证**：网页形态下 Panel 加的共享密钥和用户名、CSRF 令牌、
 * 桌面版的写保护令牌——它们只该在本机流动，转给第三方的模型网关就是把家门钥匙
 * 一起寄出去。上游要的只有 `authorization` 和 `content-type`。
 */
const NOT_FORWARDED = new Set([
  "host",
  "content-length",
  "cookie",
  "x-write-secret",
  "x-panel-user",
  "x-csrf-token",
  "x-studio-token",
]);

/** 转出去的头：`request.headers` 去掉 `NOT_FORWARDED`。单列出来是为了能测——转发本身要真网络。 */
export const forwardedHeaders = (headers: IncomingMessage["headers"]): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !NOT_FORWARDED.has(name))
      .map(([name, value]) => [name, String(value)]),
  );

export async function forwardModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const [encoded, ...rest] = (request.url ?? "/").split("?")[0].split("/").filter(Boolean);
    const query = (request.url ?? "").includes("?") ? `?${(request.url ?? "").split("?")[1]}` : "";
    const target = `${decodeURIComponent(encoded ?? "")}/${rest.join("/")}${query}`;
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await readBytes(request));

    const upstream = await fetch(target, {
      method: request.method,
      headers: forwardedHeaders(request.headers),
      body,
    });

    // 上游自己返的错要留痕。**「502 是我们抛的还是上游返的」在外面根本分不清**——
    // 两边都叫 Bad Gateway，而 SDK 只报状态行、不报响应体，于是界面上永远是同一句话。
    // 只记方法、路径、body 大小和状态：**不记 header**，Authorization 就在里面。
    if (!upstream.ok) {
      console.error(
        `[__model] 上游 ${upstream.status} ${new URL(target).pathname} body=${body?.byteLength ?? 0}B`,
      );
    }

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      // 别把上游的 content-encoding 透出去：fetch 已经解过压，再声明一次浏览器会解第二遍。
      if (name !== "content-encoding" && name !== "content-length") response.setHeader(name, value);
    });
    // 流式转发，不整块 buffer：chat 走 SSE，缓冲会把「边生成边显示」变成「转圈半天
    // 然后一次性出现」，而那正是 ADR-0008 选 assistant-ui 要的东西。
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as ReadableStream), response);
    else response.end();
  } catch (error) {
    response.statusCode = 502;
    // **要整条链**：undici 把一切都叫 `fetch failed`，真正的原因（`ECONNRESET`、
    // 证书、DNS）只活在 `cause` 里。只回那五个字的时候，界面上就只剩「模型调用失败」，
    // 从那儿是查不下去的——这一条真的挡了一次目录识别。
    const why = errorChain(error) || (error as Error).message;
    // 也写一份到主进程日志：SDK 只把状态行（"Bad Gateway"）往上报，响应体它不看，
    // 所以光靠回给浏览器的这段文字，界面上还是什么都看不到。
    console.error(`[__model] 转发失败 ${why}`);
    response.end(why);
  }
}

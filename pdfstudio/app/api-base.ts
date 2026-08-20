/**
 * 本机 API 的地址。
 *
 * 开发形态下是同源（vite dev server 自己挂着那些路由），空串即可。打包应用里页面走
 * `file://`——**没有 origin 可依**，相对路径直接失效，所以主进程把随机端口通过查询串
 * 传进来。
 *
 * 用查询串而不是 `executeJavaScript` 注入：后者在页面脚本开始执行**之后**才跑，
 * 而适配器可能已经发出第一批请求了——那种竞态只在打包形态下偶发，最难查。
 */
export const API_BASE = new URLSearchParams(location.search).get("api") ?? "";

/** 拼成绝对地址。SDK 会拿 baseURL 去构造 URL 对象，相对路径直接抛。 */
export const apiUrl = (route: string): string => `${API_BASE || location.origin}${route}`;

/**
 * 写保护的令牌（`src/server/guard.ts`），主进程每次启动新生成，跟地址一起从查询串进来。
 *
 * dev server 下没有这个参数，也不设防——页面与 API 同源。
 */
const TOKEN = new URLSearchParams(location.search).get("token") ?? "";

/**
 * 连本机 API 都走这个，不要用裸 `fetch`。
 *
 * **一个统一出口，而不是每处自己加头**：漏一处的表现是那一条路悄悄 403，
 * 而 403 会被各适配器自己的错误处理吞成「保存失败」之类，很难追到这里。
 */
export const apiFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), "x-studio-token": TOKEN },
  });

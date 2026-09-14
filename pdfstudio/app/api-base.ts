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

/**
 * 挂在 `/write/` 下时（`research.moyutianzun.com/write/`，见 `pdfstudio/web/main.ts`），
 * 本机 API 也在那个前缀下面：Panel 把 `/write/*` 整个转给 Node，Node 再剥掉前缀。
 * dev 下页面是 `/write.html`，不带斜杠，不算——那时 API 在根上。
 */
const BASE_PATH = location.pathname === "/write" || location.pathname.startsWith("/write/") ? "/write" : "";

/** 拼成绝对地址。SDK 会拿 baseURL 去构造 URL 对象，相对路径直接抛。 */
export const apiUrl = (route: string): string => `${API_BASE || location.origin + BASE_PATH}${route}`;

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
/**
 * 站在 Panel 后面时（`/write/`），写请求要带 Panel 的 CSRF 令牌：它的 `csrf_guard` 是
 * 应用级依赖，`/write/*` 和它自己的接口一视同仁。令牌在一个脚本读得到的 cookie 里
 * （`__Host-panel_csrf`，http 下叫 `panel_csrf`），照它前端的做法原样回给它。
 * 不在 Panel 后面时没有这个 cookie，也就不带这个头。
 */
const panelCsrf = (): string | null => {
  const hit = /(?:^|;\s*)(?:__Host-)?panel_csrf=([^;]+)/.exec(document.cookie);
  return hit ? decodeURIComponent(hit[1]!) : null;
};

export const apiFetch: typeof fetch = (input, init) => {
  const csrf = panelCsrf();
  return fetch(input, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      "x-studio-token": TOKEN,
      ...(csrf !== null ? { "x-csrf-token": csrf } : {}),
    },
  });
};

/**
 * 本机 API 的写保护。
 *
 * **这个洞是实测出来的，不是想象的**：`POST /__config` 此前没有任何鉴权、也不看
 * content-type，而 `text/plain` 的 POST 在浏览器里属于 **CORS 简单请求——不触发预检**。
 * 也就是说任何一个网页都能把 `baseURL` 改成自己的地址，此后每一次识别、翻译、问文档
 * 都发给它。读是安全的（没有 CORS 头，跨源读不到响应），**但写不需要读**。
 *
 * 端口随机只是障碍不是防护。这个洞现在够不着，因为应用里只加载我们自己的页面——
 * 但浏览器功能一上就接通了。
 *
 * ## 为什么令牌放在自定义头里
 *
 * 跨源 JS **设不了自定义头**：一设就变成非简单请求、触发预检，而我们不回任何
 * `Access-Control-*`，预检必挂。所以「要求带一个自定义头」本身就是防线，令牌的值
 * 是第二层——万一将来有人给某条路由加了宽松的 CORS，值还挡着。
 */
export const TOKEN_HEADER = "x-studio-token";

/** 会改东西的方法才要令牌。读不用：跨源本来就读不到响应，而 pdf.js 取静态资源是裸 GET。 */
export function needsToken(method: string | undefined): boolean {
  const safe = new Set(["GET", "HEAD", "OPTIONS"]);
  return !safe.has((method ?? "GET").toUpperCase());
}

/**
 * 这次请求过不过。
 *
 * `expected` 为空表示没启用保护（dev server 里可以不设），一律放行——**但要显式，
 * 不能是「忘了配就默默不设防」**，所以调用方必须把它传进来。
 */
export function authorize(
  method: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  expected: string,
): boolean {
  if (expected === "") return true;
  if (!needsToken(method)) return true;

  // 直接比。**不装常量时间**：JS 的字符串 `===` 本来就不是，而威胁模型里的攻击者
  // 是一个读不到响应的跨源页面——它连成败都看不见，谈不上按时间试探。
  // 头是数组（重复头）时 `===` 自然不成立，那正是我们要的：不去猜哪个算数。
  return headers[TOKEN_HEADER] === expected;
}

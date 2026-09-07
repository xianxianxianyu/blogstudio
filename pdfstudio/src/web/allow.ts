/**
 * 哪些地址允许在应用内加载。
 *
 * **不做「任意网站」的默认开放。** Electron 官方原话：*"If your goal is to display a
 * website, a browser will be a more secure option"*——因为 Electron 里 Safe Browsing 与
 * Certificate Transparency **都是关的**（`docs/research-web-anchoring.md` §4.3）。
 * 所以只开读者显式加过的站点，别的一概不加载。
 *
 * 判据是**协议 + 主机 + 路径前缀**，三样都要对。
 */

/** 只认这两个协议。`file:` 能读本地文件，`javascript:` / `data:` 是注入面。 */
const SCHEMES = new Set(["http:", "https:"]);

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return SCHEMES.has(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `X` 与 `www.X` 算同一个站。**只放宽 www 这一个前缀，别的子域一律不放。**
 *
 * 理由是实测的（2026-08-21，`curl -I`）：跳转**两个方向都有，而且反方向更多**——
 * baidu / electronjs 是裸域 → www，而 github / docs.rs / arxiv / ai-sdk.dev 是
 * www → 裸域，news.ycombinator.com 根本没有 www。所以「输入时自动补 www」会在后一半
 * 站上直接失败；放宽在这里则两个方向都覆盖，而且不用猜。
 *
 * 为什么只放 `www`：它按惯例永远是同一个运营方。别的子域**不是**——`*.github.io`、
 * `*.s3.amazonaws.com` 这类下面住的是任意用户的内容，放宽等于把整个平台开给攻击者。
 */
function sameSite(a: string, b: string): boolean {
  const bare = (host: string) => (host.startsWith("www.") ? host.slice(4) : host);
  return bare(a) === bare(b);
}

export function allows(sites: readonly string[], url: string): boolean {
  const target = parse(url);
  if (!target) return false;

  return sites.some((site) => {
    const allowed = parse(site);
    if (!allowed) return false;

    // **主机要完全相等**：`startsWith` 会让 `example.com.evil.com` 混进来（经典绕过），
    // 而 `endsWith` 会让 `evil-example.com` 混进来。子域名也不算——`evil.example.com`
    // 与 `example.com` 是两个主机，谁给谁签名都不是我们能假设的。
    if (allowed.protocol !== target.protocol || !sameSite(allowed.host, target.host)) return false;

    // 路径按**段**比，不按字符串前缀：`/tokio` 不该放行 `/tokio-evil`。
    //
    // 加整站（路径为空）时不需要特例：`want` 是空串，`` `${want}/` `` 就是 `/`，
    // 而每个 pathname 都以 `/` 开头，所以底下全放行是自然结果。
    // （我先写了一条 `if (want === "") return true`，变异测试发现它是死代码。）
    const want = allowed.pathname.replace(/\/+$/, "");
    return target.pathname === want || target.pathname.startsWith(`${want}/`);
  });
}

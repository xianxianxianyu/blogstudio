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

export function allows(sites: readonly string[], url: string): boolean {
  const target = parse(url);
  if (!target) return false;

  return sites.some((site) => {
    const allowed = parse(site);
    if (!allowed) return false;

    // **主机要完全相等**：`startsWith` 会让 `example.com.evil.com` 混进来（经典绕过），
    // 而 `endsWith` 会让 `evil-example.com` 混进来。子域名也不算——`evil.example.com`
    // 与 `example.com` 是两个主机，谁给谁签名都不是我们能假设的。
    if (allowed.protocol !== target.protocol || allowed.host !== target.host) return false;

    // 路径按**段**比，不按字符串前缀：`/tokio` 不该放行 `/tokio-evil`。
    //
    // 加整站（路径为空）时不需要特例：`want` 是空串，`` `${want}/` `` 就是 `/`，
    // 而每个 pathname 都以 `/` 开头，所以底下全放行是自然结果。
    // （我先写了一条 `if (want === "") return true`，变异测试发现它是死代码。）
    const want = allowed.pathname.replace(/\/+$/, "");
    return target.pathname === want || target.pathname.startsWith(`${want}/`);
  });
}

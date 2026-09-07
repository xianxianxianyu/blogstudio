import { describe, expect, it } from "vitest";
import { allows } from "./allow";

const sites = ["https://example.com", "https://docs.rs/tokio"];

describe("哪些地址允许加载", () => {
  it("加过的站点放行", () => {
    expect(allows(sites, "https://example.com/any/path")).toBe(true);
  });

  it("**子路径够了就行**——加了 docs.rs/tokio 就别再逼人一页一页加", () => {
    expect(allows(sites, "https://docs.rs/tokio/latest/tokio/index.html")).toBe(true);
  });

  it("**路径按段比，不按字符前缀**——加了 `/tokio` 不该放行 `/tokio-evil`", () => {
    expect(allows(sites, "https://docs.rs/tokio-evil/x")).toBe(false);
    // 但 `/tokio` 自己和它底下的都要放行。
    expect(allows(sites, "https://docs.rs/tokio")).toBe(true);
    expect(allows(sites, "https://docs.rs/tokio/latest")).toBe(true);
  });

  it("**加整站时路径为空，底下全放行**——不能变成「只有根页面能开」", () => {
    expect(allows(["https://example.com"], "https://example.com/deep/path")).toBe(true);
    expect(allows(["https://example.com/"], "https://example.com/deep/path")).toBe(true);
  });

  it("同主机但不在允许的路径下，不放行", () => {
    expect(allows(sites, "https://docs.rs/serde")).toBe(false);
  });

  it("没加过的站点不放行", () => {
    expect(allows(sites, "https://evil.com/")).toBe(false);
  });

  it("**子域名不算**——`evil.example.com` 不是 `example.com`", () => {
    expect(allows(sites, "https://evil.example.com/")).toBe(false);
  });

  it("**前缀相同但不是同一个主机也不算**——`example.com.evil.com` 是经典绕过", () => {
    expect(allows(sites, "https://example.com.evil.com/")).toBe(false);
  });

  it("http 不能冒充 https：协议是身份的一部分", () => {
    expect(allows(sites, "http://example.com/")).toBe(false);
  });

  it("**只放行 http(s)**——file: / javascript: / data: 一律不行", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x", "about:blank"]) {
      expect(allows([...sites, url], url)).toBe(false);
    }
  });

  it("解析不了的地址不放行——拿不准就不开门", () => {
    expect(allows(sites, "这不是网址")).toBe(false);
  });

  it("空名单谁都不放行", () => {
    expect(allows([], "https://example.com/")).toBe(false);
  });

  it("名单里的怪条目被忽略，不影响别的", () => {
    expect(allows(["垃圾", "https://example.com"], "https://example.com/a")).toBe(true);
  });
});

describe("www 与裸域算同一个站", () => {
  /**
   * 实测（2026-08-21，`curl -I`）：两个方向都有，而且反方向更多。
   *
   *   baidu.com / electronjs.org      裸域 301 → www
   *   github.com / docs.rs / arxiv.org  www 301 → 裸域
   *   news.ycombinator.com            **根本没有 www**（连不上）
   *
   * 所以「输入时自动补 www」会在后四个站上直接失败。正确的位置是这里：
   * `X` 与 `www.X` 按惯例永远是同一家，白名单把它们当同一个站，**两个方向的跳转
   * 一次都不会被拦**，而且不用猜。
   */
  it("加了裸域，www 的也放行——baidu 那种 301", () => {
    expect(allows(["https://baidu.com"], "https://www.baidu.com/")).toBe(true);
  });

  it("加了 www，裸域的也放行——github 那种反向 301", () => {
    expect(allows(["https://www.github.com"], "https://github.com/")).toBe(true);
  });

  it("**只放宽 www 这一个，别的子域一律不放**", () => {
    expect(allows(["https://example.com"], "https://evil.example.com/")).toBe(false);
    expect(allows(["https://example.com"], "https://api.example.com/")).toBe(false);
    // 前缀是 www 但不是那一段也不行。
    expect(allows(["https://example.com"], "https://wwwx.example.com/")).toBe(false);
  });

  it("**只削开头的 `www.`**——`replace` 会削任意位置的，把主机削成另一个站", () => {
    // `"mywww.site.com".replace("www.", "")` → `"mysite.com"`。
    // 于是白名单里加了 `mywww.site.com`，`mysite.com` 会被判成同一个站。
    expect(allows(["https://mywww.site.com"], "https://mysite.com/")).toBe(false);
  });

  it("经典绕过仍然挡得住", () => {
    expect(allows(["https://example.com"], "https://example.com.evil.com/")).toBe(false);
    expect(allows(["https://www.example.com"], "https://www.example.com.evil.com/")).toBe(false);
  });

  it("协议仍然要对——放宽的只有 www，不是别的", () => {
    expect(allows(["https://baidu.com"], "http://www.baidu.com/")).toBe(false);
  });

  it("路径限制照旧跟着走", () => {
    expect(allows(["https://docs.rs/tokio"], "https://www.docs.rs/tokio/latest")).toBe(true);
    expect(allows(["https://docs.rs/tokio"], "https://www.docs.rs/serde")).toBe(false);
  });
});

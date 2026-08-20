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

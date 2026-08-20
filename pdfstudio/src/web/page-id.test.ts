import { describe, expect, it } from "vitest";
import { pageIdOf } from "./page-id";

const same = (a: string, b: string) => expect(pageIdOf(a)).toBe(pageIdOf(b));
const differs = (a: string, b: string) => expect(pageIdOf(a)).not.toBe(pageIdOf(b));

describe("网页的身份：什么算同一个页面", () => {
  it("原样的两次访问当然是同一个", () => {
    same("https://example.com/a", "https://example.com/a");
  });

  it("**锚点不算身份的一部分**——HTTP 根本不发送它", () => {
    same("https://example.com/a#intro", "https://example.com/a#methods");
  });

  it("主机名大小写不敏感，协议也是", () => {
    same("HTTPS://Example.COM/a", "https://example.com/a");
  });

  it("**路径大小写敏感**——很多服务器区分，不能替它决定", () => {
    differs("https://example.com/A", "https://example.com/a");
  });

  it("默认端口去掉", () => {
    same("https://example.com:443/a", "https://example.com/a");
    same("http://example.com:80/a", "http://example.com/a");
  });

  it("非默认端口保留——那是另一个服务", () => {
    differs("https://example.com:8443/a", "https://example.com/a");
  });

  it("**utm_* 这类跟踪参数去掉**——同一篇文章从不同渠道点进来不该变成两个文档", () => {
    same("https://example.com/a?utm_source=twitter&utm_medium=social", "https://example.com/a");
    same("https://example.com/a?fbclid=xxx", "https://example.com/a");
    same("https://example.com/a?gclid=xxx", "https://example.com/a");
  });

  it("跟踪参数混在真参数里时，只去掉跟踪的那些", () => {
    same("https://example.com/a?id=7&utm_source=x", "https://example.com/a?id=7");
  });

  it("**别的查询参数一律保留**——`?page=2` 是另一页，`?id=7` 是另一篇", () => {
    differs("https://example.com/a?page=2", "https://example.com/a?page=3");
    differs("https://example.com/a?id=7", "https://example.com/a");
  });

  it("**参数顺序不重排**——服务器可能在意，我们没资格替它决定", () => {
    differs("https://example.com/a?b=1&c=2", "https://example.com/a?c=2&b=1");
  });

  it("根路径的末尾斜杠可去，别处的不可", () => {
    same("https://example.com/", "https://example.com");
    // `/a/` 与 `/a` 在很多服务器上是两个东西（一个目录一个文件）。
    differs("https://example.com/a/", "https://example.com/a");
  });

  it("解析不了的原样返回——不能因为一个怪 URL 就丢掉这条摘录", () => {
    expect(pageIdOf("这不是个网址")).toBe("这不是个网址");
  });

  it("空串也不炸", () => {
    expect(pageIdOf("")).toBe("");
  });
});

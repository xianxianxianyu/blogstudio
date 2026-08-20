import { describe, expect, it } from "vitest";
import { TOKEN_HEADER, authorize, needsToken } from "./guard";

const T = "s3cr3t-token";
const withToken = { [TOKEN_HEADER]: T };

describe("本机 API 的写保护", () => {
  it("读不要令牌——跨源读不到响应，而 pdf.js 取静态资源是裸 GET", () => {
    expect(needsToken("GET")).toBe(false);
    expect(needsToken("HEAD")).toBe(false);
    // 预检也放行，否则浏览器连问都问不成。
    expect(needsToken("OPTIONS")).toBe(false);
  });

  it("写要令牌", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(needsToken(method)).toBe(true);
    }
  });

  it("方法名大小写不敏感——两个方向都要对", () => {
    // 绕过去：小写 post 仍然要令牌。
    expect(needsToken("post")).toBe(true);
    // **反方向更要紧**：小写 get 不能被当成写操作，否则读全被挡住。
    expect(needsToken("get")).toBe(false);
    expect(needsToken("Head")).toBe(false);
  });

  it("方法缺失当 GET——裸 http 请求可能没有", () => {
    expect(needsToken(undefined)).toBe(false);
  });

  it("**这就是实测到的那次攻击**：text/plain 的 POST，没有令牌，必须挡住", () => {
    expect(authorize("POST", { "content-type": "text/plain" }, T)).toBe(false);
  });

  it("带对令牌的写放行", () => {
    expect(authorize("POST", withToken, T)).toBe(true);
  });

  it("令牌不对就挡", () => {
    expect(authorize("POST", { [TOKEN_HEADER]: "别的" }, T)).toBe(false);
  });

  it("同长度但不同值也挡", () => {
    expect(authorize("POST", { [TOKEN_HEADER]: "X".repeat(T.length) }, T)).toBe(false);
  });

  it("头缺失就挡——不是「没带就当没启用」", () => {
    expect(authorize("POST", {}, T)).toBe(false);
  });

  it("头是数组时不认——重复头是走私手法，不去猜哪个算数", () => {
    expect(authorize("POST", { [TOKEN_HEADER]: [T, "别的"] }, T)).toBe(false);
  });

  it("读不带令牌也放行", () => {
    expect(authorize("GET", {}, T)).toBe(true);
  });

  it("**没配令牌就整个不设防**——dev server 可以这样，但必须是显式传空", () => {
    expect(authorize("POST", {}, "")).toBe(true);
  });
});

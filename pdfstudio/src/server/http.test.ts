import { describe, expect, it } from "vitest";
import { forwardedHeaders } from "./http";

describe("模型转发带出去的头", () => {
  it("**自己这条链上的凭证一个都不带**：Panel 的共享密钥、用户名、CSRF、写保护令牌、cookie", () => {
    const out = forwardedHeaders({
      host: "127.0.0.1:8095",
      "content-length": "123",
      cookie: "__Host-panel_session=abc",
      "x-write-secret": "s3cret",
      "x-panel-user": "linyuxiao",
      "x-csrf-token": "tok",
      "x-studio-token": "",
      authorization: "Bearer sk-model-key",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
    });
    expect(out).toEqual({
      authorization: "Bearer sk-model-key",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
    });
  });
});

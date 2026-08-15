import { describe, expect, it } from "vitest";
import { errorChain } from "./error-chain";

describe("错误链", () => {
  it("整条摊平，不只报最外层", () => {
    // 真实案例：公式识别报「模型调用失败」，而真正的原因（baseURL 是相对路径，
    // SDK 构造 URL 时直接抛）被外层吞掉了，只能靠猜。
    const inner = Object.assign(new TypeError("Invalid URL"), {});
    const outer = Object.assign(new Error("模型调用失败"), {
      kind: "model-unavailable",
      cause: inner,
    });

    expect(errorChain(outer)).toBe("model-unavailable: 模型调用失败\n  ↳ TypeError: Invalid URL");
  });

  it("成环的 cause 不会把它转死", () => {
    // 挂死的界面比一条难看的错误信息糟糕得多。
    const a = new Error("a");
    const b = Object.assign(new Error("b"), { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(errorChain(a)).toBe("Error: a\n  ↳ Error: b");
  });

  it("不是 Error 就给空串，让调用方自己兜底", () => {
    expect(errorChain("字符串")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { CONTEXT_LEN, describeQuote, findQuote, verdictOf } from "./quote";

describe("描述一段引文（存的时候）", () => {
  const text = "从前有座山，山里有座庙，庙里有个老和尚，老和尚在讲故事。";

  it("前后各取 32 字当上下文", () => {
    const long = "甲".repeat(60) + "目标" + "乙".repeat(60);
    const quote = describeQuote(long, 60, 62);

    expect(quote.exact).toBe("目标");
    expect(quote.prefix).toHaveLength(CONTEXT_LEN);
    expect(quote.suffix).toHaveLength(CONTEXT_LEN);
    expect(quote.prefix).toBe("甲".repeat(CONTEXT_LEN));
  });

  it("贴着开头时前缀是能拿到的那些，不是空", () => {
    const quote = describeQuote(text, 0, 5);

    expect(quote.exact).toBe("从前有座山");
    expect(quote.prefix).toBe("");
    expect(quote.suffix.startsWith("，山里")).toBe(true);
  });

  it("贴着结尾时后缀是空的，不是 undefined", () => {
    const quote = describeQuote(text, text.length - 3, text.length);

    expect(quote.exact).toBe("故事。");
    expect(quote.suffix).toBe("");
  });

  it("**32 字在中文里≈一整句**，这是中文占的便宜", () => {
    const quote = describeQuote("甲".repeat(40) + "目标", 40, 42);

    // 英文 32 字符大约 7 个词，中文是 32 个字——信息量差一个量级。
    expect(quote.prefix).toHaveLength(32);
  });
});

describe("找回一段引文（读的时候）", () => {
  it("唯一一处：找到，满分", () => {
    const found = findQuote("上文目标下文", { exact: "目标", prefix: "上文", suffix: "下文" });

    expect(found).toMatchObject({ start: 2, end: 4 });
    expect(found!.score).toBe(1);
  });

  it("找不到就是找不到，不给一个凑合的位置", () => {
    expect(findQuote("完全无关的内容", { exact: "目标", prefix: "", suffix: "" })).toBeNull();
  });

  it("**出现两次，靠前缀区分**", () => {
    const text = "甲目标乙目标";
    const found = findQuote(text, { exact: "目标", prefix: "乙", suffix: "" });

    expect(found!.start).toBe(4);
  });

  it("出现两次，靠后缀区分", () => {
    const text = "目标甲目标乙";
    const found = findQuote(text, { exact: "目标", prefix: "", suffix: "乙" });

    expect(found!.start).toBe(3);
  });

  it("**上下文都区分不开时，位置先验当 tie-breaker**", () => {
    const text = "目标".repeat(50);
    const near = findQuote(text, { exact: "目标", prefix: "", suffix: "" }, 60);

    // 60 附近的那一处，而不是第一处。
    expect(near!.start).toBeGreaterThan(40);
  });

  it("没有位置先验时，上下文全不匹配就取第一处——**要确定，不能随机**", () => {
    const text = "目标".repeat(10);

    expect(findQuote(text, { exact: "目标", prefix: "", suffix: "" })!.start).toBe(0);
  });

  it("**重叠出现的候选不能漏**——步长必须是 1，不是引文长度", () => {
    // "aa" 在 "aaa" 里出现两次（位置 0 和 1），第二处与第一处重叠。
    // 拿长度当步长会只找到第一处，而后缀本该把第二处选出来。
    const found = findQuote("aaab", { exact: "aa", prefix: "", suffix: "b" });

    expect(found!.start).toBe(1);
  });

  it("空引文不给结果——那不是「匹配所有位置」，那是没东西可找", () => {
    expect(findQuote("随便什么", { exact: "", prefix: "", suffix: "" })).toBeNull();
  });

  it("上下文只对上一半，分数按比例掉", () => {
    const full = findQuote("上文目标下文", { exact: "目标", prefix: "上文", suffix: "下文" })!;
    const half = findQuote("上文目标XX", { exact: "目标", prefix: "上文", suffix: "下文" })!;

    expect(half.score).toBeLessThan(full.score);
    expect(half.score).toBeGreaterThan(0);
  });
});

describe("判定：采纳、要人确认、还是找不到", () => {
  it("满分是 anchored", () => {
    expect(verdictOf(1)).toBe("anchored");
  });

  it("**低于阈值降级成 fuzzy，要人确认**——不静默采纳", () => {
    expect(verdictOf(0.5)).toBe("fuzzy");
  });

  it("没有候选就是 orphan", () => {
    expect(verdictOf(null)).toBe("orphan");
  });

  it("阈值上下两侧分得开", () => {
    expect(verdictOf(0.71)).toBe("anchored");
    expect(verdictOf(0.69)).toBe("fuzzy");
  });
});

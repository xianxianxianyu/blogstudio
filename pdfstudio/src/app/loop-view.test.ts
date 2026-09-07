import { describe, expect, it } from "vitest";
import { agoOf, tallyOf } from "./loop-view";

const run = (over: Partial<{ done: string[]; failed: string[]; skipped: string[] }> = {}) => ({
  done: [],
  failed: [],
  skipped: [],
  ...over,
});

describe("一轮的成绩写成一行", () => {
  it("全成了就只说一句", () => {
    expect(tallyOf(run({ done: ["01", "02", "03"] }))).toBe("3 件全成");
  });

  it("**有没成的就必须写出来**——这一行绝不能只报喜", () => {
    // 只显示「10 件」的话，读者要点进去逐条看才知道少了两件。而这一列的用处
    // 恰恰是不点进去就知道它还好不好。
    expect(tallyOf(run({ done: Array(10).fill("x"), failed: ["11", "12"] }))).toBe("10 成 · 2 没成");
  });

  it("**没轮到的单独说**——它跟「没成」是两件事（spec §1.3）", () => {
    expect(tallyOf(run({ done: ["01"], failed: ["02"], skipped: ["03"] }))).toBe(
      "1 成 · 1 没成 · 1 没轮到",
    );
  });

  it("**只是没轮到、一件都没失败，也不能说「全成」**", () => {
    // 预算不够砍掉的那两件，读者下一轮加点钱就能拿到——而说成「全成」，
    // 他根本不知道有这回事。
    expect(tallyOf(run({ done: ["01"], skipped: ["02", "03"] }))).toBe("1 成 · 2 没轮到");
  });

  it("一件都没排出来", () => {
    expect(tallyOf(run())).toBe("没排出任务");
  });
});

describe("多久以前", () => {
  const MIN = 60_000;

  it("一分钟以内就是刚刚", () => {
    expect(agoOf(1000, 1000 + 59 * 1000)).toBe("刚刚");
  });

  it("按分、时、天往上走", () => {
    expect(agoOf(0, 5 * MIN)).toBe("5 分钟前");
    expect(agoOf(0, 3 * 60 * MIN)).toBe("3 小时前");
    expect(agoOf(0, 2 * 24 * 60 * MIN)).toBe("2 天前");
  });

  it("整一分钟就是「1 分钟前」，不是「刚刚」", () => {
    expect(agoOf(0, MIN)).toBe("1 分钟前");
  });

  it("零头往下取，不四舍五入——5 分半说成「6 分钟前」是往前多报了", () => {
    expect(agoOf(0, 5 * MIN + 36_000)).toBe("5 分钟前");
  });

  it("**时钟往回跳的时候不说「-3 分钟前」**", () => {
    // 系统对时、跨时区、夏令时都会让 now 跑到 startedAt 前面去。
    expect(agoOf(5 * MIN, 0)).toBe("刚刚");
  });
});

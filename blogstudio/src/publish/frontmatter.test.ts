import { describe, expect, it } from "vitest";
import { isoAt } from "./frontmatter";

// 2026-08-27T18:20:00+08:00
const WHEN = Date.UTC(2026, 7, 27, 10, 20, 0);
const CST = 480;

describe("isoAt", () => {
  it("带上时区偏移，不是 Z", () => {
    // Hugo 的 `date` 少了偏移就按 UTC 算，文章会显示成早八小时。
    expect(isoAt(WHEN, CST)).toBe("2026-08-27T18:20:00+08:00");
  });

  it("负偏移写成减号", () => {
    expect(isoAt(WHEN, -300)).toBe("2026-08-27T05:20:00-05:00");
  });

  it("零偏移写成 +00:00", () => {
    expect(isoAt(WHEN, 0)).toBe("2026-08-27T10:20:00+00:00");
  });

  it("不是整点的时区也要对（印度 +05:30）", () => {
    // 丢掉分钟那一位在国内永远看不出来——出差一次就错半小时。
    expect(isoAt(WHEN, 330)).toBe("2026-08-27T15:50:00+05:30");
  });
});

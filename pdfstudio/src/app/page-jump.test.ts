import { describe, expect, it } from "vitest";
import { pageFrom } from "./page-jump";

/** 那本 654 页的扫描书。 */
const PAGES = 654;

describe("顶栏输入页码", () => {
  it("输一个页码就是它", () => {
    expect(pageFrom("42", PAGES)).toBe(42);
  });

  it("**不是数字就不跳**，而不是跳到 NaN 页", () => {
    // `Math.min(pages, Math.max(1, NaN))` 是 NaN，而 NaN 会**通过**下游所有比较：
    // 渲染那一侧不会报错，只会给出一片空白，顶栏还照样显示「NaN / 654」。
    // 这一类坏法一点声音都没有，所以这里必须在源头就挡住。
    expect(pageFrom("", PAGES)).toBeNull();
    expect(pageFrom("  ", PAGES)).toBeNull();
    expect(pageFrom("第三章", PAGES)).toBeNull();
    expect(pageFrom("12.7", PAGES)).toBeNull();
  });

  it("超出范围就贴到最近的那一页，不是不跳", () => {
    // 输 9999 的人是想去最后；输 0 的人是想去开头。两者都不是错误输入，
    // 只是没算准——把他送到边界上，比什么都不做更接近他要的。
    expect(pageFrom("9999", PAGES)).toBe(PAGES);
    expect(pageFrom("0", PAGES)).toBe(1);
    expect(pageFrom("-3", PAGES)).toBe(1);
  });

  it("前后的空格不算数", () => {
    expect(pageFrom(" 42 ", PAGES)).toBe(42);
  });
});

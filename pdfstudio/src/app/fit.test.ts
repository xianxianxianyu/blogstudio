import { describe, expect, it } from "vitest";
import { fitScale, STAGE_PADDING } from "./fit";

describe("适应宽度的倍率", () => {
  it("页宽 612、栏宽 700 时铺满", () => {
    expect(fitScale(700, 612)).toBeCloseTo((700 - STAGE_PADDING) / 612, 3);
  });

  it("**栏宽为 0 时不给数**——脱离文档的元素就是 0，算出来是负的", () => {
    // 实测的 bug：去 Context 那一侧再回来，阅读页是新的 DOM 节点，而 ResizeObserver
    // 还盯着旧的那个（已脱离文档）。它报 0，于是 (0 − 40) / 612 = 负倍率，
    // 画布塌成一个小白块。而顶栏仍然显示 100%——`scale / fit` 两个都是同一个负数。
    expect(fitScale(0, 612)).toBeNull();
  });

  it("栏宽比内边距还小也不给数——那不是「很窄」，是还没布局", () => {
    expect(fitScale(30, 612)).toBeNull();
  });

  it("页宽为 0 不给数——还没渲染出第一页", () => {
    expect(fitScale(700, 0)).toBeNull();
  });

  it("负数一律不给数", () => {
    expect(fitScale(-10, 612)).toBeNull();
    expect(fitScale(700, -1)).toBeNull();
  });

  it("结果保留三位小数——再细的差别在画布上看不出来，却会让 effect 反复重跑", () => {
    expect(fitScale(701, 613)).toBe(Number(((701 - STAGE_PADDING) / 613).toFixed(3)));
  });
});

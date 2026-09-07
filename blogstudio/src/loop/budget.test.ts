import { describe, expect, it } from "vitest";
import { reserve } from "./budget";

describe("整轮的预算怎么分给一批同时跑的 task", () => {
  it("装得下就派出去，并把它的上限占住", () => {
    expect(reserve(5, 0, 0.3)).toEqual({ send: true, reserved: 0.3 });
    expect(reserve(5, 0.3, 0.3)).toEqual({ send: true, reserved: 0.6 });
  });

  it("**按上限预留，不按已花的钱**——并行时钱是响应回来才知道的，那时已经晚了", () => {
    // 整轮 0.5，两个 task 各自上限 0.3。第二个装不下：0.3 + 0.3 = 0.6 超了。
    // 若改成看「已经花了多少」，此刻第一个可能一分钱都还没回来，于是两个都派出去，
    // 最坏情况花 0.6——**上限就此形同虚设**。
    expect(reserve(0.5, 0.3, 0.3)).toEqual({ send: false, reserved: 0.3 });
  });

  it("正好装满算装得下——预留的是上限，花不到那么多是常态", () => {
    expect(reserve(0.6, 0.3, 0.3)).toEqual({ send: true, reserved: 0.6 });
  });
});

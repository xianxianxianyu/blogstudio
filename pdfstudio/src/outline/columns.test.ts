import { describe, expect, it } from "vitest";
import { columnSplits } from "./columns";

/** 造一幅剖面：`ink` 里给出有墨迹的区间，其余为 0。 */
function profile(width: number, ink: [number, number][], level = 10): number[] {
  const density = new Array<number>(width).fill(0);
  for (const [from, to] of ink) for (let x = from; x < to; x++) density[x] = level;
  return density;
}

describe("分栏", () => {
  it("单栏：中间没有白带，不切", () => {
    expect(columnSplits(profile(1000, [[80, 920]]))).toEqual([]);
  });

  it("双栏：切在栏缝正中", () => {
    // 左栏 80–470，栏缝 470–530，右栏 530–920。
    expect(columnSplits(profile(1000, [[80, 470], [530, 920]]))).toEqual([500]);
  });

  it("**页边距不能被当成栏缝**——它比栏缝还宽，只看最长的白带必然误判", () => {
    // 左右各 80px 页边距，比 60px 的栏缝更宽。
    expect(columnSplits(profile(1000, [[80, 470], [530, 920]]))).toEqual([500]);
  });

  it("字距那种窄缝不算分栏", () => {
    // 中间只空了 8px。
    expect(columnSplits(profile(1000, [[80, 496], [504, 920]]))).toEqual([]);
  });

  it("栏缝偏离正中也找得到", () => {
    expect(columnSplits(profile(1000, [[60, 380], [440, 940]]))).toEqual([410]);
  });

  it("栏缝里有扫描噪点照样算空白——绝对零那种判据在扫描件上永远不成立", () => {
    const density = profile(1000, [[80, 470], [530, 920]], 100);
    for (let x = 470; x < 530; x += 7) density[x] = 3; // 噪点，远低于正文
    expect(columnSplits(density)).toEqual([500]);
  });

  it("整页空白不切——那是没有内容，不是一条很宽的栏缝", () => {
    expect(columnSplits(new Array<number>(1000).fill(0))).toEqual([]);
  });

  it("空输入不炸", () => {
    expect(columnSplits([])).toEqual([]);
  });

  it("只切一刀：三栏也只报中间那条，不假装支持没见过的形态", () => {
    const splits = columnSplits(profile(900, [[40, 260], [340, 560], [640, 860]]));
    expect(splits).toHaveLength(1);
  });
});

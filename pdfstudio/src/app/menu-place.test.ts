import { describe, expect, it } from "vitest";
import { placeMenu, type Box } from "./menu-place";

/** 一块 1400×900 的可视区，工具条 260×36。 */
const view = { width: 1400, height: 900 };
const menu = { width: 260, height: 36 };
const GAP = 8;

const at = (x: number, y: number, w: number, h: number): Box => ({ x, y, width: w, height: h });

describe("工具条摆在哪", () => {
  it("默认贴在选区下方、左边缘对齐", () => {
    const spot = placeMenu(at(300, 200, 400, 120), menu, view);

    expect(spot).toEqual({ x: 300, y: 200 + 120 + GAP });
  });

  it("**下面放不下就翻到上面**——不是硬塞在屏幕外", () => {
    // 选区下沿在 880，离底只剩 20px，装不下 8+36。
    const spot = placeMenu(at(300, 830, 400, 50), menu, view);

    expect(spot.y).toBe(830 - GAP - menu.height);
  });

  it("上下都放不下就压在选区内侧的下沿——总得有个能看见的地方", () => {
    // 选区几乎占满整个可视区。
    const spot = placeMenu(at(0, 0, 1400, 900), menu, view);

    expect(spot.y).toBe(900 - GAP - menu.height);
    expect(spot.y).toBeGreaterThanOrEqual(0);
  });

  it("靠右边缘时往左收，不越界", () => {
    const spot = placeMenu(at(1300, 200, 90, 40), menu, view);

    expect(spot.x).toBe(1400 - GAP - menu.width);
  });

  it("靠左边缘时不给负数", () => {
    const spot = placeMenu(at(-40, 200, 90, 40), menu, view);

    expect(spot.x).toBe(GAP);
  });

  it("可视区比工具条还窄也不给负数——窗口能被拖到很小", () => {
    const spot = placeMenu(at(10, 10, 40, 40), menu, { width: 200, height: 120 });

    expect(spot.x).toBeGreaterThanOrEqual(0);
    expect(spot.y).toBeGreaterThanOrEqual(0);
  });

  it("零尺寸的选区也给一个位置，不炸", () => {
    expect(placeMenu(at(700, 450, 0, 0), menu, view)).toEqual({ x: 700, y: 450 + GAP });
  });
});

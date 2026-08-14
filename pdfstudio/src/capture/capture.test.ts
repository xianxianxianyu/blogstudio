import { describe, expect, it } from "vitest";
import { toPageRect } from "./capture";
import { openFixturePdf } from "../../test/fixtures";

/**
 * 真值不来自被测代码，来自两条独立事实：
 *
 * - PDF 页面坐标原点在**左下**，canvas 原点在**左上**——两者的 y 互为 `页高 - y`。
 * - 这三篇 fixture 的页高都是 792pt（`pdftotext -bbox-layout` 的 `<page height>`）。
 *
 * 所以画布上一个左上角在 (140, 411)、332×78 的框，对应的页面矩形就是
 * x=140、y=792−411−78=303、w=332、h=78 —— 正是我们在 Recognizer 测试里一直用的
 * Abstract 那一块。
 */
const PAGE_HEIGHT = 792;

describe("框选 → 页面坐标", () => {
  it("scale 1：canvas 的左上原点翻成页面的左下原点", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });

    const rect = toPageRect(viewport, { x0: 140, y0: 411, x1: 472, y1: 489 });

    expect(rect).toEqual({ x: 140, y: PAGE_HEIGHT - 489, width: 332, height: 78 });
  });

  it("scale 2：画布坐标翻倍，页面坐标不变", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 2 });

    // 读者把 PDF 放大一倍再框同一块地方——拖出的像素数翻倍，但摘录锚点必须不变，
    // 否则同一段文字在不同缩放下会存成不同的锚点，回跳就飘了。
    const rect = toPageRect(viewport, { x0: 280, y0: 822, x1: 944, y1: 978 });

    expect(rect.x).toBeCloseTo(140, 6);
    expect(rect.y).toBeCloseTo(PAGE_HEIGHT - 489, 6);
    expect(rect.width).toBeCloseTo(332, 6);
    expect(rect.height).toBeCloseTo(78, 6);
  });

  it("反向拖动（从右下拖到左上）得到同一个矩形", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });

    // 读者不一定从左上往右下拖。宽高为负的矩形会让面积算成负数，
    // 直接击穿 Recognizer 的 region-too-small 守卫（它比的是边长）。
    const forward = toPageRect(viewport, { x0: 140, y0: 411, x1: 472, y1: 489 });
    const backward = toPageRect(viewport, { x0: 472, y0: 489, x1: 140, y1: 411 });

    expect(backward).toEqual(forward);
  });
});

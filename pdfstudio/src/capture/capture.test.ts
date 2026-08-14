import { describe, expect, it } from "vitest";
import { isMisTouch, toPageRect } from "./capture";
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

  it("轻点一下算误触，不管当前缩放是多少", async () => {
    // 实测：scale 2 下点一下，拖出 13.5 画布像素，换算成 6.75pt——Recognizer 那条
    // 4pt 的守卫放行了，白烧一次云模型调用。
    //
    // 关键在**单位**：手抖的大小是固定的屏幕像素，而那条守卫用的是页面点。同样一下
    // 13.5px 的手抖，scale 3 下是 4.5pt（勉强拦住）、scale 1 下是 13.5pt（拦不住）——
    // 越是缩小看全页、误触越没意义的时候，守卫越不管用，方向是反的。
    //
    // 所以误触判定必须在画布像素上做，与缩放无关。
    expect(isMisTouch({ x0: 300, y0: 400, x1: 313.5, y1: 409 })).toBe(true);
  });

  it("细长条也是误触——沿着行间划过去，一条边够长另一条不够", () => {
    // 只看面积或只看一条边都挡不住：400×3 的面积远超任何阈值，但它装不下内容。
    expect(isMisTouch({ x0: 100, y0: 200, x1: 500, y1: 203 })).toBe(true);
  });

  it("真框住一块地方就不是误触", () => {
    expect(isMisTouch({ x0: 140, y0: 411, x1: 472, y1: 489 })).toBe(false);
  });

  it("反向拖动的误触判定与方向无关", () => {
    // 与 toPageRect 同一个坑：宽高为负会让任何 `< 阈值` 的比较直接判成误触，
    // 于是从右下往左上拖的**正常框选**会被当成误触丢掉。
    expect(isMisTouch({ x0: 472, y0: 489, x1: 140, y1: 411 })).toBe(false);
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

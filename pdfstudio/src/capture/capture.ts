import type { PageViewport } from "pdfjs-dist";
import type { Rect } from "../recognizer/recognizer";

/** 读者在画布上拖出的两个角，单位是 CSS 像素，原点左上。 */
export interface DragBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 把画布上的拖动框换算成 PDF 页面矩形。
 *
 * 三件事在这里对齐，任何一件错了摘录的锚点就会飘：
 *
 * 1. **原点翻转**。PDF 页面坐标原点在左下，画布在左上——同一条边的 y 互为
 *    `页高 − y`。翻转会把上下边**互换**，所以不能只减不换。
 * 2. **缩放**。读者放大一倍再框同一块地方，拖出的像素数翻倍，但锚点必须不变，
 *    否则同一段文字在不同缩放下存成不同的锚点，回跳就飘了。
 * 3. **拖动方向**。读者不一定从左上往右下拖。宽高为负会直接击穿 Recognizer 的
 *    `region-too-small` 守卫（它比的是边长），所以在这里就归一成正的。
 *
 * 换算交给 `viewport.convertToPdfPoint`，不自己算——它同时处理了旋转（`/Rotate`
 * 不为 0 的页面），而那正是自己动手最容易漏掉的一项。
 */
export function toPageRect(viewport: PageViewport, drag: DragBox): Rect {
  const [ax, ay] = viewport.convertToPdfPoint(drag.x0, drag.y0);
  const [bx, by] = viewport.convertToPdfPoint(drag.x1, drag.y1);

  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

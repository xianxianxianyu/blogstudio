import type { PageViewport } from "pdfjs-dist";
import type { Rect } from "../recognizer/recognizer";

/** 读者在画布上拖出的两个角，单位是画布内部像素，原点左上。 */
export interface DragBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 低于这个边长的拖动算误触。单位是画布像素，**不是页面点**——这正是重点。
 *
 * Recognizer 也有一条 `region-too-small`，但它量的是页面点（4pt），挡不住误触：
 * 手抖的大小是固定的屏幕像素，同样一下 13.5px 的抖动，scale 3 下折合 4.5pt、
 * scale 1 下折合 13.5pt。于是越缩小、误触越没意义的时候，那条守卫越不管用——
 * 方向是反的。实测就是这么漏的：scale 2 下轻点一下，6.75pt 大摇大摆走完了整条链路，
 * 白烧一次云端调用（ADR-0005：端点是用户自配的付费服务）。
 *
 * 那条 4pt 守卫不能往上调来补：它的注释写着「脚注约 7pt、公式上标约 5pt，所以框住
 * 单个字符仍然合法」——调到能挡住误触，就会拒绝高倍下框一个下标这种正当操作。
 * 两个守卫挡的本来就是两件事，各自留在自己的单位里：这里挡「这是一次点击不是拖动」，
 * 那里挡「矩形装不下内容」（程序调用也会经过）。
 *
 * 16 取在实测的 13.5px 之上留一点余量。它大致是文本光标的宽度——小到这个份上的选框
 * 读者根本看不见，看不见就谈不上「有意框住了什么」。真要框很小的东西，放大就是了：
 * 缩放本身就是这个阈值的逃生口，而这是页面点做不到的。
 */
const MIN_DRAG_PX = 16;

/**
 * 这一下是点击还是框选。
 *
 * 两条边都得够长：只看面积挡不住「沿着行间划过去」拖出的细长条——400×3 的面积
 * 远超任何阈值，却同样装不下内容。
 */
export function isMisTouch(drag: DragBox): boolean {
  // 取绝对值，否则从右下往左上拖的**正常框选**会因为宽高为负被当成误触丢掉。
  return (
    Math.abs(drag.x1 - drag.x0) < MIN_DRAG_PX || Math.abs(drag.y1 - drag.y0) < MIN_DRAG_PX
  );
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

import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { Rect } from "./recognizer";

// 覆盖检测的内部缝：`recognize` 之外没人看得见它，换算法不动对外接口。

/** 基线线段：起点是 `transform[4..5]`，终点按 transform 的旋转量走 `width`。 */
function baselineSegment(item: TextItem): { x0: number; y0: number; x1: number; y1: number } {
  const [a, b, , , x, y] = item.transform;
  const length = Math.hypot(a, b) || 1;
  return { x0: x, y0: y, x1: x + (item.width * a) / length, y1: y + (item.width * b) / length };
}

/**
 * 行归属规则：基线线段与框相交。
 *
 * 不用 `[y, y+height]` 当行框——pdf.js 的 `transform[5]` 是基线、`height` 是字号
 * （整个字号都算在基线之上），行框会顶进下一行。基线没有这个歧义。
 * `width` 沿基线方向而非水平方向，否则页边那条竖排的 arXiv 戳会被算成一条横跨半页的文字。
 */
export function baselineIntersectsRect(rect: Rect, item: TextItem): boolean {
  const { x0, y0, x1, y1 } = baselineSegment(item);

  return (
    Math.min(x0, x1) <= rect.x + rect.width &&
    Math.max(x0, x1) >= rect.x &&
    Math.min(y0, y1) <= rect.y + rect.height &&
    Math.max(y0, y1) >= rect.y
  );
}

/**
 * 覆盖度阈值。0.5 落在实测数据的谷底：
 *
 *   落 text  正文段落 89.2%
 *   —— 谷 ——
 *   落 vision 图内密集标签 m01 40.0%、叠绘的图 38.7%、公式 f05 30.3%、混排 m02 15.2%、纯图 0%
 *
 * 公式在 LaTeX PDF 的文本层是有 item 的（抽出来是扁的，分式和上标全丢），
 * 靠「有没有字」区分不了，只能靠覆盖度。
 *
 * 已知薄弱面：框得越松覆盖度越低，Abstract 段落四周各留 40pt 白时降到 54.9%，
 * 再松就会误判成 vision。逃生口是 `options.route = 'text'`。
 * canonical 还写了「非空白字符密度」这第二维，实测**加不了分**：唯一逼近正文的
 * vision 样本是 m01（密度 11.64），而松散框选的正文密度 11.44——两者在密度上反而
 * 交叠，在覆盖度上却分得开（40.0% vs 54.9%）。没有反例就不加维。
 */
export const TEXT_COVERAGE_THRESHOLD = 0.5;

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** item 的包围盒，裁到框内；完全在框外返回 null。 */
function clippedBox(rect: Rect, item: TextItem): Box | null {
  const segment = baselineSegment(item);

  const x0 = Math.max(Math.min(segment.x0, segment.x1), rect.x);
  const x1 = Math.min(Math.max(segment.x0, segment.x1), rect.x + rect.width);
  const y0 = Math.max(Math.min(segment.y0, segment.y1), rect.y);
  const y1 = Math.min(Math.max(segment.y0, segment.y1) + item.height, rect.y + rect.height);

  return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
}

/**
 * 包围盒**并集**的面积，按 x 方向切板、每板合并 y 区间。
 * 求和会把叠绘的文字重复计数——attention 可视化那类图会因此虚高到 text 路由。
 */
function unionArea(boxes: Box[]): number {
  const edges = [...new Set(boxes.flatMap((box) => [box.x0, box.x1]))].sort((p, q) => p - q);
  let area = 0;

  for (let i = 0; i < edges.length - 1; i++) {
    const [left, right] = [edges[i], edges[i + 1]];
    const spans = boxes
      .filter((box) => box.x0 <= left && box.x1 >= right)
      .map((box) => [box.y0, box.y1] as const)
      .sort((p, q) => p[0] - q[0]);

    let covered = 0;
    let start: number | null = null;
    let end = 0;
    for (const [spanStart, spanEnd] of spans) {
      if (start === null) {
        [start, end] = [spanStart, spanEnd];
      } else if (spanStart > end) {
        covered += end - start;
        [start, end] = [spanStart, spanEnd];
      } else if (spanEnd > end) {
        end = spanEnd;
      }
    }
    if (start !== null) covered += end - start;
    area += (right - left) * covered;
  }

  return area;
}

/** 文本包围盒并集的面积占框的比例。 */
export function textCoverage(rect: Rect, items: TextItem[]): number {
  const boxes = items
    .map((item) => clippedBox(rect, item))
    .filter((box): box is Box => box !== null);
  return unionArea(boxes) / (rect.width * rect.height);
}


/**
 * 区域内每个文字项的裁剪框，用来把标签画成**覆盖真实文字行的高亮**而不是一个大矩形
 * （ADR-0016）。
 *
 * 一个矩形一条高亮的话，跨行选择会糊成一整块、连行距都盖住——那就不是荧光笔了。
 * 逐项给框，行与行之间自然留白。
 *
 * 复用覆盖度检测那两个函数，不另写一套几何：那里已经处理了旋转文本（`width` 沿基线
 * 方向而非水平），自己动手最容易漏掉的正是这一项。
 */
export function highlightBoxes(rect: Rect, items: TextItem[]): Rect[] {
  const boxes: Rect[] = [];

  for (const item of items) {
    if (!baselineIntersectsRect(rect, item)) continue;
    const box = clippedBox(rect, item);
    // 只与基线相交、但横向被裁光的项（区域擦着行尾过去）不产出零宽的框。
    if (box) boxes.push({ x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });
  }

  return boxes;
}

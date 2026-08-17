import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { isTwoColumn, toLines } from "../pdf/lines";
import type { Rect } from "../recognizer/recognizer";

/**
 * 文本流选择的域层：一堆带几何的文本片段 → 读序排好的文本 + 逐行的高亮矩形。
 *
 * **不碰 DOM。** 命中测试和字形级偏移交给浏览器（pdf.js 的 TextLayer + 原生选区）——
 * 实测一行常常只有一个 TextItem 且装着整行 70–103 个字符，而 pdf.js 只给整个 item 的
 * `width`，不给每个字的 x；按 `width / 长度` 均分去猜，在比例字体上必然切在词中间。
 *
 * 但浏览器给的顺序是 **DOM 顺序**，而 pdf.js 的流顺序在双栏页上跨栏交错：实测
 * ResNet p.8 上左右栏切换 14 次、DDPM p.4 上 48 次，两个左栏 item 之间最多夹进 51 个
 * 右栏 item。直接拿原生选区的文本用，会在左栏拖三行时把隔壁栏一起收进来。
 * 这个文件就是补这一刀。
 */

/** 一个被选中的文字片段：浏览器给的文本与它在**页面坐标**里的矩形。 */
export interface Fragment {
  text: string;
  rect: Rect;
}

export interface TextSelection {
  /** 拖动起点，页面坐标。归栏看它——不看谁的片段多。 */
  anchor: { x: number; y: number };
  fragments: Fragment[];
  /** 这一页全部文字项，用来判双栏。选区自己看不出整页是几栏。 */
  pageItems: TextItem[];
  /** 页面左右边界（`page.view` 的 x0/x1）。带 CropBox 偏移的 PDF 上 x0 不为 0。 */
  page: { left: number; right: number };
}

export interface TextRegion {
  /** 按读序拼好的原文，一行一段。 */
  text: string;
  /** 逐行的矩形，用来画高亮。 */
  lines: Rect[];
  /** 外接矩形。`Clip.region.rect` 仍是它——去重、标签命中的语义不变。 */
  bounds: Rect;
}

const top = (rect: Rect) => rect.y + rect.height;

/**
 * 两个矩形算不算同一行：竖直方向重叠超过矮的那个的一半。
 *
 * 不用「基线差 < 2pt」那套：浏览器给的是字形包围盒而不是基线，同一行里混着上标、
 * 小号字时盒子上下沿都不齐，按基线判会把一行拆成好几行。
 */
function sameLine(a: Rect, b: Rect): boolean {
  const overlap = Math.min(top(a), top(b)) - Math.max(a.y, b.y);
  return overlap > Math.min(a.height, b.height) / 2;
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(top)) - y,
  };
}

export function selectionToRegion(selection: TextSelection): TextRegion | null {
  const { anchor, fragments, pageItems, page } = selection;
  const middle = (page.left + page.right) / 2;

  // 归栏过滤只在双栏页上做。单栏页上「中线右边」是同一行的后半截，滤掉就吃掉半页。
  const twoColumn = isTwoColumn(toLines(pageItems), middle);
  const onAnchorSide = (rect: Rect) => {
    if (!twoColumn) return true;
    return rect.x + rect.width / 2 < middle === anchor.x < middle;
  };

  const kept = fragments.filter((fragment) => fragment.text !== "" && onAnchorSide(fragment.rect));
  if (kept.length === 0) return null;

  // 聚行。片段来的顺序是 DOM 顺序，所以只按几何聚，不看先后。
  const grouped: Fragment[][] = [];
  for (const fragment of kept) {
    const line = grouped.find((members) => sameLine(members[0].rect, fragment.rect));
    if (line) line.push(fragment);
    else grouped.push([fragment]);
  }

  // 页面坐标原点在左下，所以 y 越大越靠上：自上而下 = y 降序。
  const lines = grouped
    .map((members) => [...members].sort((a, b) => a.rect.x - b.rect.x))
    .sort((a, b) => b[0].rect.y - a[0].rect.y);

  const text = lines.map((members) => members.map((member) => member.text).join("")).join("\n");
  if (text.trim() === "") return null;

  const rects = lines.map((members) => union(members.map((member) => member.rect)));
  return { text, lines: rects, bounds: union(rects) };
}

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { Chunk } from "./retrieval";

// 切块：PDF 文本层 → 有页码的文本块。读序还原也在这里。
// 与打分完全无关——换检索算法不动这个文件，换切块策略不动 ranking.ts。

/** 一块目标大小。只在行边界上切，宁可略微超出也不切断一行。 */
const CHUNK_CHARS = 600;

/** 相邻块重叠的行数：一句话跨块边界时，两块里至少有一块是完整的。 */
const OVERLAP_LINES = 2;

interface Line {
  /** 基线 y，越大越靠上（PDF 坐标原点在左下）。 */
  y: number;
  /** 行的左右边界。 */
  x0: number;
  x1: number;
  text: string;
}

/**
 * 同一行内两段文字之间的最大水平间隔。超过它就不是同一行，是隔壁栏。
 *
 * 行内词间距只有几个点；双栏论文的栏沟是二十几个点（ResNet 左栏止于 ~286、
 * 右栏起于 ~308）。12pt 落在两者之间。
 */
const MAX_INTRA_LINE_GAP = 12;

/**
 * 把 item 聚成行。**两个条件都要满足**：基线相同，且水平方向接得上。
 *
 * 只按基线聚会把左右栏并进同一行——双栏论文左右栏共享基线网格，必然撞上。
 * 实测 ResNet p.8 有 42 处跨栏合并，包括正文级的
 * `"(7.93%, Table 6)." + "Based on deep residual nets, we won the "`。
 * 那不只是文本难看：合并出来的行 x 跨度横贯整页，会被 `isTwoColumn` 算成「跨中线」，
 * 把双栏页推向单栏判定，读序还原**静默关闭**。实测该页占比 0.298，离 0.3 只差 0.002。
 *
 * 纯空白 item 也**必须保留**：pdf.js 把词间空格单独发成 item（ResNet p.8 的 308 个
 * item 里有 90 个是纯空白），丢掉再直接拼接就会把词粘死——`Table7.ObjectdetectionmAP`
 * 这样的东西进了索引，`detection`、`object` 这些词元就从关键词那一路彻底消失。
 */
function toLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];

  for (const item of items) {
    if (item.str === "") continue;
    const [a, b, , , x, y] = item.transform;
    const length = Math.hypot(a, b) || 1;
    const endX = x + (item.width * a) / length;
    const [left, right] = [Math.min(x, endX), Math.max(x, endX)];

    const existing = lines.find(
      (line) =>
        Math.abs(line.y - y) < 2 &&
        left - line.x1 < MAX_INTRA_LINE_GAP &&
        right - line.x0 > -MAX_INTRA_LINE_GAP,
    );

    if (existing) {
      existing.text += item.str;
      existing.x0 = Math.min(existing.x0, left);
      existing.x1 = Math.max(existing.x1, right);
    } else {
      lines.push({ y, x0: left, x1: right, text: item.str });
    }
  }

  return lines;
}

/**
 * 双栏检测：看有多少行横跨页面中线。
 *
 * 单栏页的正文行几乎都跨中线（左边距到右边距），双栏页的行都在自己那一栏里。
 * 所以「跨线行占比低」就是双栏。这比按 x 直方图找栏沟稳——图内标签、坐标轴文字
 * 会把直方图打乱，但它们同样不跨中线，不影响这个判据。
 */
function isTwoColumn(lines: Line[], middle: number): boolean {
  if (lines.length === 0) return false;
  const crossing = lines.filter((line) => line.x0 < middle && line.x1 > middle).length;
  return crossing / lines.length < 0.3;
}

/**
 * 读序还原：双栏页先读完左栏再读右栏，栏内自上而下。
 *
 * 不还原的话，pdf.js 的原始顺序会把右栏内容插进左栏正文中间——ResNet p.8 上
 * 一句完整的因果句就被隔壁栏的表格图题劈开了，读者看到的 citation 是拼接的。
 */
function inReadingOrder(lines: Line[], pageLeft: number, pageRight: number): Line[] {
  const middle = (pageLeft + pageRight) / 2;
  const topDown = (a: Line, b: Line) => b.y - a.y || a.x0 - b.x0;

  if (!isTwoColumn(lines, middle)) return [...lines].sort(topDown);

  // 按行的中点归栏。真正跨栏的东西（跨栏图题、大标题）中点也在中间附近，
  // 归到哪一栏都不会劈断正文——那才是要防的事。
  const center = (line: Line) => (line.x0 + line.x1) / 2;
  return [
    ...lines.filter((line) => center(line) < middle).sort(topDown),
    ...lines.filter((line) => center(line) >= middle).sort(topDown),
  ];
}

/** 只在行边界上切，并让相邻块重叠若干行——一句话跨边界时不至于两块都残缺。 */
function packLines(lines: Line[], page: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let size = 0;

  const flush = () => {
    const text = current.join("\n").trim();
    if (text !== "") chunks.push({ page, text });
  };

  for (const line of lines) {
    if (size > 0 && size + line.text.length > CHUNK_CHARS) {
      flush();
      current = current.slice(-OVERLAP_LINES);
      size = current.reduce((total, text) => total + text.length, 0);
    }
    current.push(line.text);
    size += line.text.length;
  }
  flush();

  return chunks;
}

export async function chunkDocument(document: PDFDocumentProxy): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  for (let page = 1; page <= document.numPages; page++) {
    const loaded = await document.getPage(page);
    const { items } = await loaded.getTextContent();
    // view 是 [x0, y0, x1, y1]，页宽是 x1 - x0——带 CropBox 偏移的 PDF 上 x0 不为 0。
    const [x0, , x1] = loaded.view;

    const lines = inReadingOrder(
      toLines(items.filter((item): item is TextItem => "str" in item)),
      x0,
      x1,
    );
    chunks.push(...packLines(lines, page));
  }

  return chunks;
}


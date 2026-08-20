import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { inReadingOrder, toLines, type Line } from "../../src/pdf/lines";
import { inferOffset, looksLikeToc, parseToc, type Offset, type TocEntry } from "../../src/outline/toc";
import { columnSplits } from "../../src/outline/columns";
import type { Screenshot } from "../../src/recognizer/recognizer";
import { retrying } from "../../src/outline/retry";


/**
 * 翻页把目录读出来。**不纯的那一半**——判定、解析、推偏移的规则全在
 * `src/outline/toc.ts`，那边是纯函数、有测试；这里只负责取数据。
 */

/** 目录页只在书的前面找。往后找纯属浪费，而正文里带页码的表格越往后越多。 */
const SEARCH_PAGES = 30;

/** 偏移最多探这么多页。大部头的前言加目录通常几十页，60 足够且不会把开销放大。 */
const MAX_OFFSET = 60;

/** 参与推偏移的条目数。三条是 `inferOffset` 要求的下限，多取几条是为了容忍找不到的。 */
const OFFSET_SAMPLES = 8;

async function pageLines(document: PDFDocumentProxy, page: number): Promise<Line[]> {
  const loaded = await document.getPage(page);
  const { items } = await loaded.getTextContent();
  const [x0, , x1] = loaded.view;
  return inReadingOrder(
    toLines(items.filter((item): item is TextItem => "str" in item)),
    x0,
    x1,
  );
}

/**
 * 猜目录在哪几页。
 *
 * **先猜再让人改，而不是让人从零填。** 目录页的特征很硬（大量行以页码结尾、有点线
 * 引导符），扫一遍文本层几乎不花钱。
 *
 * 取的是**连续**的一段：目录常跨好几页，而中间夹一页版权页就断了，所以允许断一页。
 */
export async function suggestTocPages(
  document: PDFDocumentProxy,
): Promise<{ from: number; to: number } | null> {
  const limit = Math.min(SEARCH_PAGES, document.numPages);
  const hits: number[] = [];
  for (let page = 1; page <= limit; page++) {
    if (looksLikeToc(await pageLines(document, page))) hits.push(page);
  }
  if (hits.length === 0) return null;

  // 允许断一页：目录中间夹一页插图或版权页是常见排版。
  let to = hits[0];
  for (const page of hits) {
    if (page - to <= 2) to = page;
    else break;
  }
  return { from: hits[0], to };
}

/**
 * 读目录页。**有文本层就本地解析，没有才调模型。**
 *
 * 不为几页目录去花一次模型调用——数字版的书那几行本来就在文本层里躺着。扫描书没得选，
 * 但也只是那几页：这不是全书 OCR，全书都认了框选就没有意义了。
 */
export async function readTocPages(
  document: PDFDocumentProxy,
  from: number,
  to: number,
  recognize: (page: number) => Promise<TocEntry[]>,
  onPage?: (page: number) => void,
): Promise<TocEntry[]> {
  const entries: TocEntry[] = [];
  for (let page = from; page <= to; page++) {
    onPage?.(page);
    const lines = await pageLines(document, page);
    // 一页抖一下不该让整轮作废——前面认好的页会跟着一起丢，而读者只能从头再来。
    // 端点这类失败实测就是偶发的（同一张图失败一次、紧接着连打六次全过）。
    entries.push(
      ...(lines.length > 0 ? parseToc([lines]) : await retrying(() => recognize(page))),
    );
  }
  return entries;
}

/** 标题在这一页出现了没。压掉空白再比——文本层里的空格分布跟目录页对不上。 */
const flat = (text: string) => text.replace(/\s+/g, "");

/**
 * 推印刷页码与物理页码的偏移，并给出证据。
 *
 * **不让读者填这个数。** 目录写着「第三章 …… 87」，去正文里找「第三章」发现它在物理
 * 第 95 页，偏移就是 8；几条互相印证才算数，而这几条可以直接摆给读者看。
 * 「请确认」比「请填写」可靠得多——填错了没有任何东西会报错，整本书的跳转全歪。
 */
export async function inferPageOffset(
  document: PDFDocumentProxy,
  entries: TocEntry[],
  tocEndsAt: number,
): Promise<Offset | null> {
  // 取样要铺开：都挤在开头的话，偏移在书中途变了（有些书正文中间插了彩页）也看不出来。
  const step = Math.max(1, Math.floor(entries.length / OFFSET_SAMPLES));
  const sampled = entries.filter((_, index) => index % step === 0).slice(0, OFFSET_SAMPLES);

  const text = new Map<number, string>();
  const textOf = async (page: number): Promise<string> => {
    if (!text.has(page)) text.set(page, flat((await pageLines(document, page)).map((l) => l.text).join("")));
    return text.get(page)!;
  };

  // 先用第一条把候选偏移探出来，之后的条目直接按这个偏移核对——否则每条都要扫 60 页。
  let candidate: number | null = null;
  const found = new Map<string, number>();

  for (const entry of sampled) {
    const needle = flat(entry.title);
    if (needle.length < 4) continue; // 太短的标题（「前言」）容易在别处撞上

    if (candidate !== null) {
      const page = entry.printedPage + candidate;
      if (page <= document.numPages && (await textOf(page)).includes(needle)) {
        found.set(entry.title, page);
      }
      continue;
    }

    // 目录页自己也印着这些标题，所以从目录之后开始探。
    const start = Math.max(entry.printedPage, tocEndsAt + 1);
    for (let page = start; page <= Math.min(entry.printedPage + MAX_OFFSET, document.numPages); page++) {
      if ((await textOf(page)).includes(needle)) {
        found.set(entry.title, page);
        candidate = page - entry.printedPage;
        break;
      }
    }
  }

  return inferOffset(sampled, (title) => found.get(title) ?? null);
}

/**
 * 整页渲染成一张图，交给模型认。
 *
 * 长边限在 `MAX_EDGE`：这本书的页面是 1586×2259pt（A4 的 2.7 倍），原样渲染一页就是
 * 几十 MB，而目录页 OCR 并不需要那个分辨率。
 */
const MAX_EDGE = 2000;

/**
 * 按栏 OCR 时用的分辨率。
 *
 * **这个数曾经被调到 1200，那是个错误，代价写在这里。** 当时量的是：长边 2000 →
 * 图 token 1251、单栏 16.4s；长边 1130 → 612 token、10.0s，而且输出「逐字相同、
 * 甚至更全」。
 *
 * 错在**测量用的图不是应用会产生的图**：那批样本是 pdftoppm 渲的，应用走的是
 * pdf.js。两个光栅化器的抗锯齿不一样，而 1200 在这本书上正好压在悬崖边——同一页
 * 同一切点，pdftoppm 的图 34 行全对，pdf.js 的图只有 31 行**并且开始幻觉**：
 *
 *     实际：  1.7 小结 …… 20 / 练习 …… 20 / 第2章 系统模型 …… 22 / 2.1 简介 …… 22
 *     认成：  1.7 小结 ..... 20
 *             1.7.1 系统模型 ..... 22.1 简介 ..... 22.2 物理模型 ..... 23
 *
 * 四行塞成一行，编号顺着上一行往下编。**这比漏一行糟糕得多，因为产出看起来是
 * 结构化的**——`parseToc` 会照单全收，读者也看不出哪里不对。垮掉的恰好是那一栏里
 * 最靠左、字号最特殊的两行（外凸的「练习」、粗体的「第2章」）。
 *
 * 所以宁可慢：prefill 大约翻倍（单栏 ~10s → ~16s），换回不会静默编造的输出。
 *
 * **代价仍在**：这是绝对像素，不是每行像素。开本更小的书每个字更小，同样可能不够认。
 * 真遇到了要按估计的行高来定，而不是继续调这个数字——调大是所有书一起变慢。
 */
const OCR_MAX_EDGE = 2000;

export async function renderPage(
  document: PDFDocumentProxy,
  page: number,
): Promise<Screenshot> {
  const { canvas } = await renderCanvas(document, page);
  const shot = await toScreenshot(canvas);
  release(canvas);
  return shot;
}

/**
 * 整页渲染一次，**按栏切开**，每一栏单独交给 OCR。
 *
 * 双栏目录直接整页认，出来的是一行左栏一行右栏的**交错**（云端本地都一样，实测；
 * 在提示词里写「先整列左栏再整列右栏」不管用）。而乱序的目录比没有目录更糟——
 * 它看着是对的。
 *
 * 分栏在图上做，不靠模型：`columnSplits` 是纯函数、有测试，而多一次模型调用既慢又
 * 多一处会错的地方。实测这本书切在页宽 51.5% 处，栏缝 55px。
 */
export async function readTocPageByColumns(
  document: PDFDocumentProxy,
  page: number,
  ocr: (pixels: Screenshot) => Promise<string>,
): Promise<Line[]> {
  const { canvas, context } = await renderCanvas(document, page, OCR_MAX_EDGE);
  const splits = columnSplits(inkPerColumn(context, canvas.width, canvas.height));

  // 切点两侧各是一栏。没有切点就是单栏，整页一次认完。
  const bounds = [0, ...splits, canvas.width];
  const strips: Screenshot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    strips.push(await toScreenshot(canvas, bounds[i], bounds[i + 1] - bounds[i]));
  }
  release(canvas);

  const lines: Line[] = [];
  for (const [index, strip] of strips.entries()) {
    const text = await ocr(strip);
    // 临时诊断：把每一栏的原始 OCR 打出来。识别不准时，「模型没吐出来」和「我们解析
    // 时弄丢了」是完全不同的两件事，而从最终目录上分不出来——实测这两种都发生过。
    console.warn(
      `[toc] p${page} 第${index + 1}栏 ${strip.width}x${strip.height} → ${text.split("\n").filter((l) => l.trim()).length} 行\n${text}`,
    );
    lines.push(...asLines(text, lines.length));
  }
  return lines;
}

/**
 * 每一列有多少墨。二值化阈值取 128——扫描件本来就是 1bit，中间值几乎不存在。
 *
 * 隔行采样：目录页两千多行像素，逐行扫一遍纯属浪费，而栏缝是**贯穿整页**的，
 * 采样四分之一足够看出来。
 */
function inkPerColumn(context: CanvasRenderingContext2D, width: number, height: number): number[] {
  const { data } = context.getImageData(0, 0, width, height);
  const density = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y += 4) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) if (data[row + x * 4] < 128) density[x]++;
  }
  return density;
}

/**
 * OCR 出来的纯文本变成 `Line`。
 *
 * **没有坐标**，所以 x 一律为 0——`parseToc` 会因此判定「这本书的目录没有缩进」并
 * 退回按编号定层级。中文技术书的 `第1章` / `1.1` / `1.1.1` 正好吃这套（有 fixture
 * 钉着：`src/outline/toc-ocr.test.ts`）。
 *
 * y 递减是为了让**跨栏拼接后顺序仍然正确**：左栏整列排在右栏整列前面。
 */
function asLines(text: string, offset: number): Line[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    // x0 全为 0：OCR 没有坐标，`levelsByIndent` 会因此判定「没有缩进」而退回按编号。
    .map((line, i) => ({ text: line, x0: 0, x1: 1, y: 1e6 - (offset + i) * 20 }));
}

async function renderCanvas(document: PDFDocumentProxy, page: number, maxEdge = MAX_EDGE) {
  const loaded = await document.getPage(page);
  const base = loaded.getViewport({ scale: 1 });
  const viewport = loaded.getViewport({
    scale: Math.min(1, maxEdge / Math.max(base.width, base.height)),
  });

  const canvas = window.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  // `willReadFrequently`：要逐像素读回来算墨迹剖面，不给这个提示 Chromium 会把画布
  // 留在 GPU 上，每次 getImageData 都是一次同步回读。
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("拿不到画布上下文");
  await loaded.render({ canvas, viewport }).promise;
  return { canvas, context };
}

/** 整幅或其中一条竖条，转成 PNG。 */
async function toScreenshot(canvas: HTMLCanvasElement, x = 0, width = canvas.width): Promise<Screenshot> {
  let source = canvas;
  if (x !== 0 || width !== canvas.width) {
    const strip = window.document.createElement("canvas");
    strip.width = width;
    strip.height = canvas.height;
    strip.getContext("2d")!.drawImage(canvas, -x, 0);
    source = strip;
  }

  const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, "image/png"));
  const size = { width: source.width, height: source.height };
  if (source !== canvas) release(source);
  if (!blob) throw new Error("这一页渲染不出来");
  return { mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()), ...size };
}

/** 画完就把画布缩到 0：不释放的话几页目录就是上百 MB，而它已经没用了。 */
function release(canvas: HTMLCanvasElement) {
  canvas.width = canvas.height = 0;
}

/** 这一页有没有文本层。没有就是扫描版，只能走模型。 */
export async function hasTextLayer(document: PDFDocumentProxy, page: number): Promise<boolean> {
  return (await pageLines(document, page)).length > 0;
}

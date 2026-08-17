import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { inReadingOrder, toLines, type Line } from "../../src/pdf/lines";
import { inferOffset, looksLikeToc, parseToc, type Offset, type TocEntry } from "../../src/outline/toc";


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
    entries.push(...(lines.length > 0 ? parseToc([lines]) : await recognize(page)));
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

export async function renderPage(
  document: PDFDocumentProxy,
  page: number,
): Promise<{ mime: "image/png"; bytes: Uint8Array; width: number; height: number }> {
  const loaded = await document.getPage(page);
  const base = loaded.getViewport({ scale: 1 });
  const viewport = loaded.getViewport({
    scale: Math.min(1, MAX_EDGE / Math.max(base.width, base.height)),
  });

  const canvas = window.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await loaded.render({ canvas, viewport }).promise;

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("这一页渲染不出来");
  // 画完就把画布缩到 0：不释放的话几页目录就是上百 MB，而它已经没用了。
  canvas.width = canvas.height = 0;

  return {
    mime: "image/png",
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width || Math.ceil(viewport.width),
    height: Math.ceil(viewport.height),
  };
}

/** 这一页有没有文本层。没有就是扫描版，只能走模型。 */
export async function hasTextLayer(document: PDFDocumentProxy, page: number): Promise<boolean> {
  return (await pageLines(document, page)).length > 0;
}

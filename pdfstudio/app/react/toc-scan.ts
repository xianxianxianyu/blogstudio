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

export async function readTocPages(
  document: PDFDocumentProxy,
  from: number,
  to: number,
): Promise<TocEntry[]> {
  const pages: Line[][] = [];
  for (let page = from; page <= to; page++) pages.push(await pageLines(document, page));
  return parseToc(pages);
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

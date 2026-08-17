import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Section } from "../../src/clip/outline";

/**
 * 从 PDF 里把目录取出来并拍平：树 → 按阅读顺序排的一串 `Section`。
 *
 * 这是不纯的那一半——`dest` 要经 pdf.js 解成页码。归组规则在 `src/clip/outline.ts`，
 * 纯函数、有测试；这里只负责把数据取出来。
 *
 * **三分之一的论文没有目录**（实测 ResNet 就没有），所以拿不到目录是正常路径而不是
 * 错误：返回空数组，归组那边自然退回按页排。
 */
export async function readOutline(document: PDFDocumentProxy): Promise<Section[]> {
  const tree = await document.getOutline().catch(() => null);
  if (!tree) return [];

  const sections: Section[] = [];

  const walk = async (items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>, level: number, path: string[]) => {
    for (const item of items ?? []) {
      const title = item.title.trim();
      const at = await locate(document, item.dest);
      // dest 解不开的仍然收下，`y: null` 让它退化成按页归组——丢掉的话整段目录会缺一块，
      // 而缺的那块下面的摘录会静默归到上一节去。
      if (at !== null) sections.push({ title, page: at.page, y: at.y, level, path });
      if (item.items?.length) await walk(item.items, level + 1, [...path, title]);
    }
  };

  await walk(tree, 0, []);
  return sections;
}

/**
 * `dest` → 页码与页内位置。
 *
 * **页内位置不是可有可无的**：实测 Attention 的 p.2 上挤了三个目录项、p.5 也是三个，
 * 只拿页码归组会把整页的摘录堆到错的小节去。`XYZ` 型 dest 的第四个元素就是 y。
 */
async function locate(
  document: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<{ page: number; y: number | null } | null> {
  try {
    const resolved = typeof dest === "string" ? await document.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;

    const page = (await document.getPageIndex(resolved[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
    // XYZ 是 [ref, {name}, x, y, zoom]；FitH 之类只有一个坐标，形状不同的一律当没有 y。
    const y = resolved[1] && (resolved[1] as { name?: string }).name === "XYZ" ? resolved[3] : null;
    return { page, y: typeof y === "number" ? y : null };
  } catch {
    return null;
  }
}

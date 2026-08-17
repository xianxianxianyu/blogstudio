import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfAssetOptions } from "../src/pdf/assets";

// pdf.js 是 category 1（in-process）依赖：不做 port，测试直接喂真实 PDF。
const PAPERS_DIR = path.join(import.meta.dirname, "..", "eval", "papers");

/**
 * node 侧直接指 `node_modules/pdfjs-dist`。用 `import.meta.resolve` 而不是从
 * `import.meta.dirname` 往上数 `../..`——包管理器的目录布局不归我们管，数错了只会在
 * 别人的机器上崩。
 */
const PDFJS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/build/pdf.mjs"))));

export function openFixturePdf(fileName: string): Promise<PDFDocumentProxy> {
  return readFile(path.join(PAPERS_DIR, fileName)).then((buffer) =>
    getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: false,
      // 少了这几个，不嵌字体的中文书 getTextContent() 直接返回空串（见 src/pdf/assets.ts）。
      ...pdfAssetOptions(`${PDFJS_ROOT}/`),
    }).promise,
  );
}

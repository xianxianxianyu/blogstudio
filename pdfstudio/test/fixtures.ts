import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";

// pdf.js 是 category 1（in-process）依赖：不做 port，测试直接喂真实 PDF。
const PAPERS_DIR = path.join(import.meta.dirname, "..", "eval", "papers");

export function openFixturePdf(fileName: string): Promise<PDFDocumentProxy> {
  return readFile(path.join(PAPERS_DIR, fileName)).then((buffer) =>
    getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: false,
    }).promise,
  );
}

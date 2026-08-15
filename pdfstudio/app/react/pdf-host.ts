import * as pdfjs from "pdfjs-dist";

/**
 * pdf.js 的文档句柄住在视图这一侧。
 *
 * `Workspace` 只认 `Recognizer` 这个端口（ADR-0013），所以它换书时会回调
 * `openDocument`，由这里把新文档接住——视图随后就能拿它渲染。
 */
export interface PdfHost {
  open(bytes: Uint8Array): Promise<pdfjs.PDFDocumentProxy>;
  readonly document: pdfjs.PDFDocumentProxy | null;
}

export function createPdfHost(): PdfHost {
  let document: pdfjs.PDFDocumentProxy | null = null;

  return {
    async open(bytes: Uint8Array): Promise<pdfjs.PDFDocumentProxy> {
      document = await pdfjs.getDocument({ data: bytes }).promise;
      return document;
    },
    get document() {
      return document;
    },
  };
}

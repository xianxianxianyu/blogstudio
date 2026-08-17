import * as pdfjs from "pdfjs-dist";
import { pdfAssetOptions } from "../../src/pdf/assets";
import { apiUrl } from "../api-base";

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
      document = await pdfjs.getDocument({
        data: bytes,
        // **少了这几个参数，不嵌字体的中文书 getTextContent() 直接返回空串**，不报错
        // （见 src/pdf/assets.ts）。走本机 API 而不是相对路径：打包后页面是 file://，
        // 没有 origin 可依（同 api-base.ts）。
        ...pdfAssetOptions(apiUrl("/__pdfjs")),
      }).promise;
      return document;
    },
    get document() {
      return document;
    },
  };
}

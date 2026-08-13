# PDF 渲染与文本层抽取用 pdf.js

PDF Studio 用 pdf.js（`pdfjs-dist`，Apache-2.0，Firefox 内置查看器同款引擎）做 PDF 渲染和文本层抽取。它对比 MuPDF（AGPL copyleft）和 PDFium WASM（停滞/单人维护）胜出；`page.getTextContent()` 暴露的逐项 `transform` 矩阵正是混合 OCR 里文字区路径需要的 API。渲染在客户端跑（需要 canvas），文本抽取可无头运行。

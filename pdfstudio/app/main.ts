/**
 * 框选竖切（开发用，不是产品界面）。
 *
 * 它存在的唯一理由：`Region.pixels` 在所有测试和 eval 里都是占位字节或现成的 PNG 文件，
 * **「从屏幕框一块 → 渲染成图 → 交给模型」这条链路端到端一次都没跑过**。
 * 坐标换算已经有单元测试（`capture.test.ts`），这里补的是浏览器那半：canvas 裁剪与编码。
 *
 *   npm run dev:pdfstudio
 *
 * 配置从 localStorage 读，没有就问一次——避免把 key 写进任何被服务的文件。
 */
import * as pdfjs from "pdfjs-dist";
// @ts-expect-error ——`?url` 是 Vite 的产物，TS 不认识这种导入
import worker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { toPageRect } from "../src/capture/capture";
import { createRecognizer } from "../src/recognizer/recognizer";
import { createModelClient } from "../src/model/openai-compatible";
import { parseConfig, resolveEndpoint } from "../src/config/config";
import type { Screenshot } from "../src/recognizer/recognizer";

pdfjs.GlobalWorkerOptions.workerSrc = worker as string;

const canvas = document.querySelector<HTMLCanvasElement>("#page")!;
const box = document.querySelector<HTMLDivElement>("#box")!;
const out = document.querySelector<HTMLDivElement>("#out")!;
const pageNo = document.querySelector<HTMLInputElement>("#pageNo")!;
const scaleInput = document.querySelector<HTMLInputElement>("#scale")!;

function endpoint() {
  const stored = localStorage.getItem("pdfstudio-config");
  const raw = stored ?? window.prompt('贴入配置 JSON，例如 {"baseURL":"…","apiKey":"…","model":"…"}') ?? "{}";
  localStorage.setItem("pdfstudio-config", raw);
  return resolveEndpoint(parseConfig(JSON.parse(raw) as unknown), "recognition");
}

const document_ = await pdfjs.getDocument({ url: "/papers/1706.03762.pdf" }).promise;
let viewport = await draw();

async function draw() {
  const page = await document_.getPage(Number(pageNo.value));
  const vp = page.getViewport({ scale: Number(scaleInput.value) });
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvas, viewport: vp }).promise;
  return vp;
}

document.querySelector("#reload")!.addEventListener("click", async () => {
  viewport = await draw();
});

let start: { x: number; y: number } | null = null;

canvas.addEventListener("pointerdown", (event) => {
  const rect = canvas.getBoundingClientRect();
  start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  Object.assign(box.style, { display: "block", left: `${start.x}px`, top: `${start.y}px`, width: "0px", height: "0px" });
});

canvas.addEventListener("pointermove", (event) => {
  if (!start) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  Object.assign(box.style, {
    left: `${Math.min(start.x, x)}px`,
    top: `${Math.min(start.y, y)}px`,
    width: `${Math.abs(x - start.x)}px`,
    height: `${Math.abs(y - start.y)}px`,
  });
});

canvas.addEventListener("pointerup", async (event) => {
  if (!start) return;
  const rect = canvas.getBoundingClientRect();
  const drag = { x0: start.x, y0: start.y, x1: event.clientX - rect.left, y1: event.clientY - rect.top };
  start = null;

  const pageRect = toPageRect(viewport, drag);
  const pixels = await crop(drag);

  out.innerHTML = `<p>页面矩形 <code>${JSON.stringify(pageRect, null, 0)}</code></p>`;
  const preview = new Image();
  preview.src = URL.createObjectURL(new Blob([pixels.bytes as BlobPart], { type: pixels.mime }));
  out.append(preview);

  const model = createModelClient(endpoint());
  const recognizer = createRecognizer({ document: document_, recognition: model });
  const pre = window.document.createElement("pre");
  pre.textContent = "识别中…";
  out.append(pre);

  try {
    const content = await recognizer.recognize({ page: Number(pageNo.value), rect: pageRect, pixels });
    pre.textContent = JSON.stringify(
      { route: content.route, sourceText: content.sourceText, multimodal: content.multimodal },
      null,
      2,
    );
  } catch (error) {
    pre.textContent = `${(error as { kind?: string }).kind ?? "error"}：${(error as Error).message}`;
  }
});

/** 从已渲染的画布上裁一块，编码成 PNG——这是端到端链路里唯一浏览器专属的一段。 */
async function crop(drag: { x0: number; y0: number; x1: number; y1: number }): Promise<Screenshot> {
  const width = Math.abs(drag.x1 - drag.x0);
  const height = Math.abs(drag.y1 - drag.y0);
  const cut = window.document.createElement("canvas");
  cut.width = width;
  cut.height = height;
  cut
    .getContext("2d")!
    .drawImage(canvas, Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), width, height, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve) => cut.toBlob((b) => resolve(b!), "image/png"));
  return { mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

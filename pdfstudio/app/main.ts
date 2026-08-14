/**
 * 框选竖切（开发用，不是产品界面）。
 *
 * 它存在的唯一理由：`Region.pixels` 在所有测试和 eval 里都是占位字节或现成的 PNG 文件，
 * **「从屏幕框一块 → 渲染成图 → 交给模型」这条链路端到端一次都没跑过**。
 * 坐标换算已经有单元测试（`capture.test.ts`），这里补的是浏览器那半：canvas 裁剪与编码。
 *
 *   npm run dev:pdfstudio
 *
 * 配置由 dev server 从 `pdfstudio/config.json` 递过来（浏览器读不了文件系统）。
 * 那个路由只挂在 configureServer 上，不存在于构建产物里——ADR-0005：真实 key
 * 绝不进源码或构建产物。
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

const appConfig = parseConfig(
  await fetch("/__config")
    .then((response) => response.json() as Promise<unknown>)
    .catch(() => null),
);

function endpoint() {
  const resolved = resolveEndpoint(appConfig, "recognition");
  // 走 dev server 转发而不是直连：那个端点的 OPTIONS 预检返回 403，浏览器过不去。
  // 打包应用里没有这一层（ADR-0006），所以这行是开发页面专属的。
  return { ...resolved, baseURL: "/__model" };
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

document.querySelector("#total")!.textContent = String(document_.numPages);

// 改完就重画，不用再记得点按钮；翻页按钮把页码夹在有效范围内。
async function go(page: number) {
  pageNo.value = String(Math.min(Math.max(page, 1), document_.numPages));
  viewport = await draw();
}

pageNo.addEventListener("change", () => void go(Number(pageNo.value)));
scaleInput.addEventListener("change", () => void go(Number(pageNo.value)));
document.querySelector("#prev")!.addEventListener("click", () => void go(Number(pageNo.value) - 1));
document.querySelector("#next")!.addEventListener("click", () => void go(Number(pageNo.value) + 1));

let start: { x: number; y: number } | null = null;

/**
 * 指针坐标（CSS 像素）→ canvas 内部像素。
 *
 * 两者只有在「canvas 没被 CSS 缩放」时才相等。加一条 `max-width`、或者在高 DPI 屏上
 * 换一种画法，比例就变了——而框选与裁剪一个用 CSS 像素、一个用内部像素的话，
 * 框住的和裁出来的就不是同一块。这里一次性换算掉，后面全用内部像素。
 */
function atCanvas(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * canvas.width) / rect.width,
    y: ((event.clientY - rect.top) * canvas.height) / rect.height,
  };
}

/** 内部像素 → CSS 像素，只用于把选框画在正确的位置上。 */
function toCss(value: number, axis: "x" | "y"): number {
  const rect = canvas.getBoundingClientRect();
  return axis === "x" ? (value * rect.width) / canvas.width : (value * rect.height) / canvas.height;
}

canvas.addEventListener("pointerdown", (event) => {
  start = atCanvas(event);
  Object.assign(box.style, {
    display: "block",
    left: `${toCss(start.x, "x")}px`,
    top: `${toCss(start.y, "y")}px`,
    width: "0px",
    height: "0px",
  });
});

canvas.addEventListener("pointermove", (event) => {
  if (!start) return;
  const { x, y } = atCanvas(event);
  Object.assign(box.style, {
    left: `${toCss(Math.min(start.x, x), "x")}px`,
    top: `${toCss(Math.min(start.y, y), "y")}px`,
    width: `${toCss(Math.abs(x - start.x), "x")}px`,
    height: `${toCss(Math.abs(y - start.y), "y")}px`,
  });
});

canvas.addEventListener("pointerup", async (event) => {
  if (!start) return;
  const end = atCanvas(event);
  const drag = { x0: start.x, y0: start.y, x1: end.x, y1: end.y };
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

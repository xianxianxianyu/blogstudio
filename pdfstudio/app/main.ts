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
import { isMisTouch, toPageRect } from "../src/capture/capture";
import { createRecognizer } from "../src/recognizer/recognizer";
import { createModelClient } from "../src/model/openai-compatible";
import { parseConfig, resolveEndpoint } from "../src/config/config";
import { captureClip } from "../src/clip/capture-clip";
import { createHttpClipStore } from "./http-clip-store";
import type { ClipsState } from "../src/clip/clip";
import type { Screenshot } from "../src/recognizer/recognizer";

pdfjs.GlobalWorkerOptions.workerSrc = worker as string;

const canvas = document.querySelector<HTMLCanvasElement>("#page")!;
const box = document.querySelector<HTMLDivElement>("#box")!;
const out = document.querySelector<HTMLDivElement>("#out")!;
const pageNo = document.querySelector<HTMLInputElement>("#pageNo")!;
const scaleInput = document.querySelector<HTMLInputElement>("#scale")!;

// 落盘走 dev server：clip-store 导入 node:fs，浏览器里加载就白屏。ClipStore 是端口，
// 换个实现即可，编排代码一行不用动（打包应用里这条边界是 IPC，ADR-0006）。
const store = createHttpClipStore("/__clips");
const docId = "1706.03762";
let clips: ClipsState = { clips: [], contexts: [] };

const appConfig = parseConfig(
  await fetch("/__config")
    .then((response) => response.json() as Promise<unknown>)
    .catch(() => null),
);

function endpoint() {
  const resolved = resolveEndpoint(appConfig, "recognition");
  // 走 dev server 转发而不是直连：那个端点的 OPTIONS 预检返回 403，浏览器过不去。
  // 打包应用里没有这一层（ADR-0006），所以这行是开发页面专属的。
  //
  // **必须是绝对 URL**：SDK 会拿 baseURL 去构造 URL 对象，相对路径直接抛。
  return { ...resolved, baseURL: `${location.origin}/__model` };
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

  // 误触就当一次点击：收掉选框，什么都不做。不弹错——手滑本来就常见，
  // 每次都报一句「区域太小」只是噪音；真正要防的是白烧一次付费调用。
  if (isMisTouch(drag)) {
    box.style.display = "none";
    return;
  }

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

  // 编排交给 captureClip：识别、状态迁移、落盘的**顺序**归它管，这一层只负责显示。
  const outcome = await captureClip(
    { recognizer, store, newId: () => `clip-${clips.clips.length + 1}` },
    clips,
    docId,
    { page: Number(pageNo.value), rect: pageRect, pixels },
  );
  clips = outcome.state;

  if (!outcome.ok) {
    // 把 cause 链整条打出来。只报最外层的 kind 会把真正的原因吞掉——
    // 「model-unavailable：模型调用失败」这种话对排查毫无帮助。
    const chain: string[] = [];
    for (let e: unknown = outcome.error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      chain.push(`${(e as { kind?: string }).kind ?? e.name}: ${e.message}`);
    }
    pre.textContent = `${chain.join("\n  ↳ ")}\n\n摘录退回 capturing，可以直接再框一次同一块地方重试。`;
    console.error(outcome.error);
    return;
  }

  // 按 clipId 取，不取「最后一条」——重试同一块地方是**合并进原摘录**，不追加新的，
  // 那时最后一条会指到别人身上。
  const clip = clips.clips.find((candidate) => candidate.id === outcome.clipId)!;
  pre.textContent = JSON.stringify(
    {
      id: clip.id,
      state: clip.state,
      route: clip.content?.route,
      sourceText: clip.sourceText,
      multimodal: clip.content?.multimodal,
      落盘: `pdfstudio/.clips/${docId}/${clip.id}/index.md`,
    },
    null,
    2,
  );
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

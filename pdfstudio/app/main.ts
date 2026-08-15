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
import { isMisTouch, toCanvasBox, toPageRect } from "../src/capture/capture";
import { createRecognizer } from "../src/recognizer/recognizer";
import { createModelClient } from "../src/model/openai-compatible";
import { parseConfig, resolveEndpoint } from "../src/config/config";
import { captureClip } from "../src/clip/capture-clip";
import { can, reduce } from "../src/clip/clip";
import { createHttpClipStore } from "./http-clip-store";
import { createHttpBookshelf } from "./http-bookshelf";
import type { Clip, ClipsState } from "../src/clip/clip";
import type { Doc } from "../src/bookshelf/bookshelf";
import type { Screenshot } from "../src/recognizer/recognizer";

pdfjs.GlobalWorkerOptions.workerSrc = worker as string;

const canvas = document.querySelector<HTMLCanvasElement>("#page")!;
const box = document.querySelector<HTMLDivElement>("#box")!;
const out = document.querySelector<HTMLDivElement>("#out")!;
const pageNo = document.querySelector<HTMLInputElement>("#pageNo")!;
const scaleInput = document.querySelector<HTMLInputElement>("#scale")!;
const marks = document.querySelector<HTMLDivElement>("#marks")!;
const shelfList = document.querySelector<HTMLUListElement>("#shelf")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const panel = document.querySelector<HTMLDivElement>("#clip")!;

// 落盘走 dev server：clip-store 与 bookshelf 都导入 node:fs，浏览器里加载就白屏。
// 两者都是端口，换个实现即可，领域代码一行不用动（打包应用里这条边界是 IPC，ADR-0006）。
const store = createHttpClipStore("/__clips");
const shelf = createHttpBookshelf("/__docs");

let docId = "";
// 启动就把已有摘录读回来。不读的话有两个后果，都已经真实发生过：
// 1. id 计数器从头开始，新摘录覆盖掉磁盘上的旧摘录（第一条 Encoder 摘录就是这么没的）。
// 2. capture 按区域合并是在内存状态里查的，状态空了就查不到——刷新后重框同一块地方
//    会长出第二条摘录，而「同区域两个标签会让锚点回跳有歧义」正是当初禁止的。
// 文件是唯一真相（ADR-0011），那就得真的把它当真相读。
let clips: ClipsState = { clips: [], contexts: [] };

const appConfig = parseConfig(
  await fetch("/__config")
    .then((response) => response.json() as Promise<unknown>)
    .catch(() => null),
);

function endpoint(capability: "recognition" | "translation") {
  const resolved = resolveEndpoint(appConfig, capability);
  // 走 dev server 转发而不是直连：那个端点的 OPTIONS 预检返回 403，浏览器过不去。
  // 打包应用里没有这一层（ADR-0006），所以这行是开发页面专属的。
  //
  // **必须是绝对 URL**：SDK 会拿 baseURL 去构造 URL 对象，相对路径直接抛。
  return { ...resolved, baseURL: `${location.origin}/__model` };
}

let document_: pdfjs.PDFDocumentProxy | null = null;
let viewport: pdfjs.PageViewport | null = null;

async function draw() {
  if (!document_) return null;
  const page = await document_.getPage(Number(pageNo.value));
  const vp = page.getViewport({ scale: Number(scaleInput.value) });
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvas, viewport: vp }).promise;
  return vp;
}

/**
 * 换一本书：读字节、开文档、把这本书的摘录读回来。
 *
 * 摘录必须跟着换。共用一份内存状态而不重载的话，上一本的标签会画到这一本的页面上
 * ——锚点是页码 + 矩形，换本书它照样"有效"，只是指着完全不相干的地方。
 */
async function openDoc(id: string) {
  docId = id;
  document_ = await pdfjs.getDocument({ data: await shelf.read(id) }).promise;
  clips = { clips: await store.listByDoc(id), contexts: [] };
  pageNo.value = "1";
  document.querySelector("#total")!.textContent = String(document_.numPages);
  panel.replaceChildren();
  out.replaceChildren();
  viewport = await draw();
  drawMarks();
  renderShelf();
}

async function renderShelf() {
  const docs = await shelf.list();
  shelfList.replaceChildren(
    ...docs.map((doc) => {
      const row = window.document.createElement("li");
      if (doc.id === docId) row.className = "on";
      const open = window.document.createElement("button");
      open.textContent = doc.title;
      open.title = doc.filename;
      open.addEventListener("click", () => void openDoc(doc.id));
      row.append(open, button("×", () => void removeDoc(doc)));
      return row;
    }),
  );
  if (docs.length === 0) shelfList.textContent = "书架是空的，选一个 PDF 导入。";
}

async function removeDoc(doc: Doc) {
  // 删一本书会连它的全部摘录一起删——它们就住在同一个文件夹里（ADR-0011 的形状）。
  // 这比删一条摘录重得多，所以把后果说清楚。
  if (!window.confirm(`删掉《${doc.title}》？它的全部摘录会一起没有，且不可撤销。`)) return;
  await shelf.remove(doc.id);
  if (doc.id === docId) {
    docId = "";
    document_ = null;
    clips = { clips: [], contexts: [] };
    canvas.width = canvas.height = 0;
    marks.replaceChildren();
    panel.replaceChildren();
  }
  await renderShelf();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  void (async () => {
    const doc = await shelf.import({
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      at: Date.now(),
    });
    fileInput.value = "";
    // 同一篇论文再导入一次会拿回同一个 id，于是这里直接打开——已有的摘录原样接上，
    // 而不是变成一本空白的新书。
    await openDoc(doc.id);
  })();
});

// 开机就上架：有书就打开第一本。
const shelved = await shelf.list();
if (shelved.length > 0) await openDoc(shelved[0].id);
else await renderShelf();

/**
 * 把这一页上的摘录画成标签。
 *
 * 标签的独特价值不是取回内容（重划一次也能取回），而是**「这儿我来过」**——三个月后
 * 重开论文，标签疏密就是当初的注意力地图。所以随手划过的那批也画，只是淡一点
 * （ADR-0012）。滤掉它们等于把这个功能最独特的部分扔了。
 */
function drawMarks() {
  marks.replaceChildren();
  if (!viewport) return;
  const page = Number(pageNo.value);

  for (const clip of clips.clips) {
    if (clip.region.page !== page) continue;
    const box = toCanvasBox(viewport, clip.region.rect);
    const mark = window.document.createElement("div");
    mark.className = clip.important ? "mark important" : "mark";
    Object.assign(mark.style, {
      left: `${toCss(box.x0, "x")}px`,
      top: `${toCss(box.y0, "y")}px`,
      width: `${toCss(box.x1 - box.x0, "x")}px`,
      height: `${toCss(box.y1 - box.y0, "y")}px`,
    });
    marks.append(mark);
  }
}

/** 点在哪条摘录上。后来的盖在先来的上面，所以从后往前找。 */
function clipAt(point: { x: number; y: number }): Clip | undefined {
  const vp = viewport;
  if (!vp) return undefined;
  const page = Number(pageNo.value);
  return clips.clips
    .filter((clip) => clip.region.page === page)
    .reverse()
    .find((clip) => {
      const box = toCanvasBox(vp, clip.region.rect);
      return point.x >= box.x0 && point.x <= box.x1 && point.y >= box.y0 && point.y <= box.y1;
    });
}

function showClip(id: string) {
  const clip = clips.clips.find((candidate) => candidate.id === id);
  if (!clip) return;

  // 看过一次就重新计时（ADR-0012）：保留期从最后一次查看起算，第 30 天点开了它
  // 说明它还活着。代价是**读操作也要写盘**，ADR 里记了这笔账。
  clips = reduce(clips, { type: "view", id, at: Date.now() });
  void persist(id);

  panel.replaceChildren();
  panel.append(
    button(clip.important ? "★ 重要（点击取消）" : "☆ 标记为重要", () =>
      apply({ type: "toggle-important", id }),
    ),
    button("删除", () => remove(id)),
    heading(`原文（第 ${clip.region.page} 页 · ${clip.content?.route ?? "?"}）`),
    // 原文只准修错字，不得改写措辞——守卫按编辑距离判（≤ 2）。被拒时把理由原样显示，
    // 因为那句话本身就是规则，含糊过去读者只会以为是保存失败。
    editor(clip.sourceText ?? "", (text) => apply({ type: "fix-source", id, text })),
    heading("译文"),
    editor(clip.translation ?? "", (text) => apply({ type: "edit-translation", id, text })),
    heading("笔记"),
    // 笔记是读者自己写的，删了就永远没了——写过笔记的摘录回收器不会碰（ADR-0012）。
    editor(clip.note ?? "", (text) => apply({ type: "add-note", id, text })),
  );

  if (clip.content?.multimodal) {
    panel.append(heading("图像描述"), pre(clip.content.multimodal));
  }

  /** 走 can() 再 reduce：拒绝的理由要给读者看见，不能默默什么都没发生。 */
  function apply(action: Parameters<typeof reduce>[1]) {
    const verdict = can(clips, action);
    if (!verdict.ok) {
      window.alert(verdict.reason);
      return;
    }
    clips = reduce(clips, action);
    void persist(id).then(() => {
      drawMarks();
      showClip(id);
    });
  }
}

/**
 * 落盘再改内存视图。**顺序不能反**：文件是唯一真相（ADR-0011），先改内存的话
 * 写盘失败就成了「界面说改了、磁盘上没改」，刷新一次改动凭空消失。
 */
function persist(id: string): Promise<void> {
  return store.save(docId, clips.clips.find((c) => c.id === id)!);
}

async function remove(id: string) {
  // 删除不可逆，且删的是整个文件夹——ADR-0012 把自动回收的破坏性记成了代价，
  // 手动删同样要拦一道。
  if (!window.confirm("删掉这条摘录？截图和笔记会一起没有，且不可撤销。")) return;

  // 同样是先落盘再改内存。反过来的话删盘失败，界面上标签没了、文件还在，
  // 刷新一次它又冒出来——而读者以为已经删掉了。
  await store.delete(docId, id);
  clips = reduce(clips, { type: "delete", id });
  panel.replaceChildren();
  drawMarks();
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = window.document.createElement("button");
  element.className = "star";
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function heading(text: string): HTMLHeadingElement {
  const element = window.document.createElement("h3");
  element.textContent = text;
  return element;
}

function pre(text: string): HTMLPreElement {
  const element = window.document.createElement("pre");
  element.textContent = text;
  return element;
}

/** 失焦才提交：每敲一个字就写一次盘，既吵又会把编辑距离守卫逐字符地卡住。 */
function editor(value: string, onCommit: (text: string) => void): HTMLTextAreaElement {
  const element = window.document.createElement("textarea");
  element.value = value;
  element.rows = 4;
  element.style.width = "100%";
  element.addEventListener("blur", () => {
    if (element.value !== value) onCommit(element.value);
  });
  return element;
}

// 改完就重画，不用再记得点按钮；翻页按钮把页码夹在有效范围内。
async function go(page: number) {
  if (!document_) return;
  pageNo.value = String(Math.min(Math.max(page, 1), document_.numPages));
  viewport = await draw();
  // 重画完才画标签：它们的位置来自 viewport，缩放变了就得跟着变。
  drawMarks();
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
  // 取整：像素没有小数。不取整的话裁图时 canvas 会把小数截断，而 Screenshot 里记的
  // 仍是小数——**截图自报的尺寸与真实字节对不上**，而截图是地面真值（ADR-0011）。
  // 在这里一次取整，锚点与图用的是同一组坐标，不会各偏各的。
  return {
    x: Math.round(((event.clientX - rect.left) * canvas.width) / rect.width),
    y: Math.round(((event.clientY - rect.top) * canvas.height) / rect.height),
  };
}

/** 内部像素 → CSS 像素，只用于把选框画在正确的位置上。 */
function toCss(value: number, axis: "x" | "y"): number {
  const rect = canvas.getBoundingClientRect();
  return axis === "x" ? (value * rect.width) / canvas.width : (value * rect.height) / canvas.height;
}

canvas.addEventListener("pointerdown", (event) => {
  if (!document_) return;
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
  if (!start || !viewport || !document_) return;
  const end = atCanvas(event);
  const drag = { x0: start.x, y0: start.y, x1: end.x, y1: end.y };
  start = null;

  // 拖动 = 新建摘录，点击 = 打开脚下的标签。
  //
  // 标签不能自己接 click：它盖在 canvas 上，一旦吃掉 pointerdown，在已有摘录上
  // **重新框就框不了了**。所以标签设成 pointer-events: none，由这里按坐标判。
  // 误触判定本来就在分辨「这是点击还是拖动」，正好是同一个问题。
  if (isMisTouch(drag)) {
    box.style.display = "none";
    const hit = clipAt(end);
    if (hit) showClip(hit.id);
    return;
  }

  const pageRect = toPageRect(viewport, drag);
  const pixels = await crop(drag);

  out.innerHTML = `<p>页面矩形 <code>${JSON.stringify(pageRect, null, 0)}</code></p>`;
  const preview = new Image();
  preview.src = URL.createObjectURL(new Blob([pixels.bytes as BlobPart], { type: pixels.mime }));
  out.append(preview);

  // 翻译是独立配置的功能（ADR-0010），要单独接。漏了它 translate() 根本不会被调用,
  // 而划词翻译恰恰是日常主路径——第一条落盘的摘录就是这么少了 `## 译文` 的。
  const recognizer = createRecognizer({
    document: document_,
    recognition: createModelClient(endpoint("recognition")),
    translation: createModelClient(endpoint("translation")),
  });
  const pre = window.document.createElement("pre");
  pre.textContent = "识别中…";
  out.append(pre);

  // 编排交给 captureClip：识别、状态迁移、落盘的**顺序**归它管，这一层只负责显示。
  const outcome = await captureClip(
    // 不能拿数量当 id：它只反映内存里有几条，刷新一次就重头数，直接覆盖旧文件。
    { recognizer, store, newId: () => crypto.randomUUID(), now: () => Date.now() },
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
  drawMarks();
  showClip(clip.id);
  pre.textContent = JSON.stringify(
    {
      id: clip.id,
      state: clip.state,
      route: clip.content?.route,
      sourceText: clip.sourceText,
      translation: clip.translation,
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

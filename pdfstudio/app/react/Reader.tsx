import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { isMisTouch, toCanvasBox, toPageRect } from "../../src/capture/capture";
import { selectionToRegion, type Fragment } from "../../src/capture/selection";
import { highlightBoxes } from "../../src/recognizer/coverage";
import type { Workspace, WorkspaceState } from "../../src/app/workspace";
import type { Rect, Screenshot } from "../../src/recognizer/recognizer";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { PdfHost } from "./pdf-host";

/** 松手之后在等什么。 */
export type Busy = "recognizing" | "translating" | null;

interface Point {
  x: number;
  y: number;
}

export function Reader({
  ws,
  host,
  state,
  selected,
  page,
  onPages,
  onSelect,
  scale,
  children,
  onCapturing,
  onError,
}: {
  ws: Workspace;
  host: PdfHost;
  state: WorkspaceState;
  selected: string | null;
  page: number;
  /** 总页数交给外面显示——翻页控件在顶栏，它是「这本书」的控件，不是画布的一部分。 */
  onPages: (total: number) => void;
  onSelect: (clipId: string | null, at?: { x: number; y: number }) => void;
  scale: number;
  /** 浮动菜单由外面渲染——它要动到对话与摘录，那些不归 Reader 管。 */
  children?: React.ReactNode;
  /**
   * 正在忙什么。**不是一个 boolean**：文本流那条路根本不调识别模型（原文来自文本层、
   * 是免费的，ADR-0016），报「识别中」是在说一件没发生的事。
   */
  onCapturing: (doing: Busy) => void;
  onError: (message: string | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<pdfjs.PageViewport | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const [display, setDisplay] = useState<{ width: number; height: number } | null>(null);
  // 这一页的文字项，用来把文本摘录画成覆盖真实文字行的高亮（ADR-0016）。
  // 每页取一次——Recognizer 里也取，但那是识别时；渲染时要另取。
  const [textItems, setTextItems] = useState<TextItem[]>([]);
  // 页面左右边界，判双栏要用。带 CropBox 偏移的 PDF 上 left 不为 0，所以取实际的 view。
  const [pageBox, setPageBox] = useState<{ left: number; right: number } | null>(null);
  const start = useRef<Point | null>(null);

  /**
   * canvas 的**显示**尺寸。它与内部像素只有在「canvas 没被 CSS 缩放」时才相等，
   * 而框选与裁剪必须用同一套坐标。放进 state 而不是渲染时现读 ref：渲染期读 ref
   * 拿到的是上一帧的值，尺寸一变标签就会停在旧位置上，且不报错。
   */
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setDisplay({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const document = host.document;
      if (!document || !canvas.current) return;
      const rendered = await document.getPage(Math.min(page, document.numPages));
      const vp = rendered.getViewport({ scale });
      if (cancelled) return;
      canvas.current.width = vp.width;
      canvas.current.height = vp.height;
      await rendered.render({ canvas: canvas.current, viewport: vp }).promise;
      if (cancelled) return;
      setViewport(vp);
      onPages(document.numPages);
      const content = await rendered.getTextContent();
      if (cancelled) return;
      setTextItems(content.items.filter((item): item is TextItem => "str" in item));
      setPageBox({ left: rendered.view[0], right: rendered.view[2] });

      // 文本层：透明的真实文字，盖在 canvas 上，让浏览器接管命中测试与字形级偏移
      // （ADR-0016 第二步）。
      //
      // **它失败不该让阅读页挂掉**：没有文本层只是选不了文字，框选、识别、翻译全都
      // 还在。pdf.js 的这个 API 在版本间换过名字和签名，而它是 app 层——这一层的
      // 东西没有测试守着，只能靠「坏了也还能用」兜。
      const container = layer.current;
      if (!container) return;
      try {
        container.replaceChildren();
        // TextLayer 自己会调 setLayerDimensions，而那里的宽高是
        // `round(down, var(--total-scale-factor) * Npx, …)`——这个变量得先有值。
        container.style.setProperty("--total-scale-factor", String(vp.scale));
        await new pdfjs.TextLayer({ textContentSource: content, container, viewport: vp }).render();
      } catch (error) {
        container.replaceChildren();
        console.warn("文本层渲染失败，退回纯框选", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, state.docId, page, scale, onPages]);

  /**
   * 指针坐标（CSS 像素）→ canvas 内部像素，并取整。
   *
   * 两者只有在「canvas 没被 CSS 缩放」时才相等，而框选与裁剪必须用同一套坐标，
   * 否则框住的和裁出来的不是同一块。取整是因为像素没有小数：不取整的话裁图时
   * canvas 会截断，而 Screenshot 里仍记着小数——截图自报的尺寸与真实字节对不上，
   * 可截图是地面真值（ADR-0011）。
   */
  function at(event: React.PointerEvent): Point {
    const element = canvas.current!;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) * element.width) / rect.width),
      y: Math.round(((event.clientY - rect.top) * element.height) / rect.height),
    };
  }

  /**
   * 菜单挂在选区下沿偏左，**视口坐标**。
   *
   * 用视口坐标而不是容器内坐标：菜单挂在 body 上（滚动容器会裁掉溢出的部分，
   * 页面右侧框选时会被右栏切掉一半）。canvas 的位置直接给出这一层换算。
   */
  function menuAt(box: { x0: number; y0: number; x1: number; y1: number }) {
    const rect = canvas.current!.getBoundingClientRect();
    return {
      x: rect.left + css(Math.min(box.x0, box.x1), "x"),
      y: rect.top + css(Math.max(box.y0, box.y1), "y") + 6,
    };
  }

  /** 内部像素 → CSS 像素，只用于把框和标签画在正确的位置上。 */
  function css(value: number, axis: "x" | "y"): number {
    if (!viewport || !display) return value;
    return axis === "x"
      ? (value * display.width) / viewport.width
      : (value * display.height) / viewport.height;
  }

  /** 点在哪条摘录上。后来的盖在先来的上面，所以从后往前找。 */
  function clipAt(point: Point): string | null {
    if (!viewport) return null;
    const hit = state.clips
      .filter((clip) => clip.region.page === page)
      .reverse()
      .find((clip) => {
        const box = toCanvasBox(viewport, clip.region.rect);
        return point.x >= box.x0 && point.x <= box.x1 && point.y >= box.y0 && point.y <= box.y1;
      });
    return hit?.id ?? null;
  }

  /** 视口坐标的矩形 → 页面坐标。和 `at()` 同一套换算，只是输入是 DOMRect。 */
  function toPage(box: DOMRect): Rect {
    const element = canvas.current!;
    const bounds = element.getBoundingClientRect();
    const sx = element.width / bounds.width;
    const sy = element.height / bounds.height;
    return toPageRect(viewport!, {
      x0: (box.left - bounds.left) * sx,
      y0: (box.top - bounds.top) * sy,
      x1: (box.right - bounds.left) * sx,
      y1: (box.bottom - bounds.top) * sy,
    });
  }

  /**
   * 原生选区 → 逐个片段的文本与页面矩形。
   *
   * 一个 span 一个片段，而不是整段 `selection.toString()`：那给的是 **DOM 顺序**，
   * 在双栏页上是乱的（实测 ResNet p.8 左右栏切换 14 次）。归栏与读序归域层管，
   * 这里只负责把浏览器知道的东西**逐片**交出去。
   */
  function fragmentsOf(selection: Selection): Fragment[] {
    const fragments: Fragment[] = [];
    if (!layer.current) return fragments;

    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);

      for (const span of layer.current.querySelectorAll("span")) {
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(span)) continue;

        // 收窄到「这个 span ∩ 选区」：首尾两个 span 只有一部分被选中，而它们恰恰是
        // 整个功能的意义所在——一行常常只有一个 span 且装着整行。
        // window.document——这个组件里 `document` 是 host.document（PDFDocumentProxy）。
        const part = window.document.createRange();
        part.selectNodeContents(node);
        if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
          part.setStart(range.startContainer, range.startOffset);
        }
        if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
          part.setEnd(range.endContainer, range.endOffset);
        }

        const text = part.toString();
        if (text !== "") fragments.push({ text, rect: toPage(part.getBoundingClientRect()) });
      }
    }

    return fragments;
  }

  /**
   * 松手时把原生选区变成一条摘录。
   *
   * 没选中东西（在文字上单击）就走标签命中——文字层吃掉了 pointerdown，canvas 那条
   * 「点击 = 打开脚下的标签」的路径在文字上够不着了，要在这里补回来。
   */
  async function finishSelection(event: React.PointerEvent) {
    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode ?? null;

    if (!selection || selection.isCollapsed || !anchorNode || !viewport || !pageBox) {
      const hit = clipAt(at(event));
      if (hit) onSelect(hit, { x: event.clientX, y: event.clientY + 6 });
      return;
    }

    // 起点用 anchorNode 而不是第一个片段：反向拖时 anchor 仍是手指落下的地方，
    // 而归栏正是要看「起手在哪一栏」。
    const anchorRange = window.document.createRange();
    anchorRange.setStart(anchorNode, selection.anchorOffset);
    anchorRange.collapse(true);
    const anchorRect = toPage(anchorRange.getBoundingClientRect());

    const region = selectionToRegion({
      anchor: { x: anchorRect.x, y: anchorRect.y },
      fragments: fragmentsOf(selection),
      pageItems: textItems,
      page: pageBox,
    });
    if (!region) return;

    // 选区已经落成高亮了，蓝色的原生选区留着只会和它叠在一起。
    selection.removeAllRanges();

    onError(null);
    // 这条路只等翻译。
    onCapturing("translating");
    try {
      const box = toCanvasBox(viewport, region.bounds);
      const pixels = await crop(canvas.current!, box);
      const result = await ws.capture(
        { page, rect: region.bounds, pixels, lines: region.lines },
        // 强制 text：这一路的原文来自文本层、是免费的（ADR-0016），不该再去调识别。
        // 覆盖度判据在细长的选区上本来也容易误判成 vision。
        { route: "text", sourceText: region.text },
      );
      if (result.ok) onSelect(result.clipId ?? null, menuAt(box));
      else onError(chain(result.error) || (result.reason ?? "识别失败"));
    } finally {
      onCapturing(null);
    }
  }

  async function finish(end: Point) {
    const from = start.current;
    start.current = null;
    setDrag(null);
    if (!from || !viewport) return;

    const box = { x0: from.x, y0: from.y, x1: end.x, y1: end.y };

    // 拖动 = 新建，点击 = 打开脚下的标签。标签自己接 click 的话它盖在 canvas 上，
    // 会吃掉 pointerdown，在已有摘录上就重新框不了了——所以由坐标判。
    // 误触判定本来就在分辨「这是点击还是拖动」，正好是同一个问题。
    if (isMisTouch(box)) {
      const hit = clipAt(end);
      onSelect(hit, hit === null ? undefined : menuAt(box));
      return;
    }

    onError(null);
    onCapturing("recognizing");
    try {
      const pixels = await crop(canvas.current!, box);
      const result = await ws.capture({ page, rect: toPageRect(viewport, box), pixels });
      // 菜单挂在选区下沿，位置在这里算——只有这里知道刚才框到了哪儿。
      if (result.ok) onSelect(result.clipId ?? null, menuAt(box));
      else onError(chain(result.error) || (result.reason ?? "识别失败"));
    } finally {
      onCapturing(null);
    }
  }

  const document = host.document;

  return (
    // 松手统一在这里收：canvas 与字形 span 的事件都冒泡到这儿，两个处理器各管一半的话，
    // 「在文字上起手、在空白处松手」这类手势会掉在缝里。
    <div className="frame" onPointerUp={(event) => void (start.current ? finish(at(event)) : finishSelection(event))}>
      {children}
        <canvas
          ref={canvas}
          onPointerDown={(event) => {
            if (!document) return;
            // 捕获指针：拖动中途划过文字层的话，后续 move/up 的 target 会变成字形
            // span，canvas 的处理器就再也收不到了——框会停在半路，松手也不落地。
            event.currentTarget.setPointerCapture(event.pointerId);
            start.current = at(event);
            setDrag({ from: start.current, to: start.current });
          }}
          onPointerMove={(event) => {
            if (!start.current) return;
            setDrag({ from: start.current, to: at(event) });
          }}
        />

        {/* 文本层盖在 canvas 上，但容器 pointer-events: none、只有字形 span 吃事件
            （见 app.css）：落在空白或图上的 pointerdown 直接穿透回 canvas，框选照旧。
            事件从 span 冒泡上来，所以监听挂在容器上。 */}
        <div ref={layer} className="textLayer" />

        {/* 标签的独特价值不是取回内容（重划也能取回），而是「这儿我来过」——三个月后
            重开论文，标签疏密就是当初的注意力地图。所以随手划过的那批也画，只是淡一点。

            文本摘录画成**覆盖真实文字行的高亮**，视觉摘录（公式、图）仍画框：那里本来
            就没有文字行可覆盖。框选文本本身就是高亮，不需要第二个工具（ADR-0016）。 */}
        {viewport &&
          state.clips
            .filter((clip) => clip.region.page === page)
            .flatMap((clip) => {
              // 有 lines 就用 lines：文本流选区不是矩形，拿外接矩形裁行会把首尾两行
              // 没选中的地方也涂上（ADR-0016 第二步）。矩形框选没有 lines，仍按老路
              // 从文字项现算。
              const exact = clip.region.lines;
              const highlight = exact !== undefined || clip.content?.route === "text";
              const rects =
                exact ?? (highlight ? highlightBoxes(clip.region.rect, textItems) : [clip.region.rect]);
              const shape = highlight ? "mark line" : "mark";

              return rects.map((rect, index) => {
                const box = toCanvasBox(viewport, rect);
                return (
                  <div
                    key={`${clip.id}-${index}`}
                    data-tag={clip.tagId ?? "none"}
                    className={[shape, clip.important ? "keep" : "", clip.id === selected ? "on" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      left: css(box.x0, "x"),
                      top: css(box.y0, "y"),
                      width: css(box.x1 - box.x0, "x"),
                      height: css(box.y1 - box.y0, "y"),
                    }}
                  />
                );
              });
            })}

      {drag && (
          <div
            className="drag"
            style={{
              left: css(Math.min(drag.from.x, drag.to.x), "x"),
              top: css(Math.min(drag.from.y, drag.to.y), "y"),
              width: css(Math.abs(drag.to.x - drag.from.x), "x"),
              height: css(Math.abs(drag.to.y - drag.from.y), "y"),
            }}
          />
      )}
    </div>
  );
}

/** 从已渲染的画布上裁一块，编码成 PNG——端到端链路里唯一浏览器专属的一段。 */
async function crop(
  source: HTMLCanvasElement,
  box: { x0: number; y0: number; x1: number; y1: number },
): Promise<Screenshot> {
  const width = Math.abs(box.x1 - box.x0);
  const height = Math.abs(box.y1 - box.y0);
  const cut = document.createElement("canvas");
  cut.width = width;
  cut.height = height;
  cut
    .getContext("2d")!
    .drawImage(source, Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), width, height, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve) => cut.toBlob((b) => resolve(b!), "image/png"));
  return { mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/**
 * 把 cause 链整条摊平。只报最外层会把真正的原因吞掉——「model-unavailable：模型调用
 * 失败」这种话对排查毫无帮助，而 Recognizer 特意保留了 cause 正是为了这一刻。
 */
function chain(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    parts.push(`${(e as { kind?: string }).kind ?? e.name}: ${e.message}`);
  }
  return parts.join("\n  ↳ ");
}
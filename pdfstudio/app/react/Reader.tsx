import { useEffect, useRef, useState } from "react";
import type * as pdfjs from "pdfjs-dist";
import { isMisTouch, toCanvasBox, toPageRect } from "../../src/capture/capture";
import { highlightBoxes } from "../../src/recognizer/coverage";
import type { Workspace, WorkspaceState } from "../../src/app/workspace";
import type { Screenshot } from "../../src/recognizer/recognizer";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { PdfHost } from "./pdf-host";

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
  onCapturing: (busy: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<pdfjs.PageViewport | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const [display, setDisplay] = useState<{ width: number; height: number } | null>(null);
  // 这一页的文字项，用来把文本摘录画成覆盖真实文字行的高亮（ADR-0016）。
  // 每页取一次——Recognizer 里也取，但那是识别时；渲染时要另取。
  const [textItems, setTextItems] = useState<TextItem[]>([]);
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
      const { items } = await rendered.getTextContent();
      if (!cancelled) setTextItems(items.filter((item): item is TextItem => "str" in item));
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
    onCapturing(true);
    try {
      const pixels = await crop(canvas.current!, box);
      const result = await ws.capture({ page, rect: toPageRect(viewport, box), pixels });
      // 菜单挂在选区下沿，位置在这里算——只有这里知道刚才框到了哪儿。
      if (result.ok) onSelect(result.clipId ?? null, menuAt(box));
      else onError(chain(result.error) || (result.reason ?? "识别失败"));
    } finally {
      onCapturing(false);
    }
  }

  const document = host.document;

  return (
    <div className="frame">
      {children}
        <canvas
          ref={canvas}
          onPointerDown={(event) => {
            if (!document) return;
            start.current = at(event);
            setDrag({ from: start.current, to: start.current });
          }}
          onPointerMove={(event) => {
            if (!start.current) return;
            setDrag({ from: start.current, to: at(event) });
          }}
          onPointerUp={(event) => void finish(at(event))}
        />

        {/* 标签的独特价值不是取回内容（重划也能取回），而是「这儿我来过」——三个月后
            重开论文，标签疏密就是当初的注意力地图。所以随手划过的那批也画，只是淡一点。

            文本摘录画成**覆盖真实文字行的高亮**，视觉摘录（公式、图）仍画框：那里本来
            就没有文字行可覆盖。框选文本本身就是高亮，不需要第二个工具（ADR-0016）。 */}
        {viewport &&
          state.clips
            .filter((clip) => clip.region.page === page)
            .flatMap((clip) => {
              const highlight = clip.content?.route === "text";
              const rects = highlight
                ? highlightBoxes(clip.region.rect, textItems)
                : [clip.region.rect];
              const shape = highlight ? "mark line" : "mark";

              return rects.map((rect, index) => {
                const box = toCanvasBox(viewport, rect);
                return (
                  <div
                    key={`${clip.id}-${index}`}
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
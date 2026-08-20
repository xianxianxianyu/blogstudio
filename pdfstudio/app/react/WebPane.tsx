import { useEffect, useState } from "react";

/**
 * 应用内浏览器那一栏。
 *
 * **这个组件不渲染网页。** 网页跑在一个 `WebContentsView` 里，那是 OS 层的覆盖层、
 * 不在 React 树里——这里画的只是一个**占位框**，它的任务是量出「网页该摆在哪」
 * 并把矩形推给主进程。
 *
 * 于是有一个别处没有的责任：**位置必须跟着布局走**。窗口缩放、侧栏折叠、切换案头条目
 * 都会改变这块区域，而同步慢一拍，网页就会糊在错的位置上或者盖住侧栏。所以用
 * `ResizeObserver` 盯着占位框自己，而不是在某几个「我以为会变」的时刻手动去推
 * ——那种写法一定会漏掉某个入口。
 */
export function WebPane({ url, onBlocked }: { url: string; onBlocked: (url: string) => void }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // **不是 ref。** 桥在页面加载时就定死了，此后不会变——用 ref 既没必要，
  // 又会在渲染期读 `.current`（lint 拦下过一次，理由也确实成立）。
  const bridge = window.studioWeb;

  // 摆位置。**用 ResizeObserver 盯占位框本身**，不去猜哪些操作会改变布局。
  useEffect(() => {
    if (!box || !bridge) return;
    const push = () => {
      const rect = box.getBoundingClientRect();
      bridge.bounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    push();
    const observer = new ResizeObserver(push);
    observer.observe(box);
    // 滚动和窗口移动不会触发 ResizeObserver，但会改变 getBoundingClientRect。
    window.addEventListener("resize", push);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", push);
    };
  }, [box, bridge]);

  useEffect(() => {
    if (!bridge) return;
    void bridge.open(url);
    return bridge.on((event) => {
      if (event.type === "studio:web:blocked") {
        const blocked = (event.payload as { url: string }).url;
        setNote(`这个地址不在允许的站点里：${blocked}`);
        onBlocked(blocked);
      }
    });
  }, [url, onBlocked, bridge]);

  // 组件走了就把视图收掉——不收的话它会继续浮在书架或设置上面。
  useEffect(() => {
    return () => bridge?.close();
  }, [bridge]);

  if (!bridge) {
    // 浏览器形态（dev server 里打开 /react.html）下没有这个桥。**说出来**，
    // 而不是画一个永远空白的框——那看起来像坏了。
    return (
      <div className="pane">
        <p className="muted">应用内浏览器只在桌面版里有——它用的是 Electron 的原生视图。</p>
      </div>
    );
  }

  return (
    <div className="web-pane">
      {note !== null && <pre className="err">{note}</pre>}
      {/* 网页盖在这块上。它是空的——真正的内容在 OS 层。 */}
      <div className="web-slot" ref={setBox} />
    </div>
  );
}

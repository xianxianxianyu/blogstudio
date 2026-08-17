import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Workspace } from "../../src/app/workspace";
import type { Settings } from "../../src/app/settings";
import type { Conversation } from "../../src/app/conversation";
import type { Progress } from "../../src/app/progress";
import type { PdfHost } from "./pdf-host";
import { ShelfPage } from "./ShelfPage";
import { Reader, type Busy } from "./Reader";
import { ClipsPane } from "./ClipsPane";
import { readOutline } from "./outline";
import type { Section } from "../../src/clip/outline";
import { ChatPanel } from "./ChatPanel";
import { SettingsPanel } from "./SettingsPanel";
import { RetentionNotice } from "./RetentionNotice";
import { SelectionMenu } from "./SelectionMenu";

/**
 * 两层：**书架页**（有哪些书）与**阅读页**（读这一本）。
 *
 * 此前它们挤在同一屏——书架塞在阅读页的侧栏里，换一本书要先进入某本书，层级是反的；
 * 设置又与「阅读 / 问文档」平级，可它是全局的。现在书架是外层，阅读是内层，设置是
 * 盖在两者之上的覆盖层。
 *
 * 组件仍然只是 `ws.state` 的投影：**规则、顺序、落盘都不在这里**（ADR-0013）。
 * 这次重排一行应用层代码都没动，那正是当初抽 Workspace 的回报。
 */
export function App({
  ws,
  host,
  settings,
  conversation,
  progress,
}: {
  ws: Workspace;
  host: PdfHost;
  settings: Settings;
  conversation: Conversation;
  progress: Progress;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => ws.subscribe(listener), [ws]),
    () => ws.state,
  );
  const [reading, setReading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<"clips" | "chat">("clips");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [scale, setScale] = useState(1.5);
  /**
   * 捏合过程中的临时倍率。**手势中只做 CSS 缩放，松手才真的重渲染。**
   *
   * 触控板一次捏合会打出几十个事件，每个都重渲染 PDF 加重建文字层的话必然卡顿。
   * CSS 变换是白捡的：`at()` 与 `toPage()` 都按 `canvas.width / getBoundingClientRect().width`
   * 换算，被 CSS 缩放过照样对；文字层在同一个 `.frame` 里，一起缩放，也不会错位。
   */
  const [pinch, setPinch] = useState(1);
  /**
   * 这本书的目录，摘录按它归组。**三分之一的论文没有目录**（实测 ResNet 就没有），
   * 那时它是空数组，摘录栏退回按页排——那是正常路径，不是出错。
   */
  const [sections, setSections] = useState<Section[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  // 手势里要读当前 scale，但那个监听只挂一次，闭包会钉住旧值。同步进 ref 而不是
  // 在渲染期直接写（渲染期写 ref 会被 react-hooks/refs 拦下，理由也确实成立）。
  const scaleNow = useRef(scale);
  useEffect(() => {
    scaleNow.current = scale;
  }, [scale]);

  /**
   * 双指捏合缩放。
   *
   * **Electron 是 Chromium，触控板捏合到不了 touch 事件**——浏览器把它映射成
   * `ctrlKey` 为真的 wheel。必须 `preventDefault()`，否则 Chromium 会去缩放整个窗口，
   * 连右栏一起变大；而 React 的 `onWheel` 是 passive 的，`preventDefault` 会被忽略
   * 且只在 console 里警告，所以这里手动挂原生监听。
   */
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let factor = 1;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return; // 普通滚动照旧翻页面
      event.preventDefault();
      const clamped = Math.min(4, Math.max(0.5, scaleNow.current * factor * Math.exp(-event.deltaY / 120)));
      factor = clamped / scaleNow.current;
      setPinch(factor);

      clearTimeout(settle);
      settle = setTimeout(() => {
        // 松手了才落成真的 scale：这一下才重渲染 PDF。
        setScale(Number((scaleNow.current * factor).toFixed(2)));
        factor = 1;
        setPinch(1);
      }, 140);
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      clearTimeout(settle);
    };
  }, []);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  // 换书回到第一页：页码是上一本的位置，留着会打开一个可能不存在的页。渲染期比较
  // 而不是写 effect——effect 里同步 setState 会触发级联渲染。
  const [openedDoc, setOpenedDoc] = useState(state.docId);
  if (openedDoc !== state.docId) {
    setOpenedDoc(state.docId);
    setPage(1);
    setSelected(null);
    setMenuAt(null);
    setError(null);
    // 上一本的目录留着的话，摘录会挂在另一本书的小节标题下面，而且不报错。
    setSections([]);
  }

  // 取目录。放 effect 里而不是跟着 openDoc 走：书也可能是导入时自动打开的，
  // 两条入口各写一份迟早漏一条。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const document = host.document;
      if (!document || state.docId === null) return;
      const outline = await readOutline(document);
      if (!cancelled) setSections(outline);
    })();
    return () => {
      cancelled = true;
    };
  }, [host, state.docId]);

  const openDoc = async (id: string) => {
    await ws.openDoc(id);
    setReading(true);
  };

  const doc = state.docs.find((candidate) => candidate.id === state.docId);
  const clip = state.clips.find((candidate) => candidate.id === selected) ?? null;

  return (
    <>
      {!reading || state.docId === null ? (
        <ShelfPage ws={ws} state={state} onOpen={openDoc} onSettings={() => setShowSettings(true)} />
      ) : (
        <div className="reader">
          <div className="topbar">
            <button className="btn" onClick={() => setReading(false)}>
              ← 书架
            </button>
            <div className="title grow">{doc?.title ?? ""}</div>

            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={() => setPage((n) => Math.max(1, n - 1))}>
                ←
              </button>
              <span className="faint" style={{ minWidth: "5.5em", textAlign: "center" }}>
                {page} / {pages}
              </span>
              <button className="btn" onClick={() => setPage((n) => Math.min(pages, n + 1))}>
                →
              </button>
              <button
                className="btn"
                title="缩小"
                onClick={() => setScale((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              >
                −
              </button>
              <span className="faint" style={{ minWidth: "3em", textAlign: "center" }}>
                {Math.round(scale * 100)}%
              </span>
              <button
                className="btn"
                title="放大"
                onClick={() => setScale((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
              >
                +
              </button>
            </div>

            <button className="btn" onClick={() => setShowSettings(true)}>
              设置
            </button>
          </div>

          <div className="panes">
            <div className="stage" ref={stage}>
              <Reader
                ws={ws}
                host={host}
                state={state}
                selected={selected}
                page={page}
                onPages={setPages}
                scale={scale}
                pinch={pinch}
                onSelect={(id, at) => {
                  setSelected(id);
                  setMenuAt(at ?? null);
                  if (id !== null) {
                    // 划完就展开摘录那栏：读者的下一个动作是看译文，不该还要自己切。
                    setPane("clips");
                    // 看过一次就重新计时（ADR-0012）。代价是读操作也要写盘。
                    void ws.viewClip(id);
                  }
                }}
                onCapturing={setBusy}
                onError={setError}
              >
                {/* 松手就浮出来，翻译同时已经在跑——菜单不能挡在日常主路径上
                    （ADR-0016）。 */}
                {clip !== null && menuAt !== null && (
                  <SelectionMenu
                    ws={ws}
                    clip={clip}
                    tags={state.tags}
                    at={menuAt}
                    onClose={() => setMenuAt(null)}
                    onAsk={() => {
                      conversation.attachClip({
                        clipId: clip.id,
                        // 纯图没有原文，就把图像描述当材料；两个都没有才退回空串。
                        sourceText: clip.sourceText ?? clip.content?.multimodal ?? "",
                        translation: clip.translation ?? undefined,
                        image: clip.content?.screenshot,
                        page: clip.region.page,
                        note: clip.note ?? undefined,
                      });
                      setMenuAt(null);
                      setPane("chat");
                    }}
                  />
                )}
              </Reader>
            </div>

            <div className="side">
              <div className="seg">
                <button className={pane === "clips" ? "on" : undefined} onClick={() => setPane("clips")}>
                  摘录 {state.clips.length > 0 && `· ${state.clips.length}`}
                </button>
                <button className={pane === "chat" ? "on" : undefined} onClick={() => setPane("chat")}>
                  问文档
                </button>
              </div>

              {pane === "clips" ? (
                <>
                  {(busy !== null || error !== null) && (
                    <div style={{ padding: "12px 14px 0" }}>
                      {busy !== null && (
                        <p className="muted">{busy === "translating" ? "翻译中…" : "识别中…"}</p>
                      )}
                      {error !== null && <pre className="err">{error}</pre>}
                    </div>
                  )}
                  <ClipsPane
                    ws={ws}
                    tags={state.tags}
                    sections={sections}
                    clips={state.clips}
                    selected={clip?.id ?? null}
                    onSelect={setSelected}
                    onJump={setPage}
                  />
                </>
              ) : (
                // 引用点了就跳到那一页——PDF 一直在左边，所以核对原文不用离开对话。
                <ChatPanel conversation={conversation} progress={progress} onJump={setPage} />
              )}
            </div>
          </div>
        </div>
      )}

      <SettingsSheet open={showSettings} onClose={() => setShowSettings(false)}>
        <RetentionNotice settings={settings} />
        <SettingsPanel settings={settings} ws={ws} />
      </SettingsSheet>
    </>
  );
}

/**
 * 设置用原生 `<dialog>`，不是自己搭的遮罩层。
 *
 * Esc 关闭、焦点陷阱、背景遮罩、点外面关掉——全是浏览器白送的，自己搭要一条条补，
 * 而且多半会漏掉键盘那一半（lint 就是这么抓到的）。
 */
function SettingsSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className="sheet" onClose={onClose}>
      <header>
        <h2 className="grow">设置</h2>
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </header>
      {children}
    </dialog>
  );
}

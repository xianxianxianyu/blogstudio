import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Workspace } from "../../src/app/workspace";
import type { Settings } from "../../src/app/settings";
import type { Conversation } from "../../src/app/conversation";
import type { Progress } from "../../src/app/progress";
import type { PdfHost } from "./pdf-host";
import { ShelfPage } from "./ShelfPage";
import { Reader, type Busy } from "./Reader";
import { ClipsPane } from "./ClipsPane";
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
  }

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
            <div className="stage">
              <Reader
                ws={ws}
                host={host}
                state={state}
                selected={selected}
                page={page}
                onPages={setPages}
                scale={scale}
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

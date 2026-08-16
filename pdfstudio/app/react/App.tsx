import { useCallback, useState, useSyncExternalStore } from "react";
import type { Workspace } from "../../src/app/workspace";
import type { Settings } from "../../src/app/settings";
import type { Conversation } from "../../src/app/conversation";
import type { PdfHost } from "./pdf-host";
import { Shelf } from "./Shelf";
import { Reader } from "./Reader";
import { ClipPanel } from "./ClipPanel";
import { SettingsPanel } from "./SettingsPanel";
import { ChatPanel } from "./ChatPanel";

/**
 * 组件基本上是 `ws.state` 的投影加几个回调。**规则、顺序、落盘都不在这里**
 * ——那些归 Workspace，有测试钉着（ADR-0013）。这一层错了顶多是画得不对，
 * 不会让磁盘上的东西不一致。
 */
export function App({
  ws,
  host,
  settings,
  conversation,
}: {
  ws: Workspace;
  host: PdfHost;
  settings: Settings;
  conversation: Conversation;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => ws.subscribe(listener), [ws]),
    () => ws.state,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"read" | "chat" | "settings">("read");
  const [page, setPage] = useState(1);

  // 换书回到第一页：页码是上一本的位置，留着会打开一个可能不存在的页。渲染期比较
  // 而不是写 effect——effect 里同步 setState 会触发级联渲染。
  const [openedDoc, setOpenedDoc] = useState(state.docId);
  if (openedDoc !== state.docId) {
    setOpenedDoc(state.docId);
    setPage(1);
  }

  const openDoc = async (id: string) => {
    await ws.openDoc(id);
    setSelected(null);
    setError(null);
  };

  const clip = state.clips.find((candidate) => candidate.id === selected) ?? null;

  return (
    <div className="layout">
      <div className="stage">
        <Reader
          ws={ws}
          host={host}
          state={state}
          selected={selected}
          page={page}
          onPage={setPage}
          onSelect={(id) => {
            setSelected(id);
            // 看过一次就重新计时（ADR-0012）。代价是读操作也要写盘。
            if (id !== null) void ws.viewClip(id);
          }}
          onCapturing={setBusy}
          onError={setError}
        />
      </div>

      <div className="side">
        <div className="tabs">
          <button className={tab === "read" ? "on" : undefined} onClick={() => setTab("read")}>
            阅读
          </button>
          <button className={tab === "chat" ? "on" : undefined} onClick={() => setTab("chat")}>
            问文档
          </button>
          <button
            className={tab === "settings" ? "on" : undefined}
            onClick={() => setTab("settings")}
          >
            设置
          </button>
        </div>

        {tab === "settings" ? (
          <SettingsPanel settings={settings} />
        ) : tab === "chat" ? (
          // 引用点了就跳到那一页——出处不可点的话，「依据是检索到的原文」这句话
          // 读者没法自己核实，只能选择信或不信。
          <ChatPanel conversation={conversation} onJump={setPage} />
        ) : (
          <>
            <Shelf ws={ws} state={state} onOpen={openDoc} />

            <p className="empty">
              {state.docId === null
                ? "书架是空的，选一个 PDF 导入。"
                : "在左边拖一个框新建摘录；点一下已有标签打开它。"}
            </p>

            {busy && <p>识别中…</p>}
            {error !== null && <pre className="err">{error}</pre>}

            {clip !== null && (
              <ClipPanel ws={ws} clip={clip} onRemoved={() => setSelected(null)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

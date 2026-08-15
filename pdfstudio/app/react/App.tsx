import { useCallback, useState, useSyncExternalStore } from "react";
import type { Workspace } from "../../src/app/workspace";
import type { PdfHost } from "./pdf-host";
import { Shelf } from "./Shelf";
import { Reader } from "./Reader";
import { ClipPanel } from "./ClipPanel";

/**
 * 组件基本上是 `ws.state` 的投影加几个回调。**规则、顺序、落盘都不在这里**
 * ——那些归 Workspace，有测试钉着（ADR-0013）。这一层错了顶多是画得不对，
 * 不会让磁盘上的东西不一致。
 */
export function App({ ws, host }: { ws: Workspace; host: PdfHost }) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => ws.subscribe(listener), [ws]),
    () => ws.state,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <Shelf ws={ws} state={state} onOpen={openDoc} />

        <p className="empty">
          {state.docId === null
            ? "书架是空的，选一个 PDF 导入。"
            : "在左边拖一个框新建摘录；点一下已有标签打开它。"}
        </p>

        {busy && <p>识别中…</p>}
        {error !== null && <pre className="err">{error}</pre>}

        {clip !== null && (
          <ClipPanel
            ws={ws}
            clip={clip}
            onRemoved={() => {
              setSelected(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

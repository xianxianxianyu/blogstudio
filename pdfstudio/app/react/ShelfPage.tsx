import { useRef, useState } from "react";
import type { Workspace, WorkspaceState } from "../../src/app/workspace";

/**
 * 书架页——外层。
 *
 * 此前书架塞在阅读页的侧栏里，于是换一本书要先进入某本书：层级是反的。分成两层之后
 * 「有哪些书」和「读这一本」各占一屏，谁也不挤谁。
 */
export function ShelfPage({
  ws,
  state,
  onOpen,
  onSettings,
}: {
  ws: Workspace;
  state: WorkspaceState;
  onOpen: (docId: string) => Promise<void>;
  onSettings: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  async function take(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      // 同一篇论文再导入一次会拿回同一个 id（内容哈希），已有摘录原样接上，
      // 而不是变成一本空白的新书。
      const doc = await ws.importDoc({
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (input.current) input.current.value = "";
      await onOpen(doc.id);
    } finally {
      setBusy(false);
    }
  }

  async function remove(docId: string, title: string) {
    // 删一本书连它的全部摘录一起删——它们就住在同一个文件夹里（ADR-0011 的形状）。
    if (!window.confirm(`删掉《${title}》？它的全部摘录会一起没有，且不可撤销。`)) return;
    await ws.removeDoc(docId);
  }

  return (
    <div className="shelf-page">
      <header>
        <h1 className="grow">书架</h1>
        <button className="btn" onClick={onSettings}>
          设置
        </button>
      </header>

      <div className="books">
        {state.docs.map((doc) => (
          <div key={doc.id} style={{ position: "relative" }}>
            <button className="book" onClick={() => void onOpen(doc.id)}>
              <span className="spine" />
              <span className="grow">
                <div className="title">{doc.title}</div>
                <div className="meta">{doc.filename}</div>
              </span>
            </button>
            <button
              className="btn"
              style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)" }}
              onClick={(event) => {
                event.stopPropagation();
                void remove(doc.id, doc.title);
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <div
        className={over ? "dropzone over" : "dropzone"}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void take(event.dataTransfer.files[0]);
        }}
      >
        {busy ? (
          "正在导入…"
        ) : (
          <>
            把 PDF 拖到这里，或{" "}
            <button className="btn" onClick={() => input.current?.click()}>
              选择文件
            </button>
            <input
              ref={input}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={(event) => void take(event.target.files?.[0])}
            />
            <div className="faint" style={{ marginTop: 8 }}>
              同一篇论文再导入一次不会重复——按内容识别，改了文件名也认得出。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

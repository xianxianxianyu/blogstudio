import { useRef } from "react";
import type { Workspace, WorkspaceState } from "../../src/app/workspace";

export function Shelf({
  ws,
  state,
  onOpen,
}: {
  ws: Workspace;
  state: WorkspaceState;
  onOpen: (docId: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);

  async function importFile(file: File) {
    // 同一篇论文再导入一次会拿回同一个 id（内容哈希），已有摘录原样接上，
    // 而不是变成一本空白的新书。
    const doc = await ws.importDoc({
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (input.current) input.current.value = "";
    await onOpen(doc.id);
  }

  async function remove(docId: string, title: string) {
    // 删一本书连它的全部摘录一起删——它们就住在同一个文件夹里（ADR-0011 的形状）。
    // 这比删一条摘录重得多，所以把后果说清楚。
    if (!window.confirm(`删掉《${title}》？它的全部摘录会一起没有，且不可撤销。`)) return;
    await ws.removeDoc(docId);
  }

  return (
    <>
      <p>
        <b>书架</b>{" "}
        <input
          ref={input}
          type="file"
          accept="application/pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </p>

      <ul className="shelf">
        {state.docs.map((doc) => (
          <li key={doc.id} className={doc.id === state.docId ? "on" : undefined}>
            <button className="open" title={doc.filename} onClick={() => void onOpen(doc.id)}>
              {doc.title}
            </button>
            <button className="btn" onClick={() => void remove(doc.id, doc.title)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

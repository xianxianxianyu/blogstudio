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
  onOpenUrl,
}: {
  ws: Workspace;
  state: WorkspaceState;
  onOpen: (docId: string) => Promise<void>;
  /**
   * 打开一个网页。
   *
   * **这个入口暂时放在书架上，而它并不属于这里**——网页不是书（ADR-0006 的代价 1）。
   * 等「网页阅读该放哪」定下来就搬走；现在放这儿是为了先把通路打通，
   * 而不是为了它属于这儿。
   */
  onOpenUrl: (url: string) => void;
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
      {/* 「Context Studio」和「设置」都搬去外壳的左栏了：它们是全局的，
          不是书架这一页的东西（ADR-0003）。 */}
      <header>
        <h1 className="grow">书架</h1>
      </header>

      {/* 暂居于此，见 `onOpenUrl` 的注释。 */}
      <form
        className="row"
        style={{ marginBottom: 18 }}
        onSubmit={(event) => {
          event.preventDefault();
          const url = new FormData(event.currentTarget).get("url");
          if (typeof url === "string" && url.trim() !== "") onOpenUrl(url.trim());
          event.currentTarget.reset();
        }}
      >
        <input
          name="url"
          className="grow"
          placeholder="打开一个网页（https://…）"
          style={{ font: "inherit", padding: "7px 11px", border: "1px solid var(--line)", borderRadius: 8 }}
        />
        <button className="btn" type="submit">
          打开
        </button>
      </form>

      <div className="books">
        {state.docs.map((doc) => (
          <div key={doc.id} className="book">
            {/* 整张卡片是「打开」，删除是卡片内的另一个按钮——此前删除是绝对定位盖在
                卡片上的，按钮嵌按钮既不合法也容易点错。 */}
            <button className="open grow" onClick={() => void onOpen(doc.id)}>
              <span className="spine" />
              <span className="grow">
                <span className="title">{doc.title}</span>
                <span className="meta">{doc.filename}</span>
              </span>
            </button>
            <button className="btn" onClick={() => void remove(doc.id, doc.title)}>
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

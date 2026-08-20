import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * 页面上右键弹出的菜单。
 *
 * 目前只有一项：**在这一页加书签**。它必须从页面上发起而不是从目录栏——站在这一页上，
 * 页码就是对的，不用猜、也不用事后翻回来核对。而这恰恰是之前那套「在目录里加一条、
 * 页码取邻居的、再自己去改」最别扭的地方。
 *
 * 选中的文字直接当标题：读者右键之前多半刚划过那行章节名。
 */
export function PageMenu({
  at,
  page,
  selection,
  onAddBookmark,
  onClose,
}: {
  /** 挂在哪，**视口坐标**（同 SelectionMenu）。 */
  at: { x: number; y: number };
  page: number;
  /** 右键时选中的文字，没有就是空串。 */
  selection: string;
  onAddBookmark: (title: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  // 点别处、按 Esc 都关掉。菜单赖着不走比没有菜单更烦。
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => void (event.key === "Escape" && onClose());
    // 下一拍再挂：右键这一次的事件本身还在冒泡，立刻挂会当场关掉自己。
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", away);
      window.addEventListener("keydown", key);
    });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return createPortal(
    <div ref={box} className="page-menu" style={{ left: at.x, top: at.y }}>
      <button
        onClick={() => {
          onAddBookmark(selection);
          onClose();
        }}
      >
        在第 {page} 页加书签
      </button>
      {selection !== "" && (
        // 划了字就先给它当标题，省一步打字。太长的截一下——章节名不会有 40 个字，
        // 而整段正文被误当标题会让目录那一行没法看。
        <p className="faint">名字用「{selection.slice(0, 24)}{selection.length > 24 ? "…" : ""}」</p>
      )}
      {selection === "" && <p className="faint">加完直接在右边给它起名</p>}
    </div>,
    window.document.body,
  );
}

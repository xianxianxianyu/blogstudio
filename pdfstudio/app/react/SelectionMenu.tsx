import { useEffect, useRef, useState } from "react";
import type { Clip } from "../../src/clip/clip";
import type { Workspace } from "../../src/app/workspace";

/**
 * 选区旁边浮出的小菜单（ADR-0016）。
 *
 * **翻译不在里面——松手就已经开始了。** 菜单不能挡在日常主路径上（「划一下、看懂、
 * 过」），所以主路径零点击，其余一点击。
 *
 * **也没有「只高亮」这一项**：文本摘录在页面上本来就画成高亮，什么都不做得到的就是
 * 高亮。多一个按钮只会让人以为存在两种不同的东西。
 */
export function SelectionMenu({
  ws,
  clip,
  at,
  onAsk,
  onClose,
}: {
  ws: Workspace;
  clip: Clip;
  /** 菜单挂在哪（CSS 像素，相对画布容器）。 */
  at: { x: number; y: number };
  onAsk: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(clip.note ?? "");
  const [saved, setSaved] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  // 划完直接打字就能写备注——不用先移到右栏、再点开那一栏。
  useEffect(() => {
    box.current?.focus();
  }, [clip.id]);

  function commit() {
    if (note === (clip.note ?? "")) return;
    void ws.editNote(clip.id, note).then((result) => setSaved(result.ok));
  }

  return (
    <div className="sel-menu" style={{ left: at.x, top: at.y }}>
      <input
        ref={box}
        className="grow"
        placeholder="写点什么…回车存下"
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          setSaved(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            onClose();
          }
          if (event.key === "Escape") onClose();
        }}
        onBlur={commit}
      />
      <button
        className="btn"
        title={clip.important ? "取消重要" : "标记为重要（不会被自动清理）"}
        onClick={() => void ws.markImportant(clip.id)}
      >
        {clip.important ? "★" : "☆"}
      </button>
      <button className="btn" title="把这段贴进对话去问" onClick={onAsk}>
        问这段
      </button>
      <button
        className="btn"
        title="删掉这条摘录"
        onClick={() => {
          if (!window.confirm("删掉这条摘录？截图和笔记会一起没有，且不可撤销。")) return;
          void ws.removeClip(clip.id).then(onClose);
        }}
      >
        删除
      </button>
      <button className="btn" onClick={onClose}>
        ✕
      </button>
      {saved && <span className="faint">已存</span>}
    </div>
  );
}

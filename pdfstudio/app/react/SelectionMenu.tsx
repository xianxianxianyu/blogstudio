import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Clip } from "../../src/clip/clip";
import type { Tag } from "../../src/tag/tag";
import { TagPalette } from "./TagPalette";
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
  tags,
  at,
  onAsk,
  onClose,
}: {
  ws: Workspace;
  clip: Clip;
  tags: Tag[];
  /** 菜单挂在哪，**视口坐标**（指针事件的 clientX/clientY）。 */
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

  /**
   * 夹进视口，并挂到 body 上。
   *
   * 此前它是画布容器里的绝对定位元素，而那个容器有 `overflow: auto`——**滚动容器会裁掉
   * 溢出的部分**，于是在页面右侧框选时菜单被右栏切掉一半。
   *
   * 用 ref 回调直接改 style 而不是 setState：位置要在测出真实宽高之后才知道，而在
   * effect 里 setState 会触发级联渲染（这条 lint 规则拦过一次）。定位是纯粹的
   * 命令式 DOM 调整，本来就不该经过一轮渲染。
   */
  const place = (node: HTMLDivElement | null) => {
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    node.style.left = `${Math.max(margin, Math.min(at.x, window.innerWidth - rect.width - margin))}px`;
    // 放不下就翻到选区上方：宁可挡住刚框的那块，也不能掉到屏幕外面。
    const below = at.y + rect.height + margin <= window.innerHeight;
    node.style.top = `${below ? at.y : Math.max(margin, at.y - rect.height - 12)}px`;
  };

  return createPortal(
    <div ref={place} className="sel-menu" style={{ left: at.x, top: at.y }}>
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
      <TagPalette tags={tags} value={clip.tagId} onPick={(tagId) => void ws.setTag(clip.id, tagId)} />
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
    </div>,
    document.body,
  );
}

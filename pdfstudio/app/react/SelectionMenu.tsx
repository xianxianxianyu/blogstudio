import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Streamdown } from "streamdown";
import type { Clip } from "../../src/clip/clip";
import type { Tag } from "../../src/tag/tag";
import { TagPalette } from "./TagPalette";
import { placeMenu } from "../../src/app/menu-place";
import type { Workspace } from "../../src/app/workspace";

/**
 * 选区旁边浮出的工具条（ADR-0016 决策 2、ADR-0019）。
 *
 * **两级。** 第一级只有四个去处，一个模型都不调——ADR-0019 推翻了「松手即翻译」：
 * 在中文扫描书上每一框都是二十秒起的视觉调用，而产出多半用不上。
 * 第二级是笔记面板：标记调色盘摊开、备注框够大、边写边渲染。
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
  /**
   * 选区在**视口坐标**里的位置，以及（可选的）大小——工具条要绕开它。
   *
   * 宽高可选是为了让调用方分两步接上：给了就绕开整个选区，没给就退化成「贴在这一点
   * 下面」，也就是接线之前的老行为。**退化路径必须是能用的**，否则这个组件在接线
   * 完成之前是坏的，而坏的中间态会被别人顺手「修」掉。
   */
  at: { x: number; y: number; width?: number; height?: number };
  onAsk: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"actions" | "note">("actions");
  const [note, setNote] = useState(clip.note ?? "");
  const [copied, setCopied] = useState(false);
  const [reading, setReading] = useState(false);
  /**
   * 还没认过。**只有这时才画「认一下」**——认过的摘录再画一个按钮，读者会以为
   * 存在两种不同的识别。
   */
  const raw = clip.content === null;
  const box = useRef<HTMLTextAreaElement>(null);

  // 进笔记面板就把光标放好——点「做笔记」的下一个动作必然是打字。
  useEffect(() => {
    if (stage === "note") box.current?.focus();
  }, [stage]);

  function commit() {
    if (note === (clip.note ?? "")) return;
    void ws.editNote(clip.id, note);
  }

  async function copyShot() {
    const shot = clip.content?.screenshot ?? clip.region.pixels;
    if (!shot) return;
    // 写 PNG 到剪贴板要 `ClipboardItem`，写不了就静默失败——没有权限时弹一个
    // 「复制失败」除了让人不知所措没有别的用。
    try {
      const blob = new Blob([shot.bytes as BlobPart], { type: shot.mime });
      await navigator.clipboard.write([new ClipboardItem({ [shot.mime]: blob })]);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  /**
   * 摆到选区旁边的空位，并挂到 body 上。
   *
   * 此前它是画布容器里的绝对定位元素，而那个容器有 `overflow: auto`——**滚动容器会裁掉
   * 溢出的部分**，于是在页面右侧框选时菜单被右栏切掉一半。
   *
   * 用 ref 回调直接改 style 而不是 setState：位置要在测出真实宽高之后才知道，而在
   * effect 里 setState 会触发级联渲染（这条 lint 规则拦过一次）。定位是纯粹的
   * 命令式 DOM 调整，本来就不该经过一轮渲染。规则本身在 `menu-place.ts`，有测试。
   */
  const place = (node: HTMLDivElement | null) => {
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const spot = placeMenu(
      { x: at.x, y: at.y, width: at.width ?? 0, height: at.height ?? 0 },
      rect,
      { width: window.innerWidth, height: window.innerHeight },
    );
    node.style.left = `${spot.x}px`;
    node.style.top = `${spot.y}px`;
  };

  return createPortal(
    <div ref={place} className={`sel-menu${stage === "note" ? " wide" : ""}`}>
      {stage === "actions" ? (
        <>
          {raw && (
            // 松手不再自动认（ADR-0019）。要原文和译文的时候，在这儿要。
            <button
              className="act"
              disabled={reading}
              onClick={() => {
                setReading(true);
                void ws.recognizeClip(clip.id).finally(() => setReading(false));
              }}
            >
              {reading ? "认着…" : "认一下"}
            </button>
          )}
          <button className="act" onClick={() => void copyShot()}>
            {copied ? "已复制" : "复制截图"}
          </button>
          <button className="act" disabled title="下一步做" onClick={() => undefined}>
            导入 context
          </button>
          <button className="act" onClick={() => setStage("note")}>
            做笔记
          </button>
          <button className="act" onClick={onAsk}>
            问这段
          </button>
          <span className="sep" />
          <button
            className="act quiet"
            title="删掉这条摘录"
            onClick={() => {
              if (!window.confirm("删掉这条摘录？截图和笔记会一起没有，且不可撤销。")) return;
              void ws.removeClip(clip.id).then(onClose);
            }}
          >
            删除
          </button>
          <button className="act quiet" onClick={onClose}>
            ✕
          </button>
        </>
      ) : (
        <div className="note-panel">
          {/* 调色盘摊开，不再折在一个小点后面——标记是「这是什么」，进了笔记面板
              就说明读者正在整理，那正是最该一眼看全五个选项的时刻。 */}
          <div className="row">
            <TagPalette tags={tags} value={clip.tagId} onPick={(tagId) => void ws.setTag(clip.id, tagId)} />
            <span className="grow" />
            <button
              className="act quiet"
              title={clip.important ? "取消重要" : "标记为重要（不会被自动清理）"}
              onClick={() => void ws.markImportant(clip.id)}
            >
              {clip.important ? "★ 重要" : "☆ 重要"}
            </button>
          </div>

          <textarea
            ref={box}
            className="note-input"
            placeholder="写点什么。支持 Markdown 和 $公式$，下面实时渲染。"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              // 回车换行——这是个能写几段的框了，不再是「回车即存」的单行输入。
              // 存盘交给失焦和「完成」。
              if (event.key === "Escape") {
                commit();
                onClose();
              }
            }}
            onBlur={commit}
          />

          {/* 所见即所得：写的是 Markdown，下面就是它渲染出来的样子。空的时候不占地方。 */}
          {note.trim() !== "" && (
            <div className="note-preview">
              <Streamdown>{note}</Streamdown>
            </div>
          )}

          <div className="row">
            <button className="act quiet" onClick={() => setStage("actions")}>
              ← 返回
            </button>
            <span className="grow" />
            <button
              className="act"
              onClick={() => {
                commit();
                onClose();
              }}
            >
              完成
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

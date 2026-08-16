import type { Clip } from "../../src/clip/clip";
import type { Workspace } from "../../src/app/workspace";
import { ClipPanel } from "./ClipPanel";

/**
 * 摘录这一栏：**列表在上，详情在下**。
 *
 * 此前只能点页面上的标签一条条看——于是「这本书我都划过什么」根本看不到，而那恰恰是
 * 三个月后重开一篇论文时最想知道的事。列表按页排序，点一条同时跳页并展开详情。
 */
export function ClipsPane({
  ws,
  clips,
  selected,
  onSelect,
  onJump,
}: {
  ws: Workspace;
  clips: Clip[];
  selected: string | null;
  onSelect: (clipId: string | null) => void;
  onJump: (page: number) => void;
}) {
  const ordered = [...clips].sort((a, b) => a.region.page - b.region.page);
  const current = clips.find((clip) => clip.id === selected) ?? null;

  if (ordered.length === 0) {
    return (
      <div className="pane">
        <p className="muted">在左边拖一个框，就有了第一条摘录。</p>
        <p className="faint">
          文字区直接取原文，公式和图交给模型认。点一下已有的标签可以再打开它。
        </p>
      </div>
    );
  }

  return (
    <div className="pane">
      {ordered.map((clip) => (
        <button
          key={clip.id}
          className={[
            "clip-row",
            clip.important ? "keep" : "",
            clip.id === selected ? "on" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            onSelect(clip.id);
            onJump(clip.region.page);
          }}
        >
          <div className="faint">
            第 {clip.region.page} 页
            {clip.important && " · ★"}
            {clip.note !== null && " · 有笔记"}
            {/* 墓碑：内容到期被清了，锚点还在（ADR-0012）。要说出来，否则读者
                只会觉得「这条怎么空了」。 */}
            {clip.content === null && clip.state === "ready" && " · 内容已过期"}
          </div>
          <div className="snippet">
            {clip.translation ?? clip.sourceText ?? clip.content?.multimodal ?? "（纯图）"}
          </div>
        </button>
      ))}

      {current !== null && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <ClipPanel ws={ws} clip={current} onRemoved={() => onSelect(null)} />
        </div>
      )}
    </div>
  );
}

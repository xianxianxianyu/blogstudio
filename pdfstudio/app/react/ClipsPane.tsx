import { useState } from "react";
import type { Clip } from "../../src/clip/clip";
import type { Workspace } from "../../src/app/workspace";
import { TAG_COLORS, type Tag, type TagColor } from "../../src/tag/tag";
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
  tags,
  selected,
  onSelect,
  onJump,
}: {
  ws: Workspace;
  clips: Clip[];
  tags: Tag[];
  selected: string | null;
  onSelect: (clipId: string | null) => void;
  onJump: (page: number) => void;
}) {
  // 筛选是视图状态，不落盘：它是「此刻在找什么」，不是这本书的属性。
  const [only, setOnly] = useState<TagColor | null>(null);

  const inScope = only === null ? clips : clips.filter((clip) => clip.tagId === only);
  const ordered = [...inScope].sort((a, b) => a.region.page - b.region.page);
  const current = clips.find((clip) => clip.id === selected) ?? null;

  // 选中一条就整栏切到详情，和「书架 → 阅读」是同一个模式。此前详情接在列表下方，
  // 点列表末尾那条还得再往下滚才看得见——摘录一多就很烦。
  if (current !== null) {
    return (
      <div className="pane">
        <button className="btn" style={{ marginBottom: 10 }} onClick={() => onSelect(null)}>
          ← 全部摘录（{ordered.length}）
        </button>
        <ClipPanel ws={ws} clip={current} tags={tags} onRemoved={() => onSelect(null)} />
      </div>
    );
  }

  if (clips.length === 0) {
    return (
      <div className="pane">
        <p className="muted">在左边拖一个框，就有了第一条摘录。</p>
        <p className="faint">
          文字区直接取原文，公式和图交给模型认。点一下已有的标签可以再打开它。
        </p>
      </div>
    );
  }

  /**
   * 一排颜色点，点一个只看那一类，再点取消。
   *
   * 「这本书我都划过什么」是三个月后重开论文最想知道的事，分类之后「我标了存疑的
   * 那些呢」是同一个问题的下一层。**只画有摘录的那几色**——五个点里三个是空的，
   * 点下去一片空白，看着像坏了。
   */
  const used = TAG_COLORS.filter((id) => clips.some((clip) => clip.tagId === id));

  return (
    <div className="pane">
      {used.length > 0 && (
        <div className="row filter">
          {used.map((id) => (
            <button
              key={id}
              className={`swatch${id === only ? " on" : ""}`}
              data-tag={id}
              title={tags.find((tag) => tag.id === id)?.name ?? id}
              onClick={() => setOnly(id === only ? null : id)}
            />
          ))}
          <span className="faint">
            {only === null
              ? `全部 ${clips.length} 条`
              : `${tags.find((tag) => tag.id === only)?.name ?? ""} ${ordered.length} 条`}
          </span>
        </div>
      )}

      {ordered.length === 0 && <p className="faint">这一类还没有摘录。</p>}

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
            {clip.tagId !== null && <span className="swatch dot" data-tag={clip.tagId} />}
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
    </div>
  );
}

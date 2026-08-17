import { useEffect, useRef, useState } from "react";
import { clipTitle, type Clip } from "../../src/clip/clip";
import type { Result, Workspace } from "../../src/app/workspace";
import type { Tag } from "../../src/tag/tag";
import { TagPalette } from "./TagPalette";

/**
 * 一条摘录的详情。
 *
 * **译文排在原文前面**：日常路径是「划一下、看懂、过」，中文读者读英文论文时，
 * 先要看的是译文。原文是核对用的，排在后面。
 *
 * **默认是文本，不是输入框。** 读是主、改是偶尔（修个 OCR 错字、补句笔记），
 * 三个永远敞开的文本域会让这一栏看起来像张表单，而它其实是给人读的。
 */
export function ClipPanel({
  ws,
  clip,
  tags,
  onRemoved,
}: {
  ws: Workspace;
  clip: Clip;
  tags: Tag[];
  onRemoved: () => void;
}) {
  const [denied, setDenied] = useState<string | null>(null);

  /** 拒绝的理由要给读者看见，不能默默什么都没发生。规则本身归 Workspace。 */
  function apply(intent: () => Promise<Result>) {
    void intent().then((result) => setDenied(result.ok ? null : (result.reason ?? "操作失败")));
  }

  async function remove() {
    // 删除不可逆，且删的是整个文件夹（截图和笔记一起没）——ADR-0012 把自动回收的
    // 破坏性记成了代价，手动删同样要拦一道。
    if (!window.confirm("删掉这条摘录？截图和笔记会一起没有，且不可撤销。")) return;
    const result = await ws.removeClip(clip.id);
    if (result.ok) onRemoved();
    else setDenied(result.reason ?? "删除失败");
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="faint grow">
          第 {clip.region.page} 页 · {clip.content?.route === "text" ? "文本层" : "视觉识别"}
        </span>
        <TagPalette tags={tags} value={clip.tagId} onPick={(tagId) => apply(() => ws.setTag(clip.id, tagId))} />
        <button className="btn" onClick={() => apply(() => ws.markImportant(clip.id))}>
          {clip.important ? "★ 重要" : "☆ 标记重要"}
        </button>
        <button className="btn" onClick={() => void remove()}>
          删除
        </button>
      </div>

      {/* 目录里显示的那一行。默认是从内容推导的，所以这里是 placeholder 而不是值——
          填了才算读者定的，清空就退回推导。 */}
      <input
        className="title-input"
        key={clip.id}
        defaultValue={clip.title ?? ""}
        placeholder={clipTitle(clip)}
        title="目录里显示的标题；留空就按内容自动取"
        onBlur={(event) => {
          if (event.target.value !== (clip.title ?? "")) {
            apply(() => ws.setTitle(clip.id, event.target.value));
          }
        }}
      />

      {denied !== null && <p className="err">{denied}</p>}

      {/* 墓碑：内容到期被清了，锚点还在（ADR-0012）。说清楚它还能捡回来，
          否则读者会以为数据丢了。 */}
      {clip.content === null && clip.state === "ready" && (
        <p className="muted">
          内容已过期清理，位置标记还在。重新框一次同一块地方就能再认一遍。
        </p>
      )}

      <Field
        label="译文"
        value={clip.translation}
        placeholder="（这一档没有产出译文）"
        onCommit={(text) => apply(() => ws.editTranslation(clip.id, text))}
      />

      {/* 原文只准修错字，不得改写措辞——守卫按编辑距离判（≤ 2）。被拒时理由原样显示，
          因为那句话本身就是规则。 */}
      <Field
        label="原文"
        value={clip.sourceText}
        placeholder="（纯图，没有原文）"
        mono
        onCommit={(text) => apply(() => ws.fixSource(clip.id, text))}
      />

      {clip.content?.multimodal && <Field label="图像描述" value={clip.content.multimodal} readOnly />}

      {/* 笔记是读者自己写的，删了就永远没了——写过笔记的摘录回收器不会碰（ADR-0012）。 */}
      <Field
        label="笔记"
        value={clip.note}
        placeholder="写点什么…（写过笔记的摘录不会被自动清理）"
        onCommit={(text) => apply(() => ws.editNote(clip.id, text))}
      />
    </div>
  );
}

/**
 * 一栏内容：平时是文本，点一下才变成输入框。
 *
 * 失焦才提交——每敲一个字就写一次盘，既吵又会把原文那条编辑距离守卫逐字符地卡住
 * （改到第三个字符就超过 2 了）。
 */
function Field({
  label,
  value,
  placeholder,
  mono,
  readOnly,
  onCommit,
}: {
  label: string;
  value: string | null;
  placeholder?: string;
  mono?: boolean;
  readOnly?: boolean;
  onCommit?: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const box = useRef<HTMLTextAreaElement>(null);

  // 点了就把焦点送过去。不用 autoFocus：那条 lint 规则防的是页面加载时抢焦点，
  // 而这里是读者主动点击的结果——用 ref 表达同样的行为，意图也更明确。
  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);

  // 换了一条摘录（或它被外部改过）时把草稿同步过来。
  const [origin, setOrigin] = useState(value);
  if (value !== origin) {
    setOrigin(value);
    setDraft(value ?? "");
    setEditing(false);
  }

  return (
    <>
      <h3 className="section">{label}</h3>
      {editing && onCommit ? (
        <textarea
          ref={box}
          rows={Math.min(10, Math.max(3, Math.ceil(draft.length / 40)))}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== (value ?? "")) onCommit(draft);
          }}
        />
      ) : (
        <div
          className={value === null ? "muted" : undefined}
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: mono ? "ui-monospace, SFMono-Regular, monospace" : undefined,
            fontSize: mono ? 13 : undefined,
            cursor: readOnly ? "default" : "text",
            padding: "2px 0",
          }}
          role={readOnly ? undefined : "button"}
          tabIndex={readOnly ? undefined : 0}
          onClick={() => !readOnly && onCommit && setEditing(true)}
          onKeyDown={(event) => {
            if (!readOnly && onCommit && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              setEditing(true);
            }
          }}
        >
          {value ?? placeholder ?? "—"}
        </div>
      )}
    </>
  );
}

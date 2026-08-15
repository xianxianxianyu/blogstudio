import { useState } from "react";
import type { Clip } from "../../src/clip/clip";
import type { Result, Workspace } from "../../src/app/workspace";

export function ClipPanel({
  ws,
  clip,
  onRemoved,
}: {
  ws: Workspace;
  clip: Clip;
  onRemoved: () => void;
}) {
  const [denied, setDenied] = useState<string | null>(null);

  /**
   * 拒绝的理由要给读者看见，不能默默什么都没发生——那样读者只会以为是保存失败。
   * 规则本身归 Workspace，这里只负责把它说出来。
   */
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
      <div className="row">
        <button className="btn" onClick={() => apply(() => ws.markImportant(clip.id))}>
          {clip.important ? "★ 重要（点击取消）" : "☆ 标记为重要"}
        </button>
        <button className="btn" onClick={() => void remove()}>
          删除
        </button>
      </div>

      {denied !== null && <p className="err">{denied}</p>}

      <h3>
        原文（第 {clip.region.page} 页 · {clip.content?.route ?? "?"}）
      </h3>
      {/* 原文只准修错字，不得改写措辞——守卫按编辑距离判（≤ 2）。被拒时理由原样显示，
          因为那句话本身就是规则。 */}
      <Editor value={clip.sourceText ?? ""} onCommit={(text) => apply(() => ws.fixSource(clip.id, text))} />

      <h3>译文</h3>
      <Editor
        value={clip.translation ?? ""}
        onCommit={(text) => apply(() => ws.editTranslation(clip.id, text))}
      />

      <h3>笔记</h3>
      {/* 笔记是读者自己写的，删了就永远没了——写过笔记的摘录回收器不会碰（ADR-0012）。 */}
      <Editor value={clip.note ?? ""} onCommit={(text) => apply(() => ws.editNote(clip.id, text))} />

      {clip.content?.multimodal && (
        <>
          <h3>图像描述</h3>
          <pre>{clip.content.multimodal}</pre>
        </>
      )}
    </div>
  );
}

/** 失焦才提交：每敲一个字就写一次盘，既吵又会把编辑距离守卫逐字符地卡住。 */
function Editor({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [origin, setOrigin] = useState(value);

  // 换了一条摘录（或它被外部改过）时把草稿同步过来。用 key 重挂也行，但那样会
  // 丢掉正在输入的内容，而读者常常是「点开另一条看一眼再回来」。
  if (value !== origin) {
    setOrigin(value);
    setDraft(value);
  }

  return (
    <textarea
      rows={4}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

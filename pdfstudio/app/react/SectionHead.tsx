import { useState } from "react";
import type { Section } from "../../src/clip/outline";

/**
 * 一行目录标题。**生成的目录逐条可改**——这才是这个功能的产品。
 *
 * 目录页解析在英文书上三项全对只有 57%（`docs/research-large-book-outline.md`），中文侧
 * 没有公开数据。近一半条目某处是错的，所以「改」不是逃生口，是主路径。
 *
 * PDF 自带的目录不给改：那是文件里的事实，改了也存不回去。只有生成的那份可改。
 */
export function SectionHead({
  section,
  editable,
  onJump,
  onChange,
  onRemove,
}: {
  section: Section;
  editable: boolean;
  onJump: () => void;
  onChange: (next: Section) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!editable) return <h4 className="section-head">{section.title}</h4>;

  if (!open) {
    return (
      <h4 className="section-head editable">
        <span className="grow">{section.title}</span>
        {/* 跳过去就是核对：页码对不对，翻过去一眼就知道，比在这儿盯着数字强。 */}
        <button className="ghost" title={`跳到第 ${section.page} 页核对`} onClick={onJump}>
          第 {section.page} 页
        </button>
        <button className="ghost" title="改这一条" onClick={() => setOpen(true)}>
          ✎
        </button>
      </h4>
    );
  }

  return (
    <div className="section-edit">
      <input
        className="grow"
        defaultValue={section.title}
        onBlur={(event) => onChange({ ...section, title: event.target.value.trim() || section.title })}
      />
      <input
        style={{ width: 62 }}
        defaultValue={section.page}
        title="物理页码"
        onBlur={(event) => {
          const page = Number(event.target.value);
          if (Number.isInteger(page) && page > 0) onChange({ ...section, page });
        }}
      />
      {/* 层级用升降级按钮，像大纲编辑器——比让人填一个数字自然。 */}
      <button
        className="ghost"
        title="升一级"
        disabled={section.level === 0}
        onClick={() => onChange({ ...section, level: section.level - 1, path: section.path.slice(0, -1) })}
      >
        ←
      </button>
      <button className="ghost" title="降一级" onClick={() => onChange({ ...section, level: section.level + 1 })}>
        →
      </button>
      <button className="ghost" title="删掉这一条" onClick={onRemove}>
        ✕
      </button>
      <button className="ghost" onClick={() => setOpen(false)}>
        完成
      </button>
    </div>
  );
}

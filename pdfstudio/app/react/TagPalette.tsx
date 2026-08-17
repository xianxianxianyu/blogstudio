import { useState } from "react";
import { TAG_COLORS, type Tag, type TagColor } from "../../src/tag/tag";

/**
 * 调色盘：**折叠**的，平时只露当前色。
 *
 * 浮动菜单里已经有备注输入框、☆、问这段、删除、✕ 五样，而且它是压在正文上的——横着
 * 再摆五个色块会把它撑宽，刚因为遮挡改过一次定位。所以点开才展开。
 *
 * 摘录面板里也用它，同一个组件：两处的操作是同一件事，做成两套迟早长歪。
 */
export function TagPalette({
  tags,
  value,
  onPick,
}: {
  tags: Tag[];
  value: TagColor | null;
  onPick: (tagId: TagColor | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const named = (id: TagColor) => tags.find((tag) => tag.id === id)?.name ?? id;

  if (!open) {
    return (
      <button
        className="swatch current"
        data-tag={value ?? "none"}
        title={value === null ? "选个分类" : `分类：${named(value)}`}
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <span className="palette">
      {TAG_COLORS.map((id) => (
        <button
          key={id}
          className={`swatch${id === value ? " on" : ""}`}
          data-tag={id}
          title={named(id)}
          onClick={() => {
            // 再点一次当前色 = 取消分类。省掉一个「无」按钮，也省掉一次解释。
            onPick(id === value ? null : id);
            setOpen(false);
          }}
        />
      ))}
    </span>
  );
}

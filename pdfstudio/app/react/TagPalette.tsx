import { TAG_COLORS, type Tag, type TagColor } from "../../src/tag/tag";

/**
 * 调色盘：五个色块，**一直摊开**。
 *
 * 它此前是折叠的——平时只露当前色，点一下才展开。那个折叠是为了当时那个「一条横的
 * 浮动菜单」让路：里面已经挤了备注框、☆、问这段、删除、✕ 五样，再摆五个色块会把它
 * 撑宽，而它是压在正文上的。
 *
 * **那个理由随 ADR-0019 一起没了**：工具条拆成两级之后，调色盘住在第二级的笔记面板里，
 * 那一栏的宽度本来就是给它的。而折叠的代价是实打实的——**选个颜色要点两下**，
 * 其中第一下什么也没做成。
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
  const named = (id: TagColor) => tags.find((tag) => tag.id === id)?.name ?? id;

  return (
    <span className="palette">
      {TAG_COLORS.map((id) => (
        <button
          key={id}
          className={`swatch${id === value ? " on" : ""}`}
          data-tag={id}
          title={named(id)}
          // 再点一次当前色 = 取消分类。省掉一个「无」按钮，也省掉一次解释。
          onClick={() => onPick(id === value ? null : id)}
        />
      ))}
    </span>
  );
}

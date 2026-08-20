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
  fold,
  clipCount,
  onJump,
  onChange,
  onRemove,
}: {
  section: Section;
  editable: boolean;
  /**
   * 折叠。`null` = 底下没东西可展开，**不画三角**——点了什么都不会发生的控件是骗人的。
   */
  fold: { expanded: boolean; onToggle: () => void } | null;
  /** 这一节**连同子孙**的摘录数。折起来时「第 12 章我划过吗」得还答得出。 */
  clipCount: number;
  onJump: () => void;
  onChange: (next: Section) => void;
  onRemove: () => void;
}) {
  /**
   * **空标题 = 还没成形**，直接进编辑态。
   *
   * 新加的条目不给占位标题（比如「新条目」）：读者一旦忘了改，目录里就永远躺着一行
   * 谎话，而它看起来跟真条目一模一样。空标题则是自明的——它进编辑态，写不出东西
   * 失焦时就撤销。
   */
  const [open, setOpen] = useState(section.title === "");

  /**
   * 三角与数量在编辑态和只读态都要有：PDF 自带的目录不可编辑，但**一样需要导航**
   * ——一本几百页的书自带目录时，折叠的价值一点没少。
   */
  const affordances = (
    <>
      {fold !== null && (
        <button
          className={`fold${fold.expanded ? " open" : ""}`}
          aria-expanded={fold.expanded}
          aria-label={fold.expanded ? "折起" : "展开"}
          title={fold.expanded ? "折起" : "展开"}
          onClick={fold.onToggle}
        >
          {/* 三角用 CSS 画，不用字形。`▾`（U+25BE）在这台机器上回退到了别的字体，
              渲染成一个琥珀色方框，而同一行的 `▸` 正常——一个控件的长相不该赌字体。 */}
          <i />
        </button>
      )}
      {/* 三角缺席时也要占住位置，否则同级标题的文字会一行左一行右地错开。 */}
      {fold === null && <span className="fold placeholder" />}
    </>
  );

  const count = clipCount > 0 && <span className="count">{clipCount}</span>;

  /**
   * **标题本身就是跳转。**
   *
   * 此前跳转挂在右边那个「第 N 页」的小按钮上，标题只是一段死文字——目录里点标题
   * 不动，是反直觉的：标题是这一行里最大、最像链接的那个东西。而且不可编辑的那一档
   * （PDF 自带的目录）连那个小按钮都没有，于是**整份自带目录完全不能跳**。
   *
   * 页码退回成标签：它回答的是「跳过去会到哪儿」，那是信息，不是第二个做同一件事的控件。
   */
  const heading = (
    <>
      {affordances}
      <button className="jump grow" title={`跳到第 ${section.page} 页`} onClick={onJump}>
        {section.title}
      </button>
      {count}
      <span className="at">第 {section.page} 页</span>
    </>
  );

  if (!editable) return <h4 className="section-head">{heading}</h4>;

  if (!open) {
    return (
      <h4 className="section-head editable">
        {heading}
        {/* **升降级和删除直接放在行上**，不藏在编辑态里。
            它们是「整理这份目录」时最常做的两件事——识别出来的层级经常差一层，
            而多出来的条目要一眼就能删掉。为它们先点一次 ✎ 是多余的一步。
            ✎ 留给真正需要打字的：改名字、改页码。 */}
        <button className="ghost" title="升一级" disabled={section.level === 0} onClick={() => onChange({ ...section, level: section.level - 1 })}>
          ←
        </button>
        <button className="ghost" title="降一级" onClick={() => onChange({ ...section, level: section.level + 1 })}>
          →
        </button>
        <button className="ghost" title="改名字和页码" onClick={() => setOpen(true)}>
          ✎
        </button>
        <button className="ghost" title="删掉这一条" onClick={onRemove}>
          ✕
        </button>
      </h4>
    );
  }

  return (
    <div className="section-edit">
      <input
        className="grow"
        /* eslint-disable-next-line jsx-a11y/no-autofocus --
           这条规则防的是「页面一加载就抢焦点」。这里的输入框要么是读者点 ✎ 打开的，
           要么是刚右键加出来的空条目——焦点跟着那次操作走正是预期。 */
        autoFocus
        placeholder="标题"
        defaultValue={section.title}
        onBlur={(event) => {
          const title = event.target.value.trim();
          // 一条没有标题的目录不是目录。刚加的没写就撤销，已有的清空就当没改。
          if (title === "") {
            if (section.title === "") onRemove();
            return;
          }
          onChange({ ...section, title });
        }}
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
      <button className="ghost" onClick={() => setOpen(false)}>
        完成
      </button>
    </div>
  );
}

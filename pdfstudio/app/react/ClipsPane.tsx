import { useState } from "react";
import { clipTitle, type Clip } from "../../src/clip/clip";
import type { Workspace } from "../../src/app/workspace";
import { TAG_COLORS, type Tag, type TagColor } from "../../src/tag/tag";
import { groupClipsBySection, type Section } from "../../src/clip/outline";
import { outlineRows } from "../../src/clip/outline-rows";
import { SectionHead } from "./SectionHead";
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
  sections,
  generated,
  onGenerate,
  onEditSections,
  selected,
  onSelect,
  onJump,
}: {
  ws: Workspace;
  clips: Clip[];
  tags: Tag[];
  /** 用来分组的目录：生成的优先，没有才用 PDF 自带的。 */
  sections: Section[];
  /** 这一份是不是**生成的**。只有生成的才可改——自带的是文件里的事实，改了存不回去。 */
  generated: boolean;
  onGenerate: () => void;
  onEditSections: (next: Section[]) => void;
  selected: string | null;
  onSelect: (clipId: string | null) => void;
  onJump: (page: number) => void;
}) {
  // 筛选是视图状态，不落盘：它是「此刻在找什么」，不是这本书的属性。
  const [only, setOnly] = useState<TagColor | null>(null);
  /**
   * 被点过的行。**存翻转而不是存状态**——默认展开与否依赖数据（划了新摘录会让一节
   * 从默认折起变成默认展开），存绝对状态的话没点过的行会被钉死在旧默认上。
   *
   * 同筛选，不落盘：它是「此刻在找什么」。
   */
  const [toggled, setToggled] = useState<ReadonlySet<number>>(new Set());

  const inScope = only === null ? clips : clips.filter((clip) => clip.tagId === only);
  // **先筛后分组**：筛掉之后空掉的小节不该还留着标题。
  // **没有目录时，页码本身就是目录。** 页码从每一行挪到标题上——逐行标「第 N 页」会
  // 把一栏挤满重复信息，但整栏一个页码都没有又会彻底失去方位。
  const asSections =
    sections.length > 0
      ? sections
      : [...new Set(inScope.map((clip) => clip.region.page))]
          .sort((a, b) => a - b)
          .map((page) => ({ title: `第 ${page} 页`, page, y: null, level: 0, path: [] }));
  const groups = groupClipsBySection(inScope, asSections);
  // 折叠状态用下标记，**目录一变下标就全错位**（换书、改目录、切筛选都会变）。
  // 拿组数当指纹：不精确，但错的方向是「多重置一次」，而不是「把折叠画到别的章上」。
  const [fingerprint, setFingerprint] = useState(groups.length);
  if (fingerprint !== groups.length) {
    setFingerprint(groups.length);
    setToggled(new Set());
  }
  const rows = outlineRows(groups, toggled);
  const ordered = groups.flatMap((group) => group.clips);
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

  /**
   * 「这本书没有目录」这一行。
   *
   * **一条摘录都没有时也要给**——它此前排在空状态的提前 return 之后，于是刚打开一本
   * 几百页的书、最想先把目录建起来的那一刻，入口恰好不存在。目录是这本书的骨架，
   * 不是摘录的附属品。
   */
  const buildToc = sections.length === 0 && (
    <div className="row filter">
      <span className="faint grow">这本书没有目录，按页排的</span>
      <button className="btn" onClick={onGenerate}>
        从目录页生成
      </button>
    </div>
  );

  /**
   * **一条摘录都没有，但已经有目录**——刚生成完目录正是这个状态。
   *
   * 此前这里无条件提前 return，于是花六次模型调用做出来的目录，在划下第一条摘录之前
   * 一个字都看不到（ADR-0018）。真正的空只有「既没目录也没摘录」。
   */
  if (clips.length === 0 && asSections.length === 0) {
    return (
      <div className="pane">
        {buildToc}
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

  const replaceSection = (target: Section, next: Section | null) =>
    onEditSections(
      sections.flatMap((section) => (section === target ? (next === null ? [] : [next]) : [section])),
    );

  return (
    <div className="pane">
      {/* 入口放在这儿而不是设置里：目录是**这本书的数据**，而且「没有目录」正是在这一栏
          被感觉到的——它现在退回了按页排。 */}
      {buildToc}
      {generated && (
        <>
          <p className="faint" style={{ marginBottom: 8 }}>
            目录是自动识别的，可能有错——点标题跳过去核对，← → 调层级、✕ 删、✎ 改名字。
            <strong>漏了一条就翻到那一页，在页面上右键加书签。</strong>
          </p>

        </>
      )}

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

      {ordered.length === 0 && (
        <p className="faint">
          {clips.length === 0 ? "还没有摘录。在左边拖一个框就有第一条。" : "这一类还没有摘录。"}
        </p>
      )}

      {/* 这一栏读起来是一份 markdown 文档：目录是标题，摘录是正文。层级靠字号，
          不靠面包屑——祖先标题即使自己没摘录也会留着（见 groupClipsBySection）。 */}
      {rows.map(({ group, foldable, expanded, clipCount, level, index }) => (
        <section
          key={group.section === null ? "#" : `${group.section.page}-${group.section.title}-${index}`}
          className="outline-part"
          // 标题和它底下的摘录用同一个缩进：正文跟着自己的标题走，读起来才是一份文档，
          // 而不是标题缩进、正文各自贴在左边。
          //
          // 层级同时写成 data 属性和 CSS 变量：变量给 calc() 算缩进与字号，data 属性给
          // 选择器。**不拿 [style*="--depth: 0"] 去选**——React 序列化内联样式时空格或
          // 分号一变，那种选择器就静默失效。
          data-depth={Math.min(level, 2)}
          style={{ "--depth": Math.min(level, 2) } as React.CSSProperties}
        >
          {group.section === null ? (
            <h4 className="section-head">开头</h4>
          ) : (
            <SectionHead
              section={group.section}
              editable={generated}
              /* 没有子节点就不画三角——点了什么都不会发生的控件是骗人的。 */
              fold={
                foldable
                  ? {
                      expanded,
                      /* `index` 是它在 groups 里的下标，不是行号——折起一章之后行号
                         会整体前移，用行号翻转会翻到别人头上。 */
                      onToggle: () =>
                        setToggled((was) => {
                          const next = new Set(was);
                          if (!next.delete(index)) next.add(index);
                          return next;
                        }),
                    }
                  : null
              }
              /* 折起来时「第 12 章我划过吗」得还答得出，所以数的是连同子孙。 */
              clipCount={clipCount}
              onJump={() => onJump(group.section!.page)}
              onChange={(next) => replaceSection(group.section!, next)}
              onRemove={() => replaceSection(group.section!, null)}
            />
          )}

          {/* 折起来时自己的摘录也藏——三角折的是「这个标题底下的东西」，摘录也是
              底下的东西。只藏子小节的话，点了三角却看见摘录还在，三角就成了半个谎。 */}
          {expanded &&
            group.clips.map((clip) => (
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
          {clip.tagId !== null && <span className="swatch dot" data-tag={clip.tagId} />}
          <span className="line">{clipTitle(clip)}</span>
          {/* 星标与笔记只留一个字符的痕迹：一行放不下更多，而这两件事又是「三个月后
              重开时想一眼看见」的（标签地图那套理由）。 */}
          {clip.important && <span className="badge">★</span>}
          {clip.note !== null && <span className="badge">✎</span>}
          {/* 墓碑：内容到期被清了，锚点还在（ADR-0012）。要说出来，否则读者
              只会觉得「这条怎么空了」。 */}
          {clip.content === null && clip.state === "ready" && <span className="badge">已过期</span>}
        </button>
            ))}
        </section>
      ))}
    </div>
  );
}

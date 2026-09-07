import { useState } from "react";
import type { Active, DeskItem, DeskKind, RootKind } from "../../src/app/desk";
import { useRemembered } from "./remember";

/**
 * 外壳：装着 Book、Context 与 Writer 三侧的那一个窗口（ADR-0003、ADR-0004）。
 *
 * **它不持有任何一边的领域状态**——摘录、目录、context、知识图、稿子，一样都不经过
 * 这里。判据是硬的：这个文件**不 import 任何一边的领域类型**（`Clip` / `Section` /
 * `Context` / `Draft`）。哪天需要了，说明那段代码放错了地方。
 *
 * **没有「模式」这一层。** 三个根与每一样打开的东西平级：上面三个是根，下面是打开的
 * 具体页面（书和稿子混在同一列里），点哪个哪个活。
 */
/** 案头上每一种条目的样子。加一种 `DeskKind` 就得在这儿写一行，漏了是 TS 报错。 */
const ICON: Record<DeskKind, string> = { doc: "📕", draft: "✍️", page: "🌐", loop: "🔁" };
const KEPT: Record<DeskKind, string> = {
  doc: "书还在书架上",
  draft: "稿子",
  page: "站点",
  loop: "项目还在跑",
};

/**
 * 活动栏上那几个根，**连排列顺序一起**。
 *
 * 原来是四段几乎一样的 JSX。写成表有两个作用：一是加一个根漏了就是 TS 报错
 * （`Record<RootKind, …>` 逼着每一种都写一行，跟 `ICON` / `KEPT` 同一手）；二是
 * 收起来之后每一个根的形状必然一致——四段手写的 JSX 里漏掉一段的收起处理，
 * 表现是那一个按钮在窄栏里把自己撑破，而这种事没有测试会替你发现。
 *
 * **图标在展开时也显示。** 只在收起时才出现的图标等于两套界面：读者收起来那一刻
 * 面对的是四个从没见过的符号，得逐个悬停才知道谁是谁。
 */
const ROOT: Record<RootKind, { icon: string; label: string }> = {
  shelf: { icon: "📚", label: "Book" },
  context: { icon: "🕸️", label: "Context" },
  /** 读、想、写三件事，一侧一个根。写不是读的一个子功能，所以不塞在 Book 里。 */
  writer: { icon: "🖋️", label: "Writer" },
  /**
   * 第四件事：**不在场时替你干活**。它不是写的一个子功能——写是你持笔，
   * Loop 是没人持笔（`docs/workflow.md` §1.3），所以自成一根。
   */
  loops: { icon: "🔁", label: "Loop" },
  /** 写完之后送出门。跟 Writer 分开：写是让它成型，发是让它离开这台机器。 */
  publish: { icon: "📤", label: "发布" },
};

/** 表的键序就是屏幕上的顺序：只有一处能改顺序，改了不会跟另一处对不上。 */
const ROOT_ORDER = Object.keys(ROOT) as RootKind[];

export function Shell({
  active,
  onRoot,
  desk,
  titleOf,
  onPick,
  onClose,
  onSettings,
  children,
}: {
  active: Active;
  onRoot: (kind: RootKind) => void;
  desk: DeskItem[];
  /** 拿案头上的一项换它的名字。外壳自己不认识书，也不认识稿子，只认识 id。 */
  titleOf: (item: DeskItem) => string;
  onPick: (item: DeskItem) => void;
  onClose: (item: DeskItem) => void;
  onSettings: () => void;
  children: React.ReactNode;
}) {
  const [tight, setTight] = useRemembered("rail-tight", false);

  /**
   * 收起来之后悬停要读得到名字：三本书是同一个 📕，**这是那一列当时唯一的分辨手段**。
   *
   * 没用原生 `title`，两个原因，都是硬的：
   *
   * 1. 它要等将近一秒才出来。在一条只剩图标的窄栏里，那一秒是「我得先猜」。
   * 2. **它会被裁掉。** 案头那一列是 `overflow: auto`（条目多了要能滚），而 CSS 里
   *    没有「纵向滚、横向不裁」这回事——`overflow-y: auto` 会把 `overflow-x` 一并
   *    算成 auto。所以飘出来的那一块只能是 `position: fixed`，而 fixed 的位置得当场
   *    量：这正是这里出现 JS 的理由，不是懒。
   *
   * 只在收起时用。展开时名字本来就写着，两个提示同时冒出来是重复。
   */
  const [tip, setTip] = useState<{ top: number; text: string } | null>(null);

  const hover = (text: string) => (event: { currentTarget: Element }) => {
    if (!tight) return;
    const box = event.currentTarget.getBoundingClientRect();
    setTip({ top: box.top + box.height / 2, text });
  };
  const away = () => setTip(null);

  const toggle = () => {
    // 收/展的那一下先把提示撤掉：不撤的话它会挂在原地，指向一个已经不在那儿的按钮。
    setTip(null);
    setTight();
  };

  /**
   * 案头上这一项是不是活着的那个。
   *
   * 几个根身上没有 `id`（设置也没有，它带的是来路），所以要先把 `active` 收窄到
   * 「打开的东西」上——直接比 `active.id` 是编译不过的，而这正是那个联合的用处：
   * 不可能的状态连写都写不出来。
   *
   * **判据是「有没有 id」，不是把打开的那几种一一列出来。** 原来写的是
   * `kind === "doc" || kind === "draft"`，于是网页那一行**从来不会高亮**——加一种
   * 打开的东西却忘了往这个列表里补一笔，不报错，只是那一类永远不亮。
   */
  const isOn = (item: DeskItem): boolean =>
    "id" in active && active.kind === item.kind && active.id === item.id;

  return (
    <div className="shell">
      <nav className={`rail${tight ? " tight" : ""}`}>
        {/* 收起 / 展开。**放在最上面**：它管的是这一栏本身，不是栏里的哪一样，
            而且收起前后它都在同一个位置——按钮跟着状态跑的话，收起来之后读者要
            先找到它才能展开。 */}
        <button
          className="rail-tighten"
          title={tight ? "展开侧栏" : "收起侧栏，只留图标"}
          aria-label={tight ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!tight}
          onClick={toggle}
        >
          {tight ? "»" : "«"}
        </button>

        {/* 四个根，竖排。它们和下面那一列是同一种东西（都是「可以活着的一样」），
            只是永远在，所以放在上面并且不可关闭。 */}
        <div className="roots">
          {ROOT_ORDER.map((kind) => (
            <button
              key={kind}
              className={`root${active.kind === kind ? " on" : ""}`}
              /* 收起来之后名字被 CSS 藏了，**可访问名不能跟着一起没**——所以名字
                 一直写在 `aria-label` 上。鼠标那一路走下面的浮出块。 */
              aria-label={ROOT[kind].label}
              onMouseEnter={hover(ROOT[kind].label)}
              onFocus={hover(ROOT[kind].label)}
              onMouseLeave={away}
              onBlur={away}
              onClick={() => onRoot(kind)}
            >
              <span className="what" aria-hidden>
                {ROOT[kind].icon}
              </span>
              <span className="label">{ROOT[kind].label}</span>
            </button>
          ))}
        </div>

        <div className="desk">
          {desk.length > 0 && <p className="desk-label">打开的</p>}
          {desk.map((one) => (
            <div
              key={`${one.kind}:${one.id}`}
              className={`desk-item${isOn(one) ? " on" : ""}`}
            >
              <button
                className="grow"
                /* 展开时名字是被截断的，所以原生 `title` 在这一状态下仍然有用；
                   收起时交给浮出块（见上面 `tip`），**两个不能同时挂**。 */
                title={tight ? undefined : titleOf(one)}
                aria-label={titleOf(one)}
                onMouseEnter={hover(titleOf(one))}
                onFocus={hover(titleOf(one))}
                onMouseLeave={away}
                onBlur={away}
                onClick={() => onPick(one)}
              >
                {/* 一眼看出这一项是什么。**不靠颜色也不靠分组**：几侧混在同一列
                    正是要点（ADR-0004），分组就等于把「模式」又装回来了。

                    **用查表不用三元表达式**：`kind === "doc" ? 📕 : ✍️` 在加第三种时
                    不报错，只是把网页默默画成稿子——`rootOf` 犯过一模一样的错。
                    `Record<DeskKind, …>` 逼着每加一种都写一行。

                    图标在按钮**里面**：收起之后它是唯一还看得见的东西，放在按钮外面
                    就等于那一列点不动了。 */}
                <span className="what" aria-hidden>
                  {ICON[one.kind]}
                </span>
                <span className="label">{titleOf(one)}</span>
              </button>
              {/* 收起时这个叉是藏掉的：36px 宽里塞不下两个可点的目标，挤在一起的
                  后果是想切过去却把它关了。**关掉是展开状态下的操作。** */}
              <button
                className="shut"
                title={`从案头拿走（${KEPT[one.kind]}还在）`}
                onClick={() => onClose(one)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* **设置也是一个根**（ADR-0005 决策 3），不是盖在内容上的一层——所以它会亮，
            也所以它在这一列里。放在最下面只是因为它不是日常主路径，不是因为它特殊。
            此前阅读页顶栏还有第二个设置入口，同一张表两个入口，已经删掉。 */}
        <button
          className={`rail-foot${active.kind === "settings" ? " on" : ""}`}
          aria-label="设置"
          onMouseEnter={hover("设置")}
          onFocus={hover("设置")}
          onMouseLeave={away}
          onBlur={away}
          onClick={onSettings}
        >
          <span className="what" aria-hidden>
            ⚙️
          </span>
          <span className="label">设置</span>
        </button>
      </nav>

      {/* 浮出的名字。**只在收起时存在**，而且是 `position: fixed`——案头那一列会滚，
          贴在条目上的话一飘出栏就被裁掉（见上面 `tip` 那段）。
          `aria-hidden`：名字已经由按钮的 `aria-label` 报过一遍了，读屏两遍是噪音。 */}
      {tight && tip !== null && (
        <div className="rail-tip" style={{ top: tip.top }} aria-hidden>
          {tip.text}
        </div>
      )}

      <div className="shell-main">{children}</div>
    </div>
  );
}

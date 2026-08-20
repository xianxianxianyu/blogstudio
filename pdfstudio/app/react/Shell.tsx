import type { Active, DeskItem } from "../../src/app/desk";

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
  onRoot: (kind: "shelf" | "context" | "writer") => void;
  desk: DeskItem[];
  /** 拿案头上的一项换它的名字。外壳自己不认识书，也不认识稿子，只认识 id。 */
  titleOf: (item: DeskItem) => string;
  onPick: (item: DeskItem) => void;
  onClose: (item: DeskItem) => void;
  onSettings: () => void;
  children: React.ReactNode;
}) {
  /**
   * 案头上这一项是不是活着的那个。
   *
   * 三个根（shelf / context / writer）身上没有 `id`，所以要先把 `active` 收窄到
   * 「打开的东西」那两个分支上——直接比 `active.id` 是编译不过的，而这正是那个联合
   * 的用处：不可能的状态连写都写不出来。
   */
  const isOn = (item: DeskItem): boolean =>
    (active.kind === "doc" || active.kind === "draft") &&
    active.kind === item.kind &&
    active.id === item.id;

  return (
    <div className="shell">
      <nav className="rail">
        {/* 三个根，竖排。它们和下面那一列是同一种东西（都是「可以活着的一样」），
            只是永远在，所以放在上面并且不可关闭。 */}
        <div className="roots">
          <button
            className={`root${active.kind === "shelf" ? " on" : ""}`}
            onClick={() => onRoot("shelf")}
          >
            Book
          </button>
          <button
            className={`root${active.kind === "context" ? " on" : ""}`}
            onClick={() => onRoot("context")}
          >
            Context
          </button>
          {/* 读、想、写三件事，一侧一个根。写不是读的一个子功能，所以不塞在 Book 里。 */}
          <button
            className={`root${active.kind === "writer" ? " on" : ""}`}
            onClick={() => onRoot("writer")}
          >
            Writer
          </button>
        </div>

        <div className="desk">
          {desk.length > 0 && <p className="desk-label">打开的</p>}
          {desk.map((one) => (
            <div
              key={`${one.kind}:${one.id}`}
              className={`desk-item${isOn(one) ? " on" : ""}`}
            >
              {/* 一眼看出这一项是书还是稿子。**不靠颜色也不靠分组**：两侧混在同一列
                  正是要点（ADR-0004），分组就等于把「模式」又装回来了。 */}
              <span className="what" aria-hidden>
                {one.kind === "doc" ? "📕" : "✍️"}
              </span>
              <button className="grow" onClick={() => onPick(one)}>
                {titleOf(one)}
              </button>
              <button
                className="shut"
                title={one.kind === "doc" ? "从案头拿走（书还在书架上）" : "从案头拿走（稿子还在）"}
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
          onClick={onSettings}
        >
          设置
        </button>
      </nav>

      <div className="shell-main">{children}</div>
    </div>
  );
}

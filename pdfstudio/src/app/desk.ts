/**
 * 案头：现在手边开着哪些东西（ADR-0003、ADR-0004）。
 *
 * 与**书架**、**稿子架**成对——架子是库存，案头是工作面。**同一时刻只有一项是活的**：
 * 切换它等于换一样东西在手上（换书要重读 PDF、摘录和目录；换稿子要重新读文件、
 * 换一场对话），不是切标签页。
 *
 * **这一层不认识任何领域类型**（`Clip` / `Section` / `Context` / `Draft` 一个都不 import）
 * ——外壳只路由，不持有任何一边的领域状态。真需要 import 它们，就说明代码放错了地方。
 *
 * 不落盘：它是「此刻手边有什么」，与筛选、折叠同一口径。
 */

/** 案头上的一项是哪一侧的东西。书归 Book，稿子归 Writer。 */
export type DeskKind = "doc" | "draft" | "page";

/**
 * 现在活着的是哪一样。**三个根与每一项打开的东西平级**——没有「模式」这一层。
 *
 * 此前是 `side`（book/context）＋ `reading`（在读/在书架）两个布尔量，四个组合里
 * 有一个是无意义的。用不上的组合迟早会被写进某个条件判断里。
 *
 * Writer 进来时这个联合只是多了两个分支（一个根、一种打开的东西），别的什么都没动
 * ——ADR-0003 决策 3 预告的正是这一下。
 */
export type Active =
  | { kind: "shelf" }
  | { kind: "context" }
  | { kind: "writer" }
  | { kind: "doc"; id: string }
  | { kind: "draft"; id: string }
  | { kind: "page"; id: string }
  /**
   * 设置。**它记着自己是从哪一样打开的**，因为它不再是盖在内容上的一层。
   *
   * 此前设置是原生 `<dialog>`，「关掉就回到刚才那一页」是浏览器白送的。做成根之后
   * 这一条得自己拿住：读了一半去改个模型，回来必须还在那本书上——掉回书架的话，
   * 读者要重新点开它，而换书是要重读 PDF、摘录和目录的。
   *
   * `from` 的类型排掉了设置自己：**设置里不能再套一个设置**。侧栏那个按钮一直在，
   * 包括已经站在设置页上的时候，不排掉的话点两次就再也退不回那本书，而且退出去看
   * 起来还挺正常（退到了设置页）。这与 ADR-0003 删掉 `side × reading` 那个不可能组合
   * 是同一手。
   */
  | { kind: "settings"; from: Settled };

/** 设置之外的一切。设置的来路只能是它们中的一个。 */
export type Settled = Exclude<Active, { kind: "settings" }>;

/**
 * 案头上的一项。
 *
 * **书要记住位置，稿子不用**：书的位置是「第几页、右栏开着哪一栏」，离开时不记住，
 * 切回来就回到第 1 页；而稿子的位置由编辑器自己拿着（光标、滚动），外壳插手反而会把
 * 它顶掉。所以这里是个联合，而不是给稿子塞两个用不上的字段。
 */
export type DeskItem =
  | { kind: "doc"; id: string; page: number; pane: "clips" | "chat" }
  | { kind: "draft"; id: string }
  /**
   * 一个打开着的网页。`id` 是**归一化过的 `pageId`**（`web/page-id.ts`），不是
   * 地址栏里那一串——否则同一篇文章从不同渠道点进来会开成两个条目。
   */
  | { kind: "page"; id: string; url: string; title: string };

/**
 * 打开设置，记住来路。**已经在设置里就原样返回**——见 `Active` 上那段注释。
 */
export const openSettings = (active: Active): Active =>
  active.kind === "settings" ? active : { kind: "settings", from: active };

/** 关掉设置，回到来路。不在设置里的原样返回（点别的根就是直接走）。 */
export const closeSettings = (active: Active): Active =>
  active.kind === "settings" ? active.from : active;

/** 活着的是不是这本书。 */
export const isReading = (active: Active, docId: string | null): boolean =>
  active.kind === "doc" && docId !== null && active.id === docId;

/** 活着的是不是这篇稿子。 */
export const isWriting = (active: Active, draftId: string | null): boolean =>
  active.kind === "draft" && draftId !== null && active.id === draftId;

/** 点案头上的一项＝让它活。 */
export const activeOf = (item: DeskItem): Active => ({ kind: item.kind, id: item.id });

/** 这一项属于哪个根。案头空了要退回去的就是它。 */
/**
 * 这一项属于哪个根。案头空了要退回去的就是它。
 *
 * **用查表不用三元表达式。** 原来是 `kind === "doc" ? shelf : writer`——加第三种时
 * 它会**默默把网页归到 Writer 名下**，而现象是「关掉最后一个网页，莫名其妙掉进
 * 写作页」。表的形状逼着每加一种都要写一行。
 */
const ROOTS: Record<DeskKind, Active> = {
  doc: { kind: "shelf" },
  page: { kind: "shelf" },
  draft: { kind: "writer" },
};

export const rootOf = (kind: DeskKind): Active => ROOTS[kind];

const same = (item: DeskItem, kind: DeskKind, id: string): boolean => item.kind === kind && item.id === id;

/**
 * 打开一项。已经在案头上的**不重复、也不挪位置**——按最近使用重排的话，人眼里的
 * 顺序会自己跳，而下一次想点的那一项已经不在他记得的地方了。
 */
export function openOnDesk(desk: DeskItem[], item: DeskItem): DeskItem[] {
  if (desk.some((one) => same(one, item.kind, item.id))) return desk;
  return [...desk, item];
}

/** 打开一本书（新开的从第 1 页、摘录栏起）。 */
export const openDocOnDesk = (desk: DeskItem[], docId: string): DeskItem[] =>
  openOnDesk(desk, { kind: "doc", id: docId, page: 1, pane: "clips" });

/** 打开一篇稿子。 */
/**
 * 打开一个网页。**`pageId` 与 `url` 是两样东西**：前者判定身份（归一化过），
 * 后者是真正访问到的地址（跟完重定向、一字不改）。同一篇文章从不同渠道点进来
 * `pageId` 相同，不该开成两个条目。
 */
export const openPageOnDesk = (desk: DeskItem[], pageId: string, url: string, title: string): DeskItem[] =>
  openOnDesk(desk, { kind: "page", id: pageId, url, title });

export const openDraftOnDesk = (desk: DeskItem[], draftId: string): DeskItem[] =>
  openOnDesk(desk, { kind: "draft", id: draftId });

/** 记住这本书的位置。不在案头上的当没发生——不为一次无害的调用凭空造一项出来。 */
export function rememberOnDesk(
  desk: DeskItem[],
  docId: string,
  at: Partial<{ page: number; pane: "clips" | "chat" }>,
): DeskItem[] {
  if (!desk.some((one) => same(one, "doc", docId))) return desk;
  return desk.map((one) => (same(one, "doc", docId) ? { ...one, ...at } : one));
}

/**
 * 关掉一项，并给出接下来该活的是谁。
 *
 * 关掉的不是活的那个就不动活的；关掉活的那个**接右边**（手指停在原地，下一项自然
 * 顶上来），右边没有了才往左退。都没有就回**它自己那一侧的根**——关掉最后一篇稿子
 * 落到书架上，等于把人从写作里踢回阅读。
 */
export function closeOnDesk(
  desk: DeskItem[],
  kind: DeskKind,
  id: string,
  active: Active,
): { desk: DeskItem[]; active: Active } {
  const index = desk.findIndex((one) => same(one, kind, id));
  if (index === -1) return { desk, active };

  const next = desk.filter((one) => !same(one, kind, id));

  // 设置盖在某一样上面时，动的是**它的来路**。设置页开着的时候侧栏那一列还在，
  // 人可以把自己刚才在读的那本从案头拿走——不管这一下的话，退出设置会回到一本
  // 已经不在案头上的书：界面照画，而侧栏里已经没有它了。
  //
  // **来路没了，设置也就无处可退，所以跟着关。** 另一条路（留在设置里、把来路换成
  // 接班的那一项）代价更大：换书要重读 PDF、摘录和目录（ADR-0003 代价 1），而那一下
  // 会在人盯着设置页的时候悄悄发生。
  const under = active.kind === "settings" ? active.from : active;
  if (!(under.kind === kind && under.id === id)) return { desk: next, active };

  // 原来那个位置上现在站着的就是「下面那一项」；越界了就退回最后一项。
  const heir = next[index] ?? next[next.length - 1];
  return { desk: next, active: heir ? activeOf(heir) : rootOf(kind) };
}

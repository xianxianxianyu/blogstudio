import type { ClipGroup } from "./outline";

/**
 * 目录树的折叠：算出这一刻该画哪些行。
 *
 * **为什么要有折叠**（ADR-0018）：空小节现在也显示，因为藏起来读者就不知道第 12 章
 * 存在。但一本 654 页的书目录有两三百条，全铺开就是一面墙。折叠丢掉的只是细节，
 * 隐藏丢掉的是存在性——所以密度问题交给这里。
 *
 * 抽成纯函数是因为**规则不直观**：默认展开与否依赖数据（有摘录的要展开）而不只是层级，
 * 而「祖先折起时子孙必须跟着消失，哪怕子孙自己是展开的」正是这类代码最常见的漏洞。
 */
export interface OutlineRow {
  group: ClipGroup;
  /**
   * 它在 `groups` 里的下标。**折叠状态按这个记，不能按行号**——折起一章之后行号会
   * 整体前移，用行号翻转会翻到别人头上，而且看起来只是「点错了」。
   */
  index: number;
  /**
   * 底下有没有东西可展开——**子小节算，自己的摘录也算**。
   *
   * 起初只算子小节，于是「底下躺着两条摘录却折不起来」，同一层的标题有的有三角有的
   * 没有，读者看不出规律。折叠折的是「这个标题底下的东西」，摘录也是底下的东西。
   *
   * 真的什么都没有才不画——点了不动的控件是骗人的。
   */
  foldable: boolean;
  expanded: boolean;
  /** 这一节**连同子孙**的摘录数。折起来时「第 12 章我划过吗」得还答得出。 */
  clipCount: number;
  /** 缩进用，等于 `section.level`；「目录之前」那一组是 0。 */
  level: number;
}

const levelOf = (group: ClipGroup) => group.section?.level ?? 0;

/**
 * @param toggled 被读者点过的行（下标）。存的是**翻转**而不是状态：默认值依赖数据
 *   （划了新摘录会让一节从默认折起变成默认展开），存绝对状态的话读者没点过的行也会
 *   被钉死在旧默认上。
 */
export function outlineRows(groups: ClipGroup[], toggled: ReadonlySet<number>): OutlineRow[] {
  // **「拥有子孙」和「可折叠」是两件事**，必须分开算：
  //   owns     —— 后面有没有更深层级的小节。它决定折起来时要跳过谁。
  //   foldable —— 底下有没有东西（子小节**或**自己的摘录）。它只决定画不画三角。
  // 合成一个数组的话，一个只有摘录的小节会被当成「有子孙」，折起它会把后面不相干的
  // 小节一起吞掉——而那看起来只像「目录突然少了几行」。
  const owns = groups.map(() => false);
  const subtree = groups.map((group) => group.clips.length);
  const deeper = (i: number, j: number) => levelOf(groups[j]) > levelOf(groups[i]);

  for (let i = 0; i < groups.length; i++) {
    // 「目录之前」那一组不拥有任何人——它是收容所，不是树上的节点。
    if (groups[i].section === null) continue;
    for (let j = i + 1; j < groups.length && deeper(i, j); j++) {
      owns[i] = true;
      if (levelOf(groups[j]) === levelOf(groups[i]) + 1) subtree[i] += subtree[j];
    }
  }

  // 跳级的目录（1 直接到 3）会让上面那条 `level + 1` 的累加漏掉，兜一手：
  // 子孙里没有直属子级时，把最浅的那一层并进来。
  for (let i = 0; i < groups.length; i++) {
    if (!owns[i] || subtree[i] > groups[i].clips.length) continue;
    let shallowest = Infinity;
    for (let j = i + 1; j < groups.length && deeper(i, j); j++) {
      shallowest = Math.min(shallowest, levelOf(groups[j]));
    }
    for (let j = i + 1; j < groups.length && deeper(i, j); j++) {
      if (levelOf(groups[j]) === shallowest) subtree[i] += subtree[j];
    }
  }

  const foldable = groups.map((group, i) => owns[i] || group.clips.length > 0);

  // 默认展开：顶层之外，只有「自己或子孙有摘录」的才展开。读者点过就翻转。
  const expanded = groups.map((group, i) => {
    const byDefault = group.section === null || subtree[i] > 0;
    return toggled.has(i) ? !byDefault : byDefault;
  });

  const rows: OutlineRow[] = [];
  // 祖先链上任何一个折起，整条子孙就都不画——**深度优先地跳过**，而不是逐行判断，
  // 逐行判断要重新找祖先，而找错祖先不会报错，只会让某几行诡异地不见。
  for (let i = 0; i < groups.length; i++) {
    rows.push({
      group: groups[i],
      index: i,
      foldable: foldable[i],
      expanded: expanded[i],
      clipCount: subtree[i],
      level: levelOf(groups[i]),
    });
    // 跳过的依据是 `owns`，**不是 `foldable`**：折起一个只有摘录的小节，藏的是它自己
    // 那几条，后面同级的小节一个都不能跟着消失。
    if (owns[i] && !expanded[i]) {
      // **基准层级要先钉住。** 写成 `levelOf(groups[i])` 的话它会随着 i 一起往深处漂：
      // 折上「第1章」(0) 时，扫到 1.1(1) 之后基准就变成 1，于是 1.2(1) 不再「更深」，
      // 跳过提前结束——第1章折起来了，1.2 却还露在外面。
      const base = levelOf(groups[i]);
      while (i + 1 < groups.length && levelOf(groups[i + 1]) > base) i++;
    }
  }
  return rows;
}

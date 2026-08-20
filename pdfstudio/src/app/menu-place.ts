/** 视口坐标里的一个矩形。 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 工具条与选区、与视口边缘之间留的空。 */
const GAP = 8;

/**
 * 选区旁边那条工具条摆在哪（视口坐标）。
 *
 * **先下、放不下翻上、再放不下压在内侧下沿。** 一定要给出一个看得见的位置——
 * 「菜单飘在屏幕外」是那种读者只会说「点了没反应」、而日志里什么都没有的 bug
 * （ADR-0019 代价 3）。
 *
 * 横向跟选区左对齐，越界就往回收；视口比工具条还窄时收到 0，不给负数。
 */
export function placeMenu(
  selection: Box,
  menu: { width: number; height: number },
  view: { width: number; height: number },
): { x: number; y: number } {
  const below = selection.y + selection.height + GAP;
  const above = selection.y - GAP - menu.height;

  const y =
    below + menu.height + GAP <= view.height
      ? below
      : above >= GAP
        ? above
        : // 上下都塞不下：压在选区内侧的下沿，至少还在视口里。
          Math.max(0, view.height - GAP - menu.height);

  // 左右都留 `GAP`，对称。视口比「工具条 + 两边留白」还窄时退回 0——
  // 那时窗口已经小到没法讲究，但仍然不能给负数。
  const right = view.width - GAP - menu.width;
  const x = right < GAP ? 0 : Math.min(Math.max(selection.x, GAP), right);
  return { x, y };
}

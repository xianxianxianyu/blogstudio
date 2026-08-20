/** `.stage` 左右两边的内边距之和。页面要在这中间铺满。 */
export const STAGE_PADDING = 40;

/**
 * 让这一页正好铺满左栏的倍率。
 *
 * **算不出来时给 `null`，不给一个凑合的数。** 拿不到宽度的情况是真实存在的：元素还没
 * 布局、或者**已经脱离文档**（切到另一侧再回来时，旧节点还被 ResizeObserver 盯着，
 * 它的 `clientWidth` 是 0）。那时算出来是负倍率，画布会塌成一个小白块——而顶栏
 * 仍然显示 100%，因为 `scale / fit` 两个都是同一个负数。**坏得一点声音都没有。**
 *
 * 保留三位小数：更细的差别在画布上看不出来，却足以让依赖它的 effect 反复重跑。
 */
export function fitScale(clientWidth: number, pageWidth: number): number | null {
  const usable = clientWidth - STAGE_PADDING;
  if (usable <= 0 || pageWidth <= 0) return null;
  return Number((usable / pageWidth).toFixed(3));
}

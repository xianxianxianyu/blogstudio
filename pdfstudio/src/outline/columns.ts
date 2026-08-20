/**
 * 从**墨迹密度剖面**找分栏位置。
 *
 * 扫描版的目录页没有文本层，「先左栏再右栏」这件事没有任何结构信息可依——实测本地
 * 引擎（以及云端）都把双栏目录一行左一行右地交错读出来，而**乱序的目录比没有目录
 * 更糟：它看着是对的**。
 *
 * 提示词里写「先整列左栏再整列右栏」不管用（试过）。所以在图上解决：把整页竖切成
 * 两条，各认各的，顺序天然就对。
 *
 * 这一层只做判定，不碰像素——剖面怎么算是调用方的事（`toc-scan.ts`）。
 */

/** 栏间那条白带至少要占整幅宽度的多少，才算是分栏而不是字距。 */
const MIN_GUTTER = 0.015;
/** 只在中间这一段里找。页面左右两侧的页边距同样是空白，不排除掉必然误判。 */
const SEARCH_FROM = 0.3;
const SEARCH_TO = 0.7;
/** 低于「最浓的那一列」的这个比例就算空白。不取绝对零：扫描件的栏缝里总有噪点。 */
const BLANK_RATIO = 0.04;

/**
 * @param density 每一列（x）的墨迹量，从左到右。长度就是图的宽度（或按比例采样）。
 * @returns 切分位置（下标）。空数组 = 单栏。**目前最多切一刀**——目录页是一栏或两栏，
 *   三栏没见过，而多支持一种没见过的形态就是多一条没测过的路。
 */
export function columnSplits(density: number[]): number[] {
  if (density.length === 0) return [];

  const peak = Math.max(...density);
  // 整页空白（全零）不是「一条很宽的栏缝」，是没有内容。不切。
  if (peak <= 0) return [];

  const blank = peak * BLANK_RATIO;
  const from = Math.floor(density.length * SEARCH_FROM);
  const to = Math.ceil(density.length * SEARCH_TO);

  // 中间段里最长的一条空白带。
  let best = { start: 0, length: 0 };
  let run = 0;
  for (let x = from; x < to; x++) {
    run = density[x] <= blank ? run + 1 : 0;
    if (run > best.length) best = { start: x - run + 1, length: run };
  }

  if (best.length < density.length * MIN_GUTTER) return [];
  // 切在白带正中：偏一边的话，字距大的那一栏最后一个字符可能被削掉半个。
  return [best.start + Math.floor(best.length / 2)];
}

/**
 * 把一轮的结果写成人一眼能看的一行。
 *
 * **这一层不认识 Loop 的领域类型**——只要三个数组，所以外壳照旧不持有那边的状态。
 */

/**
 * 成绩单那一行。
 *
 * **有没成的就一定写出来。** 只报「10 件」的话，读者要点进去逐条数才知道少了两件，
 * 而这一列的用处恰恰是**不点进去就知道它还好不好**。
 *
 * 「没成」与「没轮到」分开说：前者说明这条路走不通，后者只说明预算不够，下一轮加点
 * 钱就能拿到（`.scratch/loop/spec.md` §1.3）。
 */
export function tallyOf(run: { done: string[]; failed: string[]; skipped: string[] }): string {
  const { done, failed, skipped } = run;
  if (done.length + failed.length + skipped.length === 0) return "没排出任务";
  if (failed.length === 0 && skipped.length === 0) return `${done.length} 件全成`;

  return [
    `${done.length} 成`,
    ...(failed.length > 0 ? [`${failed.length} 没成`] : []),
    ...(skipped.length > 0 ? [`${skipped.length} 没轮到`] : []),
  ].join(" · ");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 多久以前。
 *
 * **`now` 跑到 `then` 前面时按「刚刚」算**，不说「-3 分钟前」。系统对时、跨时区、
 * 夏令时都会让这件事发生，而一个负数的时间差在界面上只会让人以为是坏了。
 */
export function agoOf(then: number, now: number): string {
  const gap = Math.max(0, now - then);
  if (gap < MINUTE) return "刚刚";
  if (gap < HOUR) return `${Math.floor(gap / MINUTE)} 分钟前`;
  if (gap < DAY) return `${Math.floor(gap / HOUR)} 小时前`;
  return `${Math.floor(gap / DAY)} 天前`;
}

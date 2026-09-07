/**
 * 这一刻该不该起一轮。
 *
 * **不用 cron 表达式。** DST 写在 `crontab(5)` 的 BUGS 段里，2015／2016／2019／2026
 * 四次跨库复发（`docs/research-loop-engineering.md`）。用间隔——「每 6 小时」这句话
 * 在任何时区、任何夏令时切换里都只有一个意思。
 */

export type Verdict =
  | "run"
  /** 还没到点。 */
  | "not-yet"
  /** 上一轮还在跑。**跳过这一次，不排队。** */
  | "still-running";

/** 上一轮的时间。`endedAt` 是 null 表示它还在跑（或者崩在半路，没人给它收尾）。 */
export type LastRun = { startedAt: number; endedAt: number | null };

/**
 * **从上一轮的「开始」算，不从「结束」算。** 「每 6 小时」这句话该是字面意思：
 * 一轮跑了 20 分钟还是 3 小时，下一轮都在同一个钟点上。从结束算的话，节奏会跟着
 * 每轮的时长漂——跑得越慢来得越晚，而人对「多久跑一次」的预期不会跟着漂。
 *
 * 撞上的话由 `still-running` 挡住，所以从开始算不会导致两轮叠在一起。
 *
 * **错过的不补。** 判据里只有「上一轮」，没有「错过了几次」——所以关机三天回来
 * 只跑一次，不是跑十二次。真需要补，那是「还差什么」，是下一轮自己该看的事，
 * 不是十二次没赴的约。
 */
export const due = (everyMs: number, last: LastRun | null, now: number): Verdict =>
  last === null
    ? // 一次都没跑过就跑。刚建完项目的人想看见它动，而不是等六个小时。
      "run"
    : last.endedAt === null
      ? "still-running"
      : now - last.startedAt >= everyMs
        ? "run"
        : "not-yet";

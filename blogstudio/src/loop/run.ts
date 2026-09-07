/**
 * 一次 run 的状态机。
 *
 * 三个阶段是**固定**的：plan → work → wrap。没有边、没有分支、没有条件。
 * 现在不需要图模型，等真的出现第四种形状再谈（`.scratch/loop/spec.md` §0）。
 */

export type Phase = "plan" | "work" | "wrap";

export type Run = {
  /** 第几次。人看到的是这个数，不是 uuid。 */
  n: number;
  phase: Phase;
  /** 阶段① 排下来的全部 task id。 */
  tasks: string[];
  done: string[];
  failed: string[];
  /**
   * 没轮到的。**与 failed 分开记。**
   *
   * 「试了没成」和「预算用光没轮到」对读者是两件事：前者说明这条路走不通，后者
   * 只说明钱不够——下一轮加点预算就能拿到。混成一格，最终 report 就再也分不出来。
   */
  skipped: string[];
};

export type Event =
  | { type: "planned"; tasks: string[] }
  | { type: "task-done"; id: string; report: string }
  | { type: "task-failed"; id: string; why: string }
  | { type: "budget-exhausted" };

export const startRun = (n: number): Run => ({ n, phase: "plan", tasks: [], done: [], failed: [], skipped: [] });

/**
 * 全部 task 都落定了就进收口。
 *
 * **落定包括失败的。** 一个 task 失败不拖垮整轮——那正是 fan-out 的意义：十二件事里
 * 有一件够不着，剩下十一件的成果不该跟着一起丢。失败会被带进阶段③，由最终 report
 * 如实写出来（spec §1.2）。
 */
const settle = (run: Run): Run =>
  run.done.length + run.failed.length === run.tasks.length ? { ...run, phase: "wrap" } : run;

/**
 * 这个 task 的结果是不是已经收到过了。
 *
 * 重试会把同一份结果送达两次（§4：`maxRetries` 默认 2，Anthropic 没有 idempotency key）。
 * 不去重的话「落定数」会虚高，整轮**提前收口**——最终 report 少一个 task，而且
 * 少了这件事在报告里看不出来。所以第二次送达一律丢弃：先到的算数。
 */
const settled = (run: Run, id: string): boolean => run.done.includes(id) || run.failed.includes(id);

/**
 * 这个结果该不该认。
 *
 * 只认 plan 里排过的 id：恢复时（§4）会去读 run 目录里的文件，上一版计划残留下来的
 * report 也在那儿。认下它，落定数就会凑够，整轮**提前收口**——跟重复送达是同一个后果。
 */
const counts = (run: Run, id: string): boolean => run.tasks.includes(id) && !settled(run, id);

/**
 * 用查表而不是 switch：漏掉一种事件是**编译错误**，不是运行时悄悄什么都不做。
 */
const STEPS: { [K in Event["type"]]: (run: Run, event: Extract<Event, { type: K }>) => Run } = {
  // 排出 0 个也走 `settle`：没有任何 task 要等，此刻就是收口——否则这一轮永远停在
  // `work`，时间线上像是一轮跑到一半没人管的。
  planned: (run, event) => settle({ ...run, phase: "work", tasks: event.tasks }),
  "task-done": (run, event) =>
    counts(run, event.id) ? settle({ ...run, done: [...run.done, event.id] }) : run,
  "task-failed": (run, event) =>
    counts(run, event.id) ? settle({ ...run, failed: [...run.failed, event.id] }) : run,
  // **就地收口，不是作废。** 已完成的 report 是已经付过费的产出，不能因为后面没钱了
  // 就跟着丢——那等于把钱花了又把东西扔了。
  "budget-exhausted": (run) => ({
    ...run,
    phase: "wrap",
    skipped: run.tasks.filter((id) => !settled(run, id)),
  }),
};

export const advance = (run: Run, event: Event): Run =>
  (STEPS[event.type] as (run: Run, event: Event) => Run)(run, event);

import { reserve } from "./budget";
import type { LoopStore, RunRecord } from "./loop-store";
import { advance, startRun } from "./run";
import { checkTask, readTask, type Task } from "./task";

/**
 * 一轮 = 三个固定的阶段：plan → work → wrap。
 *
 * 没有图、没有边、没有条件分支（`.scratch/loop/spec.md` §0）。
 */
export interface LoopAgents {
  /** 阶段①：根据 prompt 写 tasks。返回的是一组**完整的 task 文件**。 */
  plan(prompt: string): Promise<string[]>;
  /**
   * 阶段②：一个 subagent 干一个 task。
   *
   * **参数只有那一个文件。** 别的 task、planner 的推理、以前的 run、任何对话历史都不给
   * ——不是省事，是 §1.1 那条硬规则：看得见别的 task 的 worker 会去协调而不是干活。
   * 这个签名就是那条规则本身。
   */
  work(taskSource: string): Promise<{ report: string }>;
  /** 阶段③：根据 prompt 把所有 report 整理成一份。 */
  wrap(prompt: string, input: WrapInput): Promise<{ report: string }>;
}

export type WrapInput = {
  reports: { id: string; title: string; report: string }[];
  /**
   * 没成的那些，**连同原因一起交给阶段③**。
   *
   * 不交，最终报告就只是把成功的那几份整理一下——一份看起来完整、实际有洞的报告，
   * 而读者没有任何办法发现那个洞（§1.2）。这比少交一份更糟。
   */
  failed: { id: string; why: string }[];
  /**
   * 钱不够、没轮到的那些。**与 failed 分开**（§1.3）——「试了没成」说明这条路走不通，
   * 「没轮到」只说明预算不够，下一轮加点钱就能拿到。混成一格就再也分不出来了。
   */
  skipped: { id: string; title: string }[];
};

export type LoopConfig = {
  project: string;
  planPrompt: string;
  wrapPrompt: string;
  caps: { runUsd: number };
  /** 用的哪个模型。只为写进 `intent.json`——人事后要靠它认出这笔钱花在哪儿。 */
  model: string;
};

/** 报错里那句人话。整条链的处理在外面（`errorChain`），这里只要一句能写进报告的。 */
const errorOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 一个 task 的下场：要么有产出，要么有原因。**没有第三种。** */
type Settled = { task: Task; report: string } | { task: Task; why: string };

export function createRunner(store: LoopStore, agents: LoopAgents) {
  return {
    async tick(config: LoopConfig, n: number, now: number): Promise<RunRecord> {
      const { project } = config;
      // **先看这一轮跑没跑过。** 跑过的轮次号再跑一遍就是把已经付过的钱再付一遍，
      // 而「上一次到底跑到哪儿了」在原理上说不准（§4）——所以这里不猜，直接拒绝。
      if ((await store.runs(project)).some((one) => one.n === n)) {
        throw new Error(`第 ${n} 轮已经跑过了，不能再跑一遍——它可能已经付过钱了`);
      }

      const sources = await agents.plan(config.planPrompt);
      // **挡在花钱之前。** 一份不自包含的 task 发出去，subagent 会把缺的那部分自己编
      // 一个，然后交回一份看着很像样的东西——那比空手而归难发现得多。
      const read = sources.map((source, index) => ({
        source,
        // 位置是永远拿得到的名字。坏掉的 task 可能连 id 都没有，而这一格必须有东西
        // 填——一个没名字的失败在报告里就是一句「有个任务没成」，等于没说。
        label: `#${index + 1}`,
        task: readTask(source),
      }));
      const tasks = read.filter((one): one is typeof one & { task: Task } => one.task !== null);
      const rejected = read
        .filter((one) => one.task === null)
        .map((one) => ({
          id: one.label,
          why: checkTask(one.source)
            .map((problem) =>
              problem.kind === "not-self-contained"
                ? `任务写得不自包含：${problem.detail}`
                : `任务缺了 ${problem.detail}`,
            )
            .join("；"),
        }));

      // **派发之前先划钱。** 按上限预留而不是看已花多少——并行时钱是响应回来才知道的，
      // 那时请求已经全飞出去了（`budget.ts`）。
      let reserved = 0;
      const sending: typeof tasks = [];
      const skipped: Task[] = [];
      for (const one of tasks) {
        const verdict = reserve(config.caps.runUsd, reserved, one.task.budgetUsd);
        reserved = verdict.reserved;
        if (verdict.send) sending.push(one);
        else skipped.push(one.task);
      }

      await store.savePlan(
        project,
        n,
        [
          `# 第 ${n} 轮的计划`,
          "",
          ...read.map((one) =>
            one.task ? `- ${one.label} ${one.task.title}（上限 $${one.task.budgetUsd}）` : `- ${one.label} **没通过校验，没发出去**`,
          ),
          "",
        ].join("\n"),
      );

      let run = advance(startRun(n), {
        type: "planned",
        tasks: [...tasks.map((one) => one.task.id), ...rejected.map((one) => one.id)],
      });
      for (const one of rejected) {
        run = advance(run, { type: "task-failed", id: one.id, why: one.why });
      }

      /**
       * **一件都没排出来就不调收口。**
       *
       * 阶段③ 是一次模型调用。拿着「0 件事」去写简报，是花钱产出一句「本轮没有事项」
       * ——实际发生过（run 0001）。spec §5 说健康的 loop 大多数时候该无聊且极便宜，
       * 这一轮的账就该是 0。
       */
      if (run.tasks.length === 0) {
        await store.saveReport(project, n, "这一轮没有排出任务。");
        const record: RunRecord = { ...run, startedAt: now, endedAt: now, capUsd: 0 };
        await store.saveRun(project, record);
        return record;
      }

      // **一个 task 一个 subagent，同时跑。** 串行的话十二件事要排队等最慢的那一件，
      // 而它们之间本来就没有依赖——有依赖就说明 task 没写自包含。
      const settled = await Promise.all(
        sending.map(async ({ source, task }): Promise<Settled> => {
          try {
            // 意图写在调用之前。从这一刻起这笔钱有可能已经花出去了（§4）。
            // 原文先落盘，再落意图，最后才调模型。顺序就是「事后能查到什么」的顺序。
            await store.saveTaskFile(project, n, task.id, source);
            await store.beginTask(project, n, task.id, { model: config.model, capUsd: task.budgetUsd });
            const { report } = await agents.work(source);
            await store.finishTask(project, n, task.id, report);
            return { task, report };
          } catch (cause) {
            // **接住，不往上抛。** 一个 task 挂了就让整轮炸掉的话，别的十一件已经付过费
            // 的产出会跟着一起丢——钱花了，东西没了。
            return { task, why: errorOf(cause) };
          }
        }),
      );
      const results = settled.filter((one): one is Extract<Settled, { report: string }> => "report" in one);

      for (const one of settled) {
        if ("report" in one) {
          run = advance(run, { type: "task-done", id: one.task.id, report: one.report });
        } else {
          run = advance(run, { type: "task-failed", id: one.task.id, why: one.why });
        }
      }

      // 钱不够没派出去的，就地记一格。它们没有 report，也没有失败原因。
      if (skipped.length > 0) run = advance(run, { type: "budget-exhausted" });

      // **收口之前先把成绩单落下。** 阶段③ 挂掉是常事（它要读全部 report，是这一轮
      // 里最长的一次调用）。不先落的话，一轮已经付过钱、产出也都在磁盘上的 run，
      // 在时间线上凭空消失——人只会以为「今天没跑」。
      await store.saveRun(project, { ...run, startedAt: now, endedAt: null, capUsd: reserved });

      const wrapped = await agents.wrap(config.wrapPrompt, {
        reports: results.map((one) => ({ id: one.task.id, title: one.task.title, report: one.report })),
        failed: [
          ...rejected,
          ...settled.flatMap((one) => ("why" in one ? [{ id: one.task.id, why: one.why }] : [])),
        ],
        skipped: skipped.map((one) => ({ id: one.id, title: one.title })),
      });
      await store.saveReport(project, n, wrapped.report);

      const record: RunRecord = { ...run, startedAt: now, endedAt: now, capUsd: reserved };
      await store.saveRun(project, record);
      return record;
    },
  };
}

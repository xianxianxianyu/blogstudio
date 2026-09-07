import type { LoopSettings } from "./loop-config";
import type { LoopStore } from "./loop-store";
import { createRunner, type LoopAgents } from "./runner";
import { due } from "./schedule";

/**
 * 把到点的项目各跑一轮。
 *
 * 这是「定时启动」那一半：外面某个心跳按固定节奏叫它，它自己判断谁该跑。
 * **心跳快慢不影响结果**——该不该跑由 `due` 按上一轮的时间算，叫得勤只是多问几次。
 */
export async function sweep(
  store: LoopStore,
  /**
   * 按项目建 agent，**不是全局一个**。
   *
   * 每个项目的 task 上限写在它自己的 `loop.md` 里。共用一份的话，上限紧的那个项目
   * 会按别人的数字派 task——它自己那一栏就白写了。
   */
  agentsFor: (settings: LoopSettings) => LoopAgents,
  now: number,
): Promise<{ project: string; n: number }[]> {
  const started: { project: string; n: number }[] = [];

  for (const project of await store.projects()) {
    // **关着的一轮都不跑。** 这是人明确关掉的，不是出了错——所以连配置都不必读。
    if (!(await store.enabled(project))) continue;

    // **一个项目的错字不该让全部停摆。** 配置读不出来就跳过它——别的项目是无辜的。
    const settings = await store.settings(project);
    if (settings === null) continue;

    const runs = await store.runs(project);
    const last = runs[0] ?? null;
    if (due(settings.everyMs, last, now) !== "run") continue;

    // 轮次一直往下数。**不复用号**——一个号只对应一次真实发生过的事，
    // 复用了的话磁盘上那一轮的产物会被下一轮盖掉。
    const n = (last?.n ?? 0) + 1;
    await createRunner(store, agentsFor(settings)).tick(
      {
        project,
        planPrompt: settings.planPrompt,
        wrapPrompt: settings.wrapPrompt,
        caps: { runUsd: settings.runCapUsd },
      },
      n,
      now,
    );
    started.push({ project, n });
  }

  return started;
}

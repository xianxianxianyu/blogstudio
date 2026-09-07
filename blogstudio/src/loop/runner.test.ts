import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLoopStore } from "./loop-store";
import { createRunner, type LoopAgents, type LoopConfig } from "./runner";

const root = () => mkdtemp(path.join(tmpdir(), "loop-"));

const task = (id: string, body: string, budgetUsd = 0.3) =>
  `---\n${JSON.stringify({ id, title: `第 ${id} 件`, budget_usd: budgetUsd }, null, 2)}\n---\n\n${body}`;

const CONFIG: LoopConfig = {
  project: "研究 KV cache",
  planPrompt: "把这周该查的事排成任务",
  wrapPrompt: "整理成一份周报",
  caps: { runUsd: 5 },
  model: "opus",
};

/** 三个阶段的替身。每一阶段被喂了什么，都留在 `seen` 里。 */
function fakeAgents(over: Partial<LoopAgents> = {}) {
  const seen = { planned: [] as string[], worked: [] as string[], wrapped: [] as unknown[] };
  const agents: LoopAgents = {
    async plan(prompt) {
      seen.planned.push(prompt);
      return [task("01", "查 A"), task("02", "查 B")];
    },
    async work(source) {
      seen.worked.push(source);
      return { report: `# ${source.includes("查 A") ? "A" : "B"} 的结果` };
    },
    async wrap(prompt, input) {
      seen.wrapped.push(input);
      return { report: "# 周报" };
    },
    ...over,
  };
  return { agents, seen };
}

describe("三个阶段跑一轮", () => {
  it("排任务 → 各自干 → 收口，产物全部落盘", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    const { agents, seen } = fakeAgents();

    const run = await createRunner(store, agents).tick(CONFIG, 9, 1000);

    expect(seen.planned).toEqual(["把这周该查的事排成任务"]);
    expect(seen.worked).toHaveLength(2);
    expect(run.phase).toBe("wrap");
    expect(run.done).toEqual(["01", "02"]);

    const at = path.join(dir, "研究 KV cache", "runs", "0009");
    expect(await readFile(path.join(at, "report.md"), "utf8")).toBe("# 周报");
    expect(await readFile(path.join(at, "tasks", "01.report.md"), "utf8")).toBe("# A 的结果");
  });

  it("**一件都没排出来，收口那一步不调模型**——这一轮的账是 0", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    const { agents, seen } = fakeAgents({ plan: async () => [] });

    const run = await createRunner(store, agents).tick(CONFIG, 9, 1000);

    expect(seen.wrapped).toEqual([]);
    expect(run.phase).toBe("wrap");
    expect(run.endedAt).toBe(1000);
    expect(run.capUsd).toBe(0);
    // 时间线上还是要看得见这一轮，报告要说清楚它为什么是空的。
    const at = path.join(dir, "研究 KV cache", "runs", "0009");
    expect(await readFile(path.join(at, "report.md"), "utf8")).toContain("没有排出任务");
  });

  it("**planner 写出不自包含的 task，不发给 subagent**——一分钱都不花", async () => {
    const store = createLoopStore(await root());
    const { agents, seen } = fakeAgents({
      async plan() {
        return [task("01", "查 A"), task("02", "把上一个任务查到的按主题分组")];
      },
    });

    const run = await createRunner(store, agents).tick(CONFIG, 9, 1000);

    // 只有 01 发出去了。02 在花钱之前就被挡下——subagent 看不到「上一个任务」，
    // 它会自己编一个，然后交回一份看着很像样的东西。
    expect(seen.worked).toHaveLength(1);
    expect(run.done).toEqual(["01"]);
    expect(run.failed).toEqual(["#2"]);
  });

  it("挡下来的 task **要写进最终报告**——不然这一轮少了一件事，读者看不出来", async () => {
    const store = createLoopStore(await root());
    const { agents, seen } = fakeAgents({
      async plan() {
        return [task("01", "查 A"), task("02", "把上一个任务查到的按主题分组")];
      },
    });

    await createRunner(store, agents).tick(CONFIG, 9, 1000);

    expect(seen.wrapped[0]).toMatchObject({
      failed: [{ id: "#2", why: "任务写得不自包含：上一个任务" }],
    });
  });

  it("**一个 subagent 挂了，别的照跑到底**——那正是 fan-out 的意义", async () => {
    const store = createLoopStore(await root());
    const { agents, seen } = fakeAgents({
      async work(source) {
        if (source.includes("查 B")) throw new Error("端点不通");
        return { report: "# A 的结果" };
      },
    });

    const run = await createRunner(store, agents).tick(CONFIG, 9, 1000);

    expect(run.done).toEqual(["01"]);
    expect(run.failed).toEqual(["02"]);
    // 01 那份 report 已经付过费了，不能因为 02 挂了就跟着丢。
    expect(seen.wrapped[0]).toMatchObject({
      reports: [{ id: "01", report: "# A 的结果" }],
      failed: [{ id: "02", why: "端点不通" }],
    });
  });

  it("整轮预算装不下的 task **不派出去**，而且记成「没轮到」不是「失败」", async () => {
    const store = createLoopStore(await root());
    const { agents, seen } = fakeAgents({
      async plan() {
        return [task("01", "查 A"), task("02", "查 B"), task("03", "查 C")];
      },
    });
    // 整轮 0.5，每个 task 上限 0.3：只装得下一个。
    const config = { ...CONFIG, caps: { runUsd: 0.5 } };

    const run = await createRunner(store, agents).tick(config, 9, 1000);

    expect(seen.worked).toHaveLength(1);
    expect(run.done).toEqual(["01"]);
    // 02、03 不是「试了没成」，是「钱不够没轮到」——下一轮加点预算就能拿到，
    // 这跟「这条路走不通」是完全不同的两件事（spec §1.3）。
    expect(run.skipped).toEqual(["02", "03"]);
    expect(run.failed).toEqual([]);
    expect(seen.wrapped[0]).toMatchObject({ skipped: [{ id: "02" }, { id: "03" }] });
  });

  it("**收口那一步挂了，前面的产出全部留着**，而且这一轮在时间线上看得见", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    const { agents } = fakeAgents({
      async wrap() {
        throw new Error("电脑睡过去了");
      },
    });

    await expect(createRunner(store, agents).tick(CONFIG, 9, 1000)).rejects.toThrow();

    // 两份 report 都是已经付过费的产出，不能因为收口失败就跟着丢。
    const at = path.join(dir, "研究 KV cache", "runs", "0009", "tasks");
    expect(await readFile(path.join(at, "01.report.md"), "utf8")).toBe("# A 的结果");
    // 而且这一轮必须在时间线上看得见——不落成绩单的话，一轮花过钱的 run 凭空消失。
    expect((await store.runs("研究 KV cache")).map((r) => r.n)).toEqual([9]);
  });

  it("**跑过的轮次号不许再跑一遍**——那一轮可能已经付过钱了", async () => {
    const store = createLoopStore(await root());
    const { agents, seen } = fakeAgents();
    const runner = createRunner(store, agents);
    await runner.tick(CONFIG, 9, 1000);
    seen.worked.length = 0;

    await expect(runner.tick(CONFIG, 9, 2000)).rejects.toThrow(/第 9 轮/);
    // 一次都没重跑。静默重跑 = 把已经付过的钱再付一遍（§4）。
    expect(seen.worked).toEqual([]);
  });

  it("**发出去的 task 原文要落盘**——不然事后没人知道当时让 subagent 干的是什么", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();

    await createRunner(store, agents).tick(CONFIG, 9, 1000);

    const at = path.join(dir, "研究 KV cache", "runs", "0009", "tasks", "01.task.md");
    // 一字不差就是发给 subagent 的那份。report 读着不对劲时，能对回来的只有它。
    expect(await readFile(at, "utf8")).toBe(task("01", "查 A"));
  });

  it("阶段① 排出来的计划也落盘——task 从哪儿来的，得看得见", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();

    await createRunner(store, agents).tick(CONFIG, 9, 1000);

    const at = path.join(dir, "研究 KV cache", "runs", "0009", "plan.md");
    expect(await readFile(at, "utf8")).toContain("第 01 件");
  });
});

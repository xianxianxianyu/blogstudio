import { describe, expect, it } from "vitest";
import { advance, startRun, type Run } from "./run";

/** 阶段① 产出的三个 task，还没人跑。 */
const planned = (): Run => advance(startRun(9), { type: "planned", tasks: ["01", "02", "03"] });

describe("一次 run 的状态机", () => {
  it("刚开始时在 plan 阶段，还没有 task", () => {
    const run = startRun(9);

    expect(run.phase).toBe("plan");
    expect(run.tasks).toEqual([]);
  });

  it("排完 task 就进 work，没落定完就一直待在 work", () => {
    let run = planned();
    expect(run.phase).toBe("work");

    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    run = advance(run, { type: "task-done", id: "02", report: "r2" });

    // 还剩 03 没回来。此刻收口就会拿着不全的 report 去写最终报告。
    expect(run.phase).toBe("work");
  });

  it("排出 0 个 task 就直接收口，不停在 work", () => {
    const run = advance(startRun(9), { type: "planned", tasks: [] });
    expect(run.phase).toBe("wrap");
  });

  it("**一个 task 失败不拖垮整轮**——那正是 fan-out 的意义", () => {
    let run = planned();
    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    run = advance(run, { type: "task-failed", id: "02", why: "端点不通" });
    run = advance(run, { type: "task-done", id: "03", report: "r3" });

    // 全部落定了就进收口，而不是因为有一个失败就整轮作废。
    expect(run.phase).toBe("wrap");
    expect(run.failed).toEqual(["02"]);
  });

  it("同一个 task 的结果被送达两次，不会让整轮提前收口", () => {
    let run = planned();
    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    // 重试送了第二遍。§4：`maxRetries` 默认 2，而 Anthropic 没有 idempotency key。
    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    run = advance(run, { type: "task-failed", id: "02", why: "端点不通" });

    // 03 根本还没跑。此刻收口，最终 report 会漏掉 03——**而且读者看不出来**。
    expect(run.phase).toBe("work");
    expect(run.done).toEqual(["01"]);
  });

  it("plan 里没有的 task 送来结果，一概不认", () => {
    let run = planned();
    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    // 上一版计划残留在同一个 run 目录里的 report（§4 的恢复路径会读到它）。
    run = advance(run, { type: "task-done", id: "07", report: "旧的" });
    run = advance(run, { type: "task-done", id: "02", report: "r2" });

    // 03 还没跑。认下 07 的话，落定数刚好凑够 3，整轮就此提前收口。
    expect(run.phase).toBe("work");
    expect(run.done).toEqual(["01", "02"]);
  });

  it("已经记成失败的 task，迟到的成功不翻案", () => {
    let run = planned();
    run = advance(run, { type: "task-failed", id: "01", why: "进程没了" });
    // worker 其实写完 report 才崩的，恢复时又读到了那份 report（§4 那个窗口）。
    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    run = advance(run, { type: "task-done", id: "02", report: "r2" });
    run = advance(run, { type: "task-done", id: "03", report: "r3" });

    // 认下翻案，01 就同时算在失败和完成里，落定数超过 3——这一轮永远收不了口。
    expect(run.phase).toBe("wrap");
    expect(run.done).toEqual(["02", "03"]);
    expect(run.failed).toEqual(["01"]);
  });

  it("预算用光就地收口：已完成的留着，没跑的**单独记一格**", () => {
    let run = planned();
    run = advance(run, { type: "task-done", id: "01", report: "r1" });
    run = advance(run, { type: "task-failed", id: "02", why: "端点不通" });
    run = advance(run, { type: "budget-exhausted" });

    expect(run.phase).toBe("wrap");
    // 01 的 report 不能因为后面没钱了就跟着丢——那是已经付过费的产出。
    expect(run.done).toEqual(["01"]);
    // 02 是真的试过没成，这一格也要留着——它和 03 的原因完全不同。
    expect(run.failed).toEqual(["02"]);
    // 03 不是「失败」，它压根没跑。混进 failed 里，最终 report 就会把「试了没成」
    // 和「没轮到」说成同一件事，而这两件事对读者的意思完全不同。
    expect(run.skipped).toEqual(["03"]);
  });
});

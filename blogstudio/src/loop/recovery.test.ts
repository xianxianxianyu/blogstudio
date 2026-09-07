import { describe, expect, it } from "vitest";
import { recover } from "./recovery";

const TASKS = ["01", "02", "03"];

describe("崩溃之后，每个 task 各自是什么处境", () => {
  it("什么都没留下的，可以放心跑", () => {
    expect(recover(TASKS, ["01.task.md", "02.task.md", "03.task.md"])).toEqual([
      { id: "01", state: "not-started" },
      { id: "02", state: "not-started" },
      { id: "03", state: "not-started" },
    ]);
  });

  it("report 在，就是干完了——再跑一遍是白花钱", () => {
    const files = ["01.task.md", "01.intent.json", "01.report.md"];

    expect(recover(["01"], files)).toEqual([{ id: "01", state: "done" }]);
  });

  it("**有 intent 没 report：可能已经花过钱，必须问人**", () => {
    // 意图写在调用之前，所以这个窗口里的 task 有可能已经付过费了——而
    // 「到底成没成功」在原理上无法确定（spec §4）。这里**不能有默认行为**：
    // 默认重跑 = 可能付两次；默认跳过 = 可能丢掉真的干完的活。
    const files = ["01.task.md", "01.intent.json"];

    expect(recover(["01"], files)).toEqual([{ id: "01", state: "maybe-charged" }]);
  });
});

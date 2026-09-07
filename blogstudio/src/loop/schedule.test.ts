import { describe, expect, it } from "vitest";
import { due } from "./schedule";

const HOUR = 3600_000;
/** 每 6 小时一轮。 */
const EVERY = 6 * HOUR;

describe("这一刻该不该起一轮", () => {
  it("一次都没跑过就跑——刚建完项目的人想看见它动", () => {
    expect(due(EVERY, null, 1000)).toBe("run");
  });

  it("上一轮跑完了，还没到点", () => {
    const last = { startedAt: 0, endedAt: 1000 };

    expect(due(EVERY, last, 5 * HOUR)).toBe("not-yet");
  });

  it("上一轮跑完了，到点了", () => {
    const last = { startedAt: 0, endedAt: 1000 };

    expect(due(EVERY, last, 6 * HOUR)).toBe("run");
  });

  it("**上一轮还没跑完就跳过这一次**——不排队、不并行", () => {
    // Windows 任务计划程序默认 `IgnoreNew`、Temporal 默认 `Skip`，两个毫无交集的
    // 系统同一个默认。排队的话，一轮卡住会攒出一串，等它一通就全炸出来。
    const running = { startedAt: 0, endedAt: null };

    expect(due(EVERY, running, 100 * HOUR)).toBe("still-running");
  });

  it("**错过的不补跑**——关机三天，开机只跑一次，不是跑十二次", () => {
    // 「还差什么」是下一轮自己该看的事，不是「错过了十二次约会」要一次次补上。
    expect(due(EVERY, { startedAt: 0, endedAt: 1000 }, 72 * HOUR)).toBe("run");

    // 跑完这一次，立刻再问：**不该还欠着十一次**。判据里只有「上一轮」，
    // 没有「错过了几次」，所以攒不出积压来。
    const after = { startedAt: 72 * HOUR, endedAt: 72 * HOUR + 1000 };
    expect(due(EVERY, after, 72 * HOUR + 2000)).toBe("not-yet");
  });
});

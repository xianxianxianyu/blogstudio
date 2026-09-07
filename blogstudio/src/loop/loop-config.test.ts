import { describe, expect, it } from "vitest";
import { readConfig } from "./loop-config";

const FILE = `---
{ "everyHours": 6, "runCapUsd": 3, "taskCapUsd": 0.4 }
---

## 排任务

看看这周 KV cache 那条线上有什么新东西，排成几件互不依赖的事。
每件都要写全背景——干活的人看不到别的任务。

## 收口

把各件的结果整理成一份周报，重复的合并，没找到的也要写出来。
`;

describe("读一个 loop 项目的配置", () => {
  it("间隔、预算、两段 prompt 各自读出来", () => {
    expect(readConfig(FILE)).toEqual({
      everyMs: 6 * 3600_000,
      runCapUsd: 3,
      taskCapUsd: 0.4,
      planPrompt:
        "看看这周 KV cache 那条线上有什么新东西，排成几件互不依赖的事。\n每件都要写全背景——干活的人看不到别的任务。",
      wrapPrompt: "把各件的结果整理成一份周报，重复的合并，没找到的也要写出来。",
    });
  });

  it("**少一段 prompt 就整个不认**——空 prompt 会让 agent 自己发挥，然后花钱", () => {
    const missing = FILE.slice(0, FILE.indexOf("## 收口"));

    expect(readConfig(missing)).toBe(null);
  });

  it("间隔缺了也不认——一个不知道多久跑一次的 loop 没法定时", () => {
    expect(readConfig(FILE.replace('"everyHours": 6, ', ""))).toBe(null);
  });

  it("**两段颠倒就不认**——按位置切会把两段切反，而切反之后两段都还是非空的", () => {
    const swapped = `---
{ "everyHours": 6, "runCapUsd": 3, "taskCapUsd": 0.4 }
---

## 收口

整理成周报。

## 排任务

排成几件事。
`;

    // 不挡的话，它会拿着「整理成周报」去排任务、拿着「排成几件事」去收口，
    // 然后**安安静静地跑完**——两份产物都在，只是全错。
    expect(readConfig(swapped)).toBe(null);
  });

  it("标题在、底下没字，也不认", () => {
    expect(readConfig(FILE.replace("整理成周报。", "").replace(/把各件的结果[\s\S]*/, ""))).toBe(null);
    expect(readConfig(FILE.replace(/看看这周[\s\S]*?看不到别的任务。/, ""))).toBe(null);
  });

  it("缺「收口」这个标题就不认，哪怕排任务那段写得好好的", () => {
    const noWrap = FILE.replace("## 收口", "## 总结一下");

    expect(readConfig(noWrap)).toBe(null);
  });

  it("间隔是 0 不算填了——那意味着一跑完立刻再跑，没有间隔可言", () => {
    expect(readConfig(FILE.replace('"everyHours": 6', '"everyHours": 0'))).toBe(null);
  });

  it("**没有整轮预算上限就不给跑**——那是一张空白支票", () => {
    expect(readConfig(FILE.replace(', "runCapUsd": 3', ""))).toBe(null);
    expect(readConfig(FILE.replace('"runCapUsd": 3', '"runCapUsd": 0'))).toBe(null);
  });

  it("**单个 task 的上限也要明写**——它跟整轮上限是两个不同的决定", () => {
    // 拿整轮上限除一除当默认值，是把一个策略藏进代码里：到底一轮排几件，
    // 只有写 prompt 的人知道。
    expect(readConfig(FILE.replace(', "taskCapUsd": 0.4', ""))).toBe(null);
    expect(readConfig(FILE.replace('"taskCapUsd": 0.4', '"taskCapUsd": 0'))).toBe(null);
  });

  it("单个 task 的上限比整轮还大，不给过——那等于整轮没有上限", () => {
    expect(readConfig(FILE.replace('"taskCapUsd": 0.4', '"taskCapUsd": 5'))).toBe(null);
  });

  it("两个上限**一样大是允许的**——一轮只排一件的项目就该这么写", () => {
    expect(readConfig(FILE.replace('"taskCapUsd": 0.4', '"taskCapUsd": 3'))).toMatchObject({
      runCapUsd: 3,
      taskCapUsd: 3,
    });
  });
});

import { describe, expect, it } from "vitest";
import { expired, parseTrashName, trashNameOf } from "./trash";

describe("trashNameOf / parseTrashName", () => {
  it("往返：起的名字自己认得回来", () => {
    const at = new Date(2026, 7, 30, 17, 50, 2).getTime();
    const name = trashNameOf("三样东西的样张", at);
    expect(name).toBe("20260830-175002-三样东西的样张.md");
    expect(parseTrashName(name)).toEqual({ slug: "三样东西的样张", at });
  });

  it("**slug 里本来就有短横也认得对**", () => {
    // `codex-he-cc------terminal` 这种名字满目录都是。按第一个短横切就全错了。
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const name = trashNameOf("codex-he-cc------terminal", at);
    expect(parseTrashName(name)?.slug).toBe("codex-he-cc------terminal");
  });

  it("**认不出时间的返回 null**——手放进去的文件不该被当成有时间戳", () => {
    expect(parseTrashName("我自己拖进来的.md")).toBeNull();
    expect(parseTrashName("20260830-三样东西.md")).toBeNull();
    expect(parseTrashName("不是md.txt")).toBeNull();
  });

  it("时间戳是**本地时间**，不是 UTC", () => {
    // 起名时用的是本地时间（`getFullYear` 那一套），读回来必须按同一套算，
    // 否则「几天前」会差上八小时，跨天时差一整天。
    const at = new Date(2026, 7, 30, 0, 30, 0).getTime();
    expect(parseTrashName(trashNameOf("x", at))?.at).toBe(at);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 30, 12, 0, 0).getTime();

describe("expired", () => {
  it("超过一个月的算过期", () => {
    expect(expired({ at: NOW - 31 * DAY }, NOW, 30)).toBe(true);
  });

  it("差一天不到就不算", () => {
    expect(expired({ at: NOW - 29 * DAY }, NOW, 30)).toBe(false);
    // 边界上那一天留着——**清东西的时候宁可晚一天**。
    expect(expired({ at: NOW - 30 * DAY }, NOW, 30)).toBe(false);
  });

  it("**认不出时间的永远不清**", () => {
    // 手拖进 .trash/ 的文件我们不知道它什么时候来的，猜一个日期然后删掉是最坏的做法。
    expect(expired({ at: null }, NOW, 30)).toBe(false);
  });

  it("时间在未来的也不清", () => {
    // 改过系统时间、或者手写了个名字。**不确定就别删。**
    expect(expired({ at: NOW + 5 * DAY }, NOW, 30)).toBe(false);
  });
});

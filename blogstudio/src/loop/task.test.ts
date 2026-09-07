import { describe, expect, it } from "vitest";
import { checkTask, readTask } from "./task";

const file = (front: object, body: string) =>
  `---\n${JSON.stringify(front, null, 2)}\n---\n\n${body}`;

const GOOD = file(
  { id: "03", title: "扫 arXiv 上的 KV cache 新论文", budget_usd: 0.3 },
  "查 2026-08 之后 cs.LG 里提到 KV cache 压缩的论文，每条给出标题、arXiv id、一句话结论。\n没找到的也要写明。",
);

describe("task 自包含校验", () => {
  it("该有的都有、正文不指望外部，就没有问题", () => {
    expect(checkTask(GOOD)).toEqual([]);
  });

  it("**指望别的 task** 就不算自包含——subagent 根本看不到那些", () => {
    const bad = file(
      { id: "04", title: "按主题给论文分组", budget_usd: 0.3 },
      "把上一个任务查到的论文按主题分组。",
    );

    expect(checkTask(bad)).toEqual([
      { kind: "not-self-contained", detail: "上一个任务" },
    ]);
  });

  it("**没有预算上限的 task 不给过**——那是一张空白支票", () => {
    const bad = file({ id: "05", title: "查一下这个" }, "查 2026 年 llama.cpp 的 KV cache 实现。");

    expect(checkTask(bad)).toEqual([{ kind: "missing", detail: "budget_usd" }]);
  });

  it("正文是空的，subagent 无事可做", () => {
    const bad = file({ id: "06", title: "查一下这个", budget_usd: 0.3 }, "   \n");

    expect(checkTask(bad)).toEqual([{ kind: "missing", detail: "正文" }]);
  });

  it("frontmatter 坏了就整个不认——**不猜**，猜错了会拿着半份任务去花钱", () => {
    expect(checkTask("---\n{ 这不是 JSON\n---\n\n查点东西。")).toEqual([
      { kind: "missing", detail: "frontmatter" },
    ]);
  });

  it("预算写 0 不算填了——那是想说「不限」，而「不限」正是这一栏要挡的", () => {
    const bad = file({ id: "07", title: "查一下这个", budget_usd: 0 }, "查点东西。");

    expect(checkTask(bad)).toEqual([{ kind: "missing", detail: "budget_usd" }]);
  });

  it("预算写成字符串不算填了——`\"0.3\" > 0.5` 在 JS 里不报错，只是算错", () => {
    const bad = file({ id: "08", title: "查一下这个", budget_usd: "0.3" }, "查点东西。");

    expect(checkTask(bad)).toEqual([{ kind: "missing", detail: "budget_usd" }]);
  });

  it("id 是空串不算填了——落盘时会写成 `.report.md`，跟别的 task 撞在一起", () => {
    const bad = file({ id: "", title: "查一下这个", budget_usd: 0.3 }, "查点东西。");

    expect(checkTask(bad)).toEqual([{ kind: "missing", detail: "id" }]);
  });

  it("悬空引用藏在**标题**里也算——subagent 一样看不到它指的东西", () => {
    const bad = file({ id: "09", title: "整理上一步的结果", budget_usd: 0.3 }, "按主题分组。");

    expect(checkTask(bad)).toEqual([{ kind: "not-self-contained", detail: "上一步" }]);
  });

  it("没有标题不算填了——时间线上那一行只剩一个 id，人认不出它是什么", () => {
    const bad = file({ id: "10", budget_usd: 0.3 }, "查点东西。");

    expect(checkTask(bad)).toEqual([{ kind: "missing", detail: "title" }]);
  });
});

describe("读一个 task", () => {
  it("读出 id、标题、预算和正文", () => {
    expect(readTask(GOOD)).toEqual({
      id: "03",
      title: "扫 arXiv 上的 KV cache 新论文",
      budgetUsd: 0.3,
      body: "查 2026-08 之后 cs.LG 里提到 KV cache 压缩的论文，每条给出标题、arXiv id、一句话结论。\n没找到的也要写明。",
    });
  });

  it("**校验不过的一律读不出来**——读得出来就意味着有人会拿它去花钱", () => {
    const bad = file({ id: "05", title: "查一下这个" }, "查点东西。");

    expect(readTask(bad)).toBe(null);
  });
});

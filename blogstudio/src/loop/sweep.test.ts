import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLoopStore } from "./loop-store";
import { sweep } from "./sweep";
import type { LoopAgents } from "./runner";

const root = () => mkdtemp(path.join(tmpdir(), "loop-"));
const HOUR = 3600_000;

const CONFIG = `---
{ "everyHours": 6, "runCapUsd": 3, "taskCapUsd": 0.4 }
---

## 排任务

排成几件互不依赖的事。

## 收口

整理成一份周报。
`;

async function project(dir: string, name: string, config = CONFIG) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "loop.md"), config, "utf8");
  await createLoopStore(dir).setEnabled(name, true);
}

const task = (id: string) =>
  `---\n${JSON.stringify({ id, title: `第 ${id} 件`, budget_usd: 0.3 }, null, 2)}\n---\n\n查 ${id}`;

function fakeAgents() {
  const seen: string[] = [];
  const agents: LoopAgents = {
    async plan(prompt) {
      seen.push(prompt);
      return [task("01")];
    },
    async work() {
      return { report: "# 结果" };
    },
    async wrap() {
      return { report: "# 周报" };
    },
  };
  return { agents, seen };
}

describe("到点了就把该跑的项目跑一遍", () => {
  it("一个从没跑过的项目，立刻起第 1 轮", async () => {
    const dir = await root();
    await project(dir, "研究 KV cache");
    const store = createLoopStore(dir);
    const { agents, seen } = fakeAgents();

    const done = await sweep(store, () => agents, 1000);

    expect(done).toEqual([{ project: "研究 KV cache", n: 1 }]);
    // 用的是配置里那段 prompt，不是别处来的。
    expect(seen).toEqual(["排成几件互不依赖的事。"]);
    expect((await store.runs("研究 KV cache")).map((r) => r.n)).toEqual([1]);
  });

  it("**轮次一直往下数**——第二次跑的是第 2 轮，不是又一次第 1 轮", async () => {
    const dir = await root();
    await project(dir, "p");
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();

    await sweep(store, () => agents, 1000);
    await sweep(store, () => agents, 1000 + 6 * HOUR);
    // 第三次：要接着第 2 轮往下数。看成最旧的那一轮的话会得出第 2 轮，
    // 而那一轮的产物已经在磁盘上了——盖掉它就是把付过钱的东西扔了。
    const done = await sweep(store, () => agents, 1000 + 12 * HOUR);

    expect(done).toEqual([{ project: "p", n: 3 }]);
  });

  it("没到点的项目不跑", async () => {
    const dir = await root();
    await project(dir, "p");
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();
    await sweep(store, () => agents, 1000);

    expect(await sweep(store, () => agents, 1000 + HOUR)).toEqual([]);
  });

  it("**配置坏掉的项目跳过，别的照跑**——一个项目的错字不该让全部停摆", async () => {
    const dir = await root();
    await project(dir, "坏的", "这不是配置");
    await project(dir, "好的");
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();

    expect(await sweep(store, () => agents, 1000)).toEqual([{ project: "好的", n: 1 }]);
  });

  it("**关着的项目一轮都不跑**，哪怕早就到点了", async () => {
    const dir = await root();
    await project(dir, "关着的");
    await createLoopStore(dir).setEnabled("关着的", false);
    await project(dir, "开着的");
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();

    expect(await sweep(store, () => agents, 1000)).toEqual([{ project: "开着的", n: 1 }]);
  });

  it("**每个项目用自己的那份配置建 agent**——两个项目的 task 上限不一样", async () => {
    const dir = await root();
    await project(dir, "阔的", CONFIG.replace('"taskCapUsd": 0.4', '"taskCapUsd": 1'));
    await project(dir, "紧的", CONFIG.replace('"taskCapUsd": 0.4', '"taskCapUsd": 0.1'));
    const store = createLoopStore(dir);
    const { agents } = fakeAgents();
    const caps: number[] = [];

    await sweep(
      store,
      (settings) => {
        caps.push(settings.taskCapUsd);
        return agents;
      },
      1000,
    );

    // 拿一份配置去跑所有项目的话，「紧的」那个会按 1 块的上限派 task——
    // 它自己那一栏写的 0.1 就白写了。
    expect(caps.sort()).toEqual([0.1, 1]);
  });
});

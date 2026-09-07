import { describe, expect, it } from "vitest";
import { createLoopAgents, type TextModel } from "./agents";
import { readTask } from "./task";

/** 只会照本宣科回答的模型。问了什么都留在 `asked` 里。 */
function fakeModel(reply: string | ((asked: string) => string)) {
  const asked: string[] = [];
  const model: TextModel = {
    async complete({ messages }) {
      const text = messages.map((one) => one.content).join("\n");
      asked.push(text);
      return { text: typeof reply === "function" ? reply(text) : reply };
    },
  };
  return { model, asked };
}

const TWO = `好的，我来排一下。

<task>
# 扫 arXiv 上的新论文

查 2026-08 之后 cs.LG 里提到 KV cache 压缩的，每条给出标题和结论。
</task>

<task>
# 看看 llama.cpp 那边

读最近三十个 commit，挑出跟 KV cache 有关的。
</task>
`;

describe("阶段①：把 prompt 变成一组 task", () => {
  it("切出两个 task，各自是一份能直接发出去的文件", async () => {
    const { model } = fakeModel(TWO);
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    const tasks = await agents.plan("排成几件互不依赖的事");

    expect(tasks).toHaveLength(2);
    expect(readTask(tasks[0])).toMatchObject({
      id: "01",
      title: "扫 arXiv 上的新论文",
      budgetUsd: 0.3,
      body: "查 2026-08 之后 cs.LG 里提到 KV cache 压缩的，每条给出标题和结论。",
    });
    expect(readTask(tasks[1])).toMatchObject({ id: "02", title: "看看 llama.cpp 那边" });
  });

  it("**标签外的话不进 task**——模型爱先说一句「好的，我来排一下」", async () => {
    const { model } = fakeModel(TWO);
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    const tasks = await agents.plan("排");

    expect(tasks.join("")).not.toContain("好的，我来排一下");
  });

  it("**id 我们自己编，不听模型的**——两个 task 都叫 01 的话会写同一个 report", async () => {
    const { model } = fakeModel(`
<task>
# 甲

做甲。
</task>
<task>
# 乙

做乙。
</task>
`);
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    const tasks = await agents.plan("排");

    // 撞 id 的后果不是报错：后一个 report 覆盖前一个，而整轮会因为落定数凑不齐
    // 永远收不了口。所以编号这件事根本不交给模型。
    expect([readTask(tasks[0])?.id, readTask(tasks[1])?.id]).toEqual(["01", "02"]);
  });

  it("**没闭合的标签不认**——半个任务发出去，subagent 会自己把它补完", async () => {
    const { model } = fakeModel("<task>\n# 甲\n\n做甲。\n</task>\n<task>\n# 乙\n\n做乙");
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    expect(await agents.plan("排")).toHaveLength(1);
  });

  it("**要求里写死了「每一块都要能被完全不知道上下文的人单独做完」**", async () => {
    const { model, asked } = fakeModel("");
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    await agents.plan("排成几件互不依赖的事");

    // 这句话就是 §1.1 那条硬规则本身。不说，planner 会很自然地写出「上一个任务」
    // ——中文写作里这类说法太顺手了，而它们在 subagent 那边全是空指针。
    expect(asked[0]).toContain("排成几件互不依赖的事");
    expect(asked[0]).toContain("看不到别的任务");
    expect(asked[0]).toContain("<task>");
  });

  it("一个都没排出来就是空的——不是错误，是这一轮没事可做", async () => {
    const { model } = fakeModel("这周没什么新东西。");
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    expect(await agents.plan("排")).toEqual([]);
  });
});

describe("阶段②：一个 subagent 一个 task", () => {
  it("**task 原文原样发出去**，不加壳、不加背景", async () => {
    const { model, asked } = fakeModel("# 结果");
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });
    const source = "---\n{}\n---\n\n查 A";

    const out = await agents.work(source);

    // 多加一句「你是一个研究助手」之类的都不行：那一句在这里是隐性上下文，
    // 而 §1.1 的整个意思就是**这一侧只有那一个文件**。
    expect(asked).toEqual([source]);
    expect(out.report).toBe("# 结果");
  });
});

describe("阶段③：把一堆 report 整理成一份", () => {
  const INPUT = {
    reports: [{ id: "01", title: "扫 arXiv", report: "# 找到 4 篇" }],
    failed: [{ id: "02", why: "端点不通" }],
    skipped: [{ id: "03", title: "看 commit" }],
  };

  it("**没做成的和没轮到的都进材料**——瞒下来就是一份看着完整、实际缺块的报告", async () => {
    const { model, asked } = fakeModel("# 周报");
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    await agents.wrap("整理成周报", INPUT);

    expect(asked[0]).toContain("整理成周报");
    expect(asked[0]).toContain("02：端点不通");
    expect(asked[0]).toContain("03 看 commit");
    // **两者要分开摆。** 混在一起，「这条路走不通」和「钱不够没轮到」在最终报告里
    // 就成了同一句话，而它们对读者的意思完全不同（spec §1.3）。
    expect(asked[0]).toContain("## 没做成的");
    expect(asked[0]).toContain("## 预算不够、没轮到的");
    expect(asked[0]).toContain("# 找到 4 篇");
  });

  it("材料里写明一共几件——报告里的数字要能对上", async () => {
    const { model, asked } = fakeModel("# 周报");
    const agents = createLoopAgents(model, { taskBudgetUsd: 0.3 });

    await agents.wrap("整理", INPUT);

    expect(asked[0]).toContain("一共 3 件事");
  });
});

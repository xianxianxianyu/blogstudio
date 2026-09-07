import type { LoopAgents, WrapInput } from "./runner";

/**
 * 模型端口，**结构类型**。
 *
 * 不 import PDF Studio 的 `ModelClient`：两侧之间一条 import 都没有，共用的东西靠形状
 * 接上（`CONTEXT-MAP.md`）。这里只要「给一段话、回一段话」这一件事。
 */
export interface TextModel {
  complete(request: {
    messages: { role: "user" | "assistant" | "system"; content: string }[];
  }): Promise<{ text: string }>;
}

/**
 * **用 `<task>` 标签切，不用 `---`。**
 *
 * task 文件本身就以 `---` 开头（frontmatter），拿 `---` 当分隔符会把每个任务从中间
 * 劈开。标签不会跟 markdown 撞，模型对它也熟。
 */
const OPEN = "<task>";
const CLOSE = "</task>";

/**
 * 从模型的整段回答里把 task 抠出来。
 *
 * **只认闭合的。** 模型被截断时最后一个标签往往是开着的，那半截任务发出去，subagent
 * 会把缺的部分自己补完——补出来的东西看着完全正常，而它跟你要的那件事没有关系。
 */
export function splitTasks(text: string): string[] {
  const blocks: string[] = [];
  for (let at = text.indexOf(OPEN); at !== -1; at = text.indexOf(OPEN, at + OPEN.length)) {
    const end = text.indexOf(CLOSE, at + OPEN.length);
    if (end === -1) break;
    blocks.push(text.slice(at + OPEN.length, end).trim());
  }
  return blocks;
}

/** 第一行 `# 标题`，其余是正文。模型不写标题就没有标题，由 `checkTask` 挡下来。 */
function titleAndBody(block: string): { title: string; body: string } {
  const match = /^#\s+(.+)$/m.exec(block);
  if (match === null) return { title: "", body: block };
  return {
    title: match[1].trim(),
    body: block.slice(match.index + match[0].length).trim(),
  };
}

/**
 * 把一块内容渲染成一份 task 文件。
 *
 * **id 和预算由我们填，不由模型决定。** 模型给两个任务都编 `01` 的话，后一份 report
 * 会覆盖前一份，而整轮会因为落定数凑不齐**永远收不了口**——一个不会报错、只会挂住
 * 的故障。预算同理：模型不知道钱的事，让它填等于没有上限。
 */
const renderTask = (index: number, block: string, budgetUsd: number): string => {
  const { title, body } = titleAndBody(block);
  const front = { id: String(index + 1).padStart(2, "0"), title, budget_usd: budgetUsd };
  return `---\n${JSON.stringify(front, null, 2)}\n---\n\n${body}`;
};

/** 阶段① 的格式要求。**跟 §1.1 那条硬规则是同一件事**，所以话说得很死。 */
const PLAN_FORMAT = `
把每一件事写成一个 <task> 块：

<task>
# 一句话标题

要做什么。写全部必要的背景、约束、判据。
</task>

硬要求：**每一块都要能被一个完全不知道上下文的人单独看懂并做完**。
干这件事的人看不到别的任务、看不到你现在的推理、也看不到这个项目以前做过什么。
所以「上一个任务」「见上文」「同上」这类说法一律不能用——它们在那边指不到任何东西。

没有该做的事就什么都不写。**不要为了凑数编任务。**
`.trim();

export function createLoopAgents(model: TextModel, opts: { taskBudgetUsd: number }): LoopAgents {
  return {
    async plan(prompt) {
      const { text } = await model.complete({
        messages: [{ role: "user", content: `${prompt}\n\n${PLAN_FORMAT}` }],
      });
      return splitTasks(text).map((block, index) => renderTask(index, block, opts.taskBudgetUsd));
    },

    async work(taskSource) {
      const { text } = await model.complete({ messages: [{ role: "user", content: taskSource }] });
      return { report: text };
    },

    async wrap(prompt, input) {
      const { text } = await model.complete({
        messages: [{ role: "user", content: `${prompt}\n\n${renderWrapInput(input)}` }],
      });
      return { report: text };
    },
  };
}

/**
 * 交给阶段③ 的材料。
 *
 * **失败和没轮到的也摆进去，而且摆在前面。** 只给成功的那几份，最终报告就会是一份
 * 看着完整、实际有洞的东西，而读者没有任何办法发现那个洞（spec §1.2）。摆在前面是
 * 因为放在末尾容易被当成附注略过。
 */
function renderWrapInput(input: WrapInput): string {
  const lines = [`一共 ${input.reports.length + input.failed.length + input.skipped.length} 件事。`];

  if (input.failed.length > 0) {
    lines.push("", "## 没做成的", ...input.failed.map((one) => `- ${one.id}：${one.why}`));
  }
  if (input.skipped.length > 0) {
    lines.push(
      "",
      "## 预算不够、没轮到的",
      ...input.skipped.map((one) => `- ${one.id} ${one.title}`),
    );
  }
  lines.push("", "## 各件的结果");
  for (const one of input.reports) {
    lines.push("", `### ${one.id} ${one.title}`, "", one.report);
  }

  lines.push(
    "",
    "写最终报告时**必须写明有几件没做成、几件没轮到**——瞒下来的话，读者拿到的是一份看着完整、实际缺了几块的报告。",
  );
  return lines.join("\n");
}

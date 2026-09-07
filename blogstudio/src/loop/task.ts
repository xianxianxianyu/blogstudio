/**
 * task 自包含校验。
 *
 * 阶段② 的 subagent **看不到**：别的 task、planner 的推理过程、这个项目以前的 run、
 * 任何对话历史。它手里只有这一个文件。所以判据是：把这个文件单独发给一个全新的
 * agent，它应该能干完（`.scratch/loop/spec.md` §1.1）。
 *
 * **这里只验得了结构，验不了语义。** 一份写得完整、但方向完全错的 task 会顺利通过。
 * 真正的度量在别处：有多少 report 在说「我缺信息」（spec §5 第一行）。这份校验只挡
 * 那些一眼可见的漏——它的价值在于**便宜**，不在于全。
 */

export type Problem =
  | { kind: "not-self-contained"; detail: string }
  | { kind: "missing"; detail: string };

/**
 * 指望外部的说法。
 *
 * 中文写作里这些词太自然了，planner 顺手就会写出来——而它们在 fan-out 里恰好全是空指针：
 * 「上一个任务」在 subagent 那边不存在。
 */
const DANGLING = ["上一个任务", "上一步", "见上文", "如前所述", "同上", "其他任务", "另一个 task"];

type Front = { id?: unknown; title?: unknown; budget_usd?: unknown };

/**
 * 拆 frontmatter。跟 `draft-store` 一样是 `---` 里包 JSON。
 *
 * **但这里拆不出来是错误，不是常态。** 稿子没有 frontmatter 很正常（正文才要紧）；
 * task 没有 frontmatter 意味着没有 id、没有预算上限——照着它跑就是拿一张空白支票
 * 去调模型。所以返回 null，由 `checkTask` 挡下来。
 */
function split(source: string): { front: Front; body: string } | null {
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---", 4);
  if (end === -1) return null;
  try {
    const front = JSON.parse(source.slice(4, end)) as Front;
    return { front, body: source.slice(end + 4).replace(/^\r?\n(\r?\n)?/, "") };
  } catch {
    return null;
  }
}

/** 必填的三样。少一样，subagent 要么跑不了，要么没有上限地跑。 */
const REQUIRED: Record<"id" | "title" | "budget_usd", (value: unknown) => boolean> = {
  id: (value) => typeof value === "string" && value !== "",
  title: (value) => typeof value === "string" && value !== "",
  // **必须是正数。** `0` 会让这个 task 一开口就超预算，写 `0` 多半是想表达「不限」——
  // 而「不限」正是这一栏存在的理由。
  budget_usd: (value) => typeof value === "number" && value > 0,
};

export function checkTask(source: string): Problem[] {
  const parsed = split(source);
  if (!parsed) return [{ kind: "missing", detail: "frontmatter" }];

  const missing = (Object.keys(REQUIRED) as (keyof typeof REQUIRED)[])
    .filter((key) => !REQUIRED[key](parsed.front[key]))
    .map((detail) => ({ kind: "missing", detail }) as const);
  const empty: Problem[] = parsed.body.trim() === "" ? [{ kind: "missing", detail: "正文" }] : [];
  const dangling = DANGLING.filter((word) => source.includes(word)).map(
    (detail) => ({ kind: "not-self-contained", detail }) as const,
  );

  return [...missing, ...empty, ...dangling];
}

/** 一个读得出来的 task。**读得出来 ⟺ 校验全过**——见 `readTask`。 */
export type Task = { id: string; title: string; budgetUsd: number; body: string };

/**
 * 读一个 task。有任何问题就返回 null。
 *
 * **没有「读出来但有问题」这个中间态。** 有的话，调用方就得自己记得每次都去看那份
 * 问题清单——而漏看一次的代价是拿着一份残缺的任务去调模型，钱照花。要看清单请单独
 * 调 `checkTask`，那是给人看的；这个是给执行用的。
 */
export function readTask(source: string): Task | null {
  if (checkTask(source).length > 0) return null;
  const parsed = split(source);
  if (!parsed) return null;
  const { id, title, budget_usd } = parsed.front as { id: string; title: string; budget_usd: number };
  return { id, title, budgetUsd: budget_usd, body: parsed.body };
}

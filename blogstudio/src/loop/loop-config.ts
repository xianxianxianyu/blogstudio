/**
 * 一个 loop 项目的配置：`<project>/loop.md`。
 *
 * **两段 prompt 放正文，不放 frontmatter。** 它们是这东西的心脏，会被人反复改；
 * 塞进 JSON 里就成了一行带 `\n` 的转义串，改一次要数引号。数字放 frontmatter，
 * 散文放正文——各自待在该待的地方（ADR-0011：文件是唯一真相，且允许手改）。
 */

export type LoopSettings = {
  everyMs: number;
  runCapUsd: number;
  /**
   * 单个 task 最多花多少。**跟整轮上限是两个不同的决定**，所以两个都得明写。
   *
   * 拿整轮上限除一除当默认，是把一个策略藏进代码里：一轮该排几件，只有写 prompt
   * 的人知道。
   */
  taskCapUsd: number;
  /** 阶段①：怎么把这个项目变成一批任务。 */
  planPrompt: string;
  /** 阶段③：怎么把一堆 report 变成一份。 */
  wrapPrompt: string;
};

/** 正文里认这两个标题。改标题等于改配置格式，所以它们是写死的。 */
const PLAN = "## 排任务";
const WRAP = "## 收口";

type Front = { everyHours?: unknown; runCapUsd?: unknown; taskCapUsd?: unknown };

/**
 * 读配置。**有任何一处缺失就返回 null，不给默认值。**
 *
 * 尤其是两段 prompt：给个空串当默认，agent 会自己发挥——然后花钱产出一份跟这个
 * 项目毫无关系的东西。缺间隔同理：一个不知道多久跑一次的 loop 没法定时，猜一个
 * 「默认每天」只会让它在某个没人预期的时刻自己跑起来。
 */
export function readConfig(source: string): LoopSettings | null {
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---", 4);
  if (end === -1) return null;

  let front: Front;
  try {
    front = JSON.parse(source.slice(4, end)) as Front;
  } catch {
    return null;
  }
  if (typeof front.everyHours !== "number" || front.everyHours <= 0) return null;
  if (typeof front.runCapUsd !== "number" || front.runCapUsd <= 0) return null;
  if (typeof front.taskCapUsd !== "number" || front.taskCapUsd <= 0) return null;
  // 单个比整轮还大就等于整轮没有上限：第一件就能把整轮的预算花光，而「整轮最多花
  // 多少」那一栏还在那儿写着一个安慰人的数字。
  if (front.taskCapUsd > front.runCapUsd) return null;

  const body = source.slice(end + 4);
  const planAt = body.indexOf(PLAN);
  const wrapAt = body.indexOf(WRAP);
  // **收口那段必须在排任务之后。** 两段颠倒的话按位置切会把整段切反，而切反之后
  // 两段都还是非空的——于是它安安静静地用错误的 prompt 跑起来。
  if (planAt === -1 || wrapAt === -1 || wrapAt < planAt) return null;

  const planPrompt = body.slice(planAt + PLAN.length, wrapAt).trim();
  const wrapPrompt = body.slice(wrapAt + WRAP.length).trim();
  if (planPrompt === "" || wrapPrompt === "") return null;

  return {
    everyMs: front.everyHours * 3600_000,
    runCapUsd: front.runCapUsd,
    taskCapUsd: front.taskCapUsd,
    planPrompt,
    wrapPrompt,
  };
}

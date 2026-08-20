import type { AnchorStatus } from "../clip/clip";

/**
 * 网页摘录的锚点：**引文，不是坐标**。
 *
 * `docs/research-web-anchoring.md` §5.1：PDF 的锚点是一个坐标，网页的锚点是一次检索。
 * 所以这里没有「定位」，只有「找」——而找会失败，失败是正常路径。
 *
 * 这一层是纯的：进来一段正文和一份描述，出去一个位置和一个分数。**不碰 DOM**——
 * 取正文、还原成 Range 是不纯的那一半，归调用方。
 */
export interface QuoteSelector {
  /** 逐字原文。**唯一真正的锚点**，其余都是加速器或先验。 */
  exact: string;
  prefix: string;
  suffix: string;
}

export interface Found {
  start: number;
  end: number;
  /** 0–1。1 = 引文与前后文全部逐字对上。 */
  score: number;
}

/**
 * 前后各取多少字当上下文。**照抄 Hypothesis 的 32**（`[W11]`）。
 *
 * 这一条中文占便宜：英文 32 字符约 7 个词，中文是 32 个**字**——信息量差一个量级，
 * 消歧能力强得多。
 */
export const CONTEXT_LEN = 32;

/**
 * 打分权重，照抄 Hypothesis（`match-quote.ts`）。位置只占 2 分——它是 tie-breaker，
 * 不是判据；页面越长这一项越接近无用。
 */
const W_QUOTE = 50;
const W_PREFIX = 20;
const W_SUFFIX = 20;
const W_POSITION = 2;

/**
 * 低于这个分不自动采纳，降级成 `fuzzy` 要人确认。
 *
 * **这是我们与 Hypothesis 的唯一实质分歧**，理由是产品形态不同：它是公共标注层，
 * 锚错了用户看见高亮划在旁边一句上，自己会发现；我们是个人知识库——摘录会入库、
 * 切块做 embedding、被检索出来当证据，**一条静默错锚会污染下游一整条链路，
 * 而且没人会去核对**。
 *
 * **0.7 这个数没有任何一手数据支持**（`docs/research-web-anchoring.md` §5.5）。
 * 它是拍的，等真实语料跑过再回来改，所以它是参数不是常量。
 */
const ACCEPT = 0.7;

/** 存的时候：把一个位置描述成「引文 + 前后文」。 */
export function describeQuote(text: string, start: number, end: number): QuoteSelector {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: text.slice(end, end + CONTEXT_LEN),
  };
}

/** 两段文字末尾/开头对上了多少（0–1）。上下文只对上一半时分数按比例掉。 */
function tailMatch(a: string, b: string): number {
  if (a === "" || b === "") return 1;
  const limit = Math.min(a.length, b.length);
  let same = 0;
  while (same < limit && a[a.length - 1 - same] === b[b.length - 1 - same]) same++;
  return same / limit;
}

function headMatch(a: string, b: string): number {
  if (a === "" || b === "") return 1;
  const limit = Math.min(a.length, b.length);
  let same = 0;
  while (same < limit && a[same] === b[same]) same++;
  return same / limit;
}

/**
 * 读的时候：在正文里把这段引文找回来。
 *
 * @param hint 上次记下的字符偏移（`TextPositionSelector`）。**它不是锚点，是先验**
 *   ——页面一改就失效，那是预期内的；它的价值在于「同一段文字出现多次」时当
 *   tie-breaker。成本是两个整数，收益是消歧。
 */
export function findQuote(text: string, quote: QuoteSelector, hint?: number): Found | null {
  // 空引文不是「匹配所有位置」，是没东西可找。
  if (quote.exact === "") return null;

  let best: Found | null = null;
  // **步长是 1，不是 exact.length。** 用长度当步长会漏掉重叠出现的候选，而空串导致的
  // 死循环由上面那条守卫挡住——非空时 `indexOf(exact, at + 1)` 必然前进或返回 -1。
  // （我自己先写成了长度当步长，被这条注释下面那个测试拦住。）
  for (let at = text.indexOf(quote.exact); at !== -1; at = text.indexOf(quote.exact, at + 1)) {
    const end = at + quote.exact.length;
    const before = text.slice(Math.max(0, at - CONTEXT_LEN), at);
    const after = text.slice(end, end + CONTEXT_LEN);

    // 位置项按全文长度归一化——页面越长这一项越接近无用，这正是它只值 2 分的原因。
    const closeness =
      hint === undefined ? 0 : 1 - Math.min(1, Math.abs(at - hint) / Math.max(1, text.length));

    const score =
      (W_QUOTE + W_PREFIX * tailMatch(before, quote.prefix) + W_SUFFIX * headMatch(after, quote.suffix) + W_POSITION * closeness) /
      (W_QUOTE + W_PREFIX + W_SUFFIX + (hint === undefined ? 0 : W_POSITION));

    // 严格大于：分数打平时取**第一处**。要确定，不能随机——同一份输入两次运行必须
    // 给出同一个答案，否则「锚到哪儿」会在两次打开之间跳。
    if (best === null || score > best.score) best = { start: at, end, score };
  }
  return best;
}

/** 这个分数该怎么办。`null` = 压根没找到。 */
export function verdictOf(score: number | null): AnchorStatus {
  if (score === null) return "orphan";
  return score >= ACCEPT ? "anchored" : "fuzzy";
}

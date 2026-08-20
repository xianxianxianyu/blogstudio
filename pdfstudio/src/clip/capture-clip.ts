import { reduce, sameRegion } from "./clip";
import type { Clip, ClipsState } from "./clip";
import type { ClipStore } from "./clip-store";
import type { RecognizeOptions, Recognizer, Region } from "../recognizer/recognizer";
import type { TagColor } from "../tag/tag";

/**
 * 失败时**两样都要给**：调用方要用 state 继续（否则只能整个丢掉，摘录就没了），
 * 也要用 error 呈现原因（是网络不通还是模型乱答，只有它知道该怎么显示）。
 * 抛错会丢掉前者，只返回 state 会丢掉后者，所以两者都显式带上。
 */
export type CaptureOutcome =
  | { ok: true; state: ClipsState; clipId: string }
  | { ok: false; state: ClipsState; clipId: string; error: unknown };

export interface CaptureClipDeps {
  recognizer: Recognizer;
  store: ClipStore;
  /** 注入而不是内部生成：测试要确定的 id，运行时才关心它是不是唯一的。 */
  newId: () => string;
  /** 同理，时钟也注入——保留期从这个时刻起算（ADR-0012）。 */
  now: () => number;
}

/**
 * 框选一块地方，把它变成一条落了盘的摘录。
 *
 * 这一层只做编排：识别归 Recognizer，状态迁移归 reducer，落盘归 ClipStore。它自己
 * 唯一拥有的是**顺序**，而顺序恰恰是这里唯一会出错的东西：
 *
 * - **识别失败必须把摘录送回可重试的状态**，否则它停在 `recognizing` 就再也出不来了。
 * - **失败时磁盘上不能留下半条摘录**。半条比没有更糟：`listByDoc` 会把它读回来，
 *   将来的索引重建也会把它捡走。
 * - **先落文件、再更新索引**（ADR-0011 代价 1，文件是唯一真相）。索引还没接入，
 *   所以这条目前只体现为「save 成功之后才算数」。
 */
export async function captureClip(
  deps: CaptureClipDeps,
  state: ClipsState,
  docId: string,
  region: Region,
  options?: RecognizeOptions,
  /** 上一次用过的颜色。连续划同一类时读者一次都不用点。 */
  tagId: TagColor | null = null,
): Promise<CaptureOutcome> {
  let next = reduce(state, { type: "capture", id: deps.newId(), region, at: deps.now(), tagId });

  // capture 会合并到同区域的已有摘录上，所以这条摘录的 id 未必是 newId() 给的那个
  // ——重试同一块地方时用的是原来那条的 id。按区域回查才拿得准。
  const clip = next.clips.find((candidate) => sameRegion(candidate.region, region));
  if (!clip) return { ok: true, state: next, clipId: "" };

  next = reduce(next, { type: "recognize", id: clip.id });

  let content;
  try {
    content = await deps.recognizer.recognize(region, options);
  } catch (error) {
    return {
      ok: false,
      state: reduce(next, { type: "recognize-failed", id: clip.id }),
      clipId: clip.id,
      error,
    };
  }

  next = reduce(next, { type: "recognized", id: clip.id, content });

  // 落盘失败暂不接管：从 `ready` 没有回到可重试状态的路（recognize 要 capturing、
  // recognize-failed 要 recognizing，都进不去），要处理就得动状态机。现在没有测试
  // 要求它，凭空加一条路径只会得到一段没人验证过的回滚。让它抛，由调用方看见。
  const saved = next.clips.find((candidate) => candidate.id === clip.id) as Clip;
  await deps.store.save(docId, saved);

  return { ok: true, state: next, clipId: clip.id };
}


/**
 * 只框选，不识别（ADR-0019）。
 *
 * 摘录停在 **`capturing`**——那个状态的含义本来就是「已框选、待识别」，
 * `recognize-failed` 也正是退回到它。所以「延后识别」不需要新状态：它就是这个状态，
 * 而 `recognize` 的守卫要的也正是它，**「事后再认」那条路本来就通**。
 *
 * 为什么默认不认：ADR-0016 假设的是英文论文（有文本层、翻译有价值），而在中文扫描书上
 * 每一框都是二十秒起的视觉调用，产出多半用不上。
 */
export async function captureOnly(
  deps: CaptureClipDeps,
  state: ClipsState,
  docId: string,
  region: Region,
  /** 上一次用过的颜色。连续划同一类时读者一次都不用点。 */
  tagId: TagColor | null = null,
): Promise<CaptureOutcome> {
  const next = reduce(state, { type: "capture", id: deps.newId(), region, at: deps.now(), tagId });

  // 同 captureClip：capture 会合并到同区域的已有摘录上，id 未必是 newId() 那个。
  const clip = next.clips.find((candidate) => sameRegion(candidate.region, region));
  if (!clip) return { ok: true, state: next, clipId: "" };

  await deps.store.save(docId, clip);
  return { ok: true, state: next, clipId: clip.id };
}

/**
 * 认一条已经框好、还停在 `capturing` 的摘录。
 *
 * 与 `captureClip` 的区别只有一处：区域来自那条摘录自己，而不是调用方现给的。
 * 失败照样退回 `capturing`——不退的话它停在 `recognizing` 就再也认不了了。
 */
export async function recognizeClip(
  deps: CaptureClipDeps,
  state: ClipsState,
  docId: string,
  clipId: string,
  options?: RecognizeOptions,
): Promise<CaptureOutcome> {
  const target = state.clips.find((candidate) => candidate.id === clipId);
  if (!target) {
    return { ok: false, state, clipId, error: new Error("没有这条摘录。") };
  }

  let next = reduce(state, { type: "recognize", id: clipId });

  let content;
  try {
    content = await deps.recognizer.recognize(target.region, options);
  } catch (error) {
    return {
      ok: false,
      state: reduce(next, { type: "recognize-failed", id: clipId }),
      clipId,
      error,
    };
  }

  next = reduce(next, { type: "recognized", id: clipId, content });
  const saved = next.clips.find((candidate) => candidate.id === clipId) as Clip;
  await deps.store.save(docId, saved);

  return { ok: true, state: next, clipId };
}

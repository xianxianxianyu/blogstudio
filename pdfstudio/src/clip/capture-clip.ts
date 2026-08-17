import { reduce, sameRegion } from "./clip";
import type { Clip, ClipsState } from "./clip";
import type { ClipStore } from "./clip-store";
import type { RecognizeOptions, Recognizer, Region } from "../recognizer/recognizer";

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
): Promise<CaptureOutcome> {
  let next = reduce(state, { type: "capture", id: deps.newId(), region, at: deps.now() });

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

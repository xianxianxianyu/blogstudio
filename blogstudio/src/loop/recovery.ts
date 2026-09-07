/**
 * 崩了之后，每个 task 各自是什么处境。
 *
 * 纯函数：只看 run 目录里**有哪些文件**，不读内容、不碰磁盘。谁去 `readdir` 是外面的事。
 */

/**
 * 三种处境，**必须是三种**。
 *
 * 把 `maybe-charged` 并进任何一边都是在替人做一个做不了的决定：并进「没跑过」＝可能
 * 付两次钱（`maxRetries` 默认 2，Anthropic 没有 idempotency key）；并进「干完了」＝
 * 可能把一个根本没成功的 task 当成有产出，让最终 report 缺一块还看不出来。
 *
 * 它是独立的一种，于是每个用到它的地方都**必须**写出自己打算怎么办。
 */
export type State = "not-started" | "done" | "maybe-charged";

export type TaskState = { id: string; state: State };

export function recover(taskIds: string[], files: string[]): TaskState[] {
  const has = new Set(files);
  return taskIds.map((id) => ({
    id,
    // report 在就是干完了——**先看 report**。它是产出，而意图只是「打算做」。
    state: has.has(`${id}.report.md`)
      ? "done"
      : has.has(`${id}.intent.json`)
        ? "maybe-charged"
        : "not-started",
  }));
}

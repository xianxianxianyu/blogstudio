import { can, reduce } from "./clip";
import type { Clip } from "./clip";
import type { ClipStore } from "./clip-store";

/** 未标记摘录的保留天数。可配，默认 7（ADR-0012）。 */
export const DEFAULT_TTL_DAYS = 7;

const DAY = 24 * 60 * 60 * 1000;

/**
 * 这条摘录到期了吗。
 *
 * 「谁不能被回收」全部交给 `decay` 的守卫，这里不重写一遍：两处各写一份规则，
 * 迟早会有一份漏掉纯图或已入库那种情形，而这类漏洞要等到东西被删掉才发现。
 * 这里只加时间这一维——守卫是纯的，看不见时钟。
 *
 * 已经是墓碑的（`content === null` 且已 ready）不再回收：否则每跑一次回收器都要
 * 重写一遍同样的文件，白白搅动磁盘，还会把 mtime 刷成「刚动过」。
 */
export function isCollectable(clip: Clip, now: number, ttlDays = DEFAULT_TTL_DAYS): boolean {
  if (clip.content === null) return false;
  if (!can({ clips: [clip], contexts: [] }, { type: "decay", id: clip.id }).ok) return false;
  return now - clip.lastViewedAt > ttlDays * DAY;
}

export interface CollectDeps {
  store: ClipStore;
}

/**
 * 跑一遍回收：到期的摘录衰减成墓碑，返回被回收的 id。
 *
 * **不加 `ClipStore.decay()`。** `save` 本来就是整体替换（写 `.tmp` → `rm` 目标 →
 * `rename`），存一条 `content` 为 null 的摘录，旧字节自然就没了。再开一个方法等于把
 * 「磁盘上留什么」复制到第二个地方，两处迟早会不一致。
 *
 * **也不复用 `delete`。** 那条路删的是整个文件夹，标签会跟着消失——而标签正是
 * 「这儿我来过」，回收要省的是截图，不是痕迹。主动删除与自动回收看着都在删东西，
 * 规则却是相反的：主动删允许删已入库的（读者的选择，context 标记 sourceClipDeleted），
 * 自动回收绝不能碰（那不是回收器该替读者做的决定）。合成一个操作必然牺牲其中一条。
 */
export async function collect(
  deps: CollectDeps,
  docId: string,
  now: number,
  ttlDays = DEFAULT_TTL_DAYS,
): Promise<string[]> {
  const collected: string[] = [];

  for (const clip of await deps.store.listByDoc(docId)) {
    if (!isCollectable(clip, now, ttlDays)) continue;
    // 经 reducer 而不是自己拼对象：守卫在那儿，绕过去就等于回收器有一套自己的规则。
    const decayed = reduce({ clips: [clip], contexts: [] }, { type: "decay", id: clip.id }).clips[0];
    await deps.store.save(docId, decayed);
    collected.push(clip.id);
  }

  return collected;
}

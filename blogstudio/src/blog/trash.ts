/**
 * 回收站里那些文件的名字：`<时间戳>-<slug>.md`。
 *
 * **时间戳是删除的时刻，而且只能从名字里读回来。** 文件的 mtime 不行——`rename` 保留的是
 * 原来那份的修改时间，那是「文章最后改于何时」，跟「什么时候被丢掉」是两回事。
 *
 * 前缀也不是装饰：**同一个 slug 删两次不能互相覆盖**，而「删了、又写了一篇同名的、
 * 再删」是最容易发生的那种。
 */

/** `20260830-175002`。本地时间——它是给人看的，而人看的是自己的钟。 */
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.md$/;

const two = (n: number): string => String(n).padStart(2, "0");

export function trashNameOf(slug: string, at: number): string {
  const when = new Date(at);
  return (
    `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}` +
    `-${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}` +
    `-${slug}.md`
  );
}

/**
 * 拆回 slug 和时刻。**认不出就是 `null`**——`.trash/` 里可能有手拖进去的文件，
 * 给它编一个日期然后按期删掉，是这一整块里最坏的做法。
 */
export function parseTrashName(name: string): { slug: string; at: number } | null {
  const hit = STAMP.exec(name);
  if (!hit) return null;
  const [, y, mo, d, h, mi, s, slug] = hit as unknown as string[];
  // 用本地时间构造，跟 `trashNameOf` 那一侧对齐；差一套的话「几天前」会差八小时。
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  return { slug: slug!, at };
}

/**
 * 该不该自动清掉。
 *
 * **按「每一件各自满 N 天」算，不是「每月某一天全清」。** 后者会让昨天丢的东西
 * 因为今天恰好到日子而消失——同样是「回收站」，两种做法给的保证差着一整个月。
 *
 * **认不出时间的一律留着**——不知道它什么时候来的，猜一个然后删掉是最坏的做法。
 *
 * 时间在未来的（系统时钟改过、名字是手写的）也留着，但**不用单独判**：
 * 未来的时刻算出来是负的年龄，永远超不过阈值。曾经在这儿多写了一个 `at > now`，
 * 变异测试证明它一个字都不改变。
 */
export function expired(one: { at: number | null }, now: number, days: number): boolean {
  if (one.at === null) return false;
  return now - one.at > days * 24 * 60 * 60 * 1000;
}

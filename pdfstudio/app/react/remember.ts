import { useState } from "react";

/**
 * 一位记在这台机器上的界面偏好（侧栏收没收起来之类）。
 *
 * **不进 `config.json`**：那份文件里躺着 API key，为了一个侧栏宽度反复重写它，
 * 是拿一个可读可写的密钥文件去换一点方便。这一类偏好也确实不该跨机器同步——它说的是
 * 「我这块屏幕多宽」，不是「我这个人怎么用它」。
 *
 * **读写都只吞不抛。** 存储不可用（隐私窗口、配额满、被策略关掉）时该发生的事情是
 * 「这一位记不住」，而不是「侧栏打不开」——把一个记忆功能的故障升级成一个操作的故障，
 * 是这一类代码最常见的错法。
 */
export function useRemembered(
  key: string,
  fallback: boolean,
): [boolean, () => void, (next: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const kept = localStorage.getItem(key);
      // 没记过就用默认值：**`null` 不是 `false`**，两者混同的话默认为真的那些位
      // 会在第一次启动时悄悄反过来。
      return kept === null ? fallback : kept === "1";
    } catch {
      return fallback;
    }
  });

  /** 落盘只有这一处。两条路各写各的迟早会漂，而漂出来的那条多半是忘了写的那条。 */
  const keep = (next: boolean): boolean => {
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // 同上。
    }
    return next;
  };

  const toggle = () => setOn((was) => keep(!was));
  /** 明确设成某一位。给「这个动作的结果在那一栏里，所以那一栏必须开着」用。 */
  const set = (next: boolean) => setOn(() => keep(next));

  return [on, toggle, set];
}

/**
 * 整轮的预算怎么分给一批**同时跑**的 task。
 *
 * **按上限预留，不按已花的钱。** 串行时可以调一次看一次账，并行时不行：钱是响应
 * 回来才知道的，而那时 N 个请求已经同时在飞了。所以门开在**派发之前**——一个 task
 * 派出去，就先把它的上限从整轮里划走。
 *
 * 代价是保守：十二个上限 0.3 的 task 配 3 块的整轮预算，只派得出十个，哪怕它们
 * 实际每个只花 0.05。宁可少派，因为**多派没有退路**——钱花出去了收不回来。
 */

export type Reservation = { send: boolean; reserved: number };

export const reserve = (runCapUsd: number, reservedUsd: number, taskCapUsd: number): Reservation =>
  reservedUsd + taskCapUsd <= runCapUsd
    ? { send: true, reserved: reservedUsd + taskCapUsd }
    : { send: false, reserved: reservedUsd };

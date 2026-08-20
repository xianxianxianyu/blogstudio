import { describe, expect, it, vi } from "vitest";
import { RecognizeError } from "../recognizer/recognizer";
import { retrying } from "./retry";

const noWait = () => Promise.resolve();

describe("retrying", () => {
  it("一次就成的不重试", async () => {
    const attempt = vi.fn().mockResolvedValue("好了");
    await expect(retrying(attempt, { tries: 3, wait: noWait })).resolves.toBe("好了");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("偶发失败之后成功，就当没失败过", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RecognizeError("model-unavailable", "模型调用失败"))
      .mockResolvedValue("好了");
    await expect(retrying(attempt, { tries: 3, wait: noWait })).resolves.toBe("好了");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("试满了还失败就抛最后一次的错——不能把「没成」说成「成了」", async () => {
    const last = new RecognizeError("model-unavailable", "第三次也不行");
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RecognizeError("model-unavailable", "第一次"))
      .mockRejectedValueOnce(new RecognizeError("model-unavailable", "第二次"))
      .mockRejectedValue(last);
    await expect(retrying(attempt, { tries: 3, wait: noWait })).rejects.toBe(last);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("退避是递增的：连着立刻重试三次，撞上的是同一阵故障", async () => {
    const waited: number[] = [];
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new RecognizeError("model-unavailable", "一"))
      .mockRejectedValueOnce(new RecognizeError("model-unavailable", "二"))
      .mockResolvedValue("好了");
    await retrying(attempt, {
      tries: 3,
      wait: async (ms) => {
        waited.push(ms);
      },
    });
    expect(waited).toHaveLength(2);
    expect(waited[1]).toBeGreaterThan(waited[0]);
  });

  it("坏输出不重试：同一张图再问一遍，多半还是同样的形状", async () => {
    const attempt = vi.fn().mockRejectedValue(new RecognizeError("bad-output", "不是 JSON"));
    await expect(retrying(attempt, { tries: 3, wait: noWait })).rejects.toThrow("不是 JSON");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("不认识的错也不重试：重试只对「过一会儿也许就好了」那类有意义", async () => {
    const attempt = vi.fn().mockRejectedValue(new TypeError("代码写错了"));
    await expect(retrying(attempt, { tries: 3, wait: noWait })).rejects.toThrow("代码写错了");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import { createSettings } from "./settings";
import { fieldSource } from "../config/config";
import type { AppConfig, EndpointConfig } from "../config/config";

const START: AppConfig = {
  default: { baseURL: "https://cloud", apiKey: "cloud-key", model: "big" },
  capabilities: { translation: { model: "fast" } },
  retention: { ttlDays: 7, acknowledged: false },
};

function settings(probe: (endpoint: EndpointConfig) => Promise<void> = async () => undefined) {
  const saved: AppConfig[] = [];
  const probed: EndpointConfig[] = [];
  return {
    saved,
    probed,
    it: createSettings({
      load: async () => structuredClone(START),
      save: async (config) => {
        saved.push(structuredClone(config));
      },
      probe: async (endpoint) => {
        probed.push(endpoint);
        await probe(endpoint);
      },
    }),
  };
}

describe("设置", () => {
  it("改默认组会落盘", async () => {
    const { saved, it: s } = settings();
    await s.load();

    await s.setDefault("model", "small");

    expect(s.config.default.model).toBe("small");
    expect(saved.at(-1)!.default.model).toBe("small");
  });

  it("给某个功能单独配一栏，其余仍跟随默认组", async () => {
    const { it: s } = settings();
    await s.load();

    await s.setOverride("recognition", "baseURL", "http://127.0.0.1:8080/v1");

    expect(fieldSource(s.config, "recognition", "baseURL")).toBe("own");
    expect(fieldSource(s.config, "recognition", "model")).toBe("inherited");
  });

  it("清掉覆盖就回到跟随默认组", async () => {
    // 与「把它设成空串」不是一回事：空串是「我就是要它为空」（本地模型不需要 key），
    // 清掉才是「跟着默认走」。
    const { it: s } = settings();
    await s.load();
    await s.setOverride("translation", "baseURL", "http://local");

    await s.clearOverride("translation", "baseURL");

    expect(fieldSource(s.config, "translation", "baseURL")).toBe("inherited");
    expect(fieldSource(s.config, "translation", "model")).toBe("own");
  });

  it("自检打的是这个功能解析后的端点，不是默认组", async () => {
    // **这条是整个自检有没有用的分界。** 打默认组的话，读者给识别单独配了本地端点、
    // 自检说「通了」，实际通的是云端那个——他要到框选时才发现本地端点根本没起来。
    const { probed, it: s } = settings();
    await s.load();
    await s.setOverride("recognition", "baseURL", "http://127.0.0.1:8080/v1");

    await s.check("recognition");

    expect(probed.at(-1)).toEqual({
      baseURL: "http://127.0.0.1:8080/v1",
      apiKey: "cloud-key",
      model: "big",
    });
  });

  it("自检失败把原因带出来，不只说一句失败", async () => {
    const { it: s } = settings(async () => {
      throw Object.assign(new Error("模型调用失败"), {
        cause: Object.assign(new Error("Unauthorized"), { kind: "http" }),
      });
    });
    await s.load();

    const result = await s.check("chat");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unauthorized");
  });
});

describe("回收策略", () => {
  it("确认告知会落盘", async () => {
    // 没落盘的话每次启动都要再确认一遍，而读者会开始无脑点掉它——
    // 那这条告知就白设了。
    const { saved, it: s } = settings();
    await s.load();

    await s.acknowledgeRetention();

    expect(s.config.retention.acknowledged).toBe(true);
    expect(saved.at(-1)!.retention.acknowledged).toBe(true);
  });

  it("改保留天数会落盘", async () => {
    const { saved, it: s } = settings();
    await s.load();

    await s.setRetentionDays(30);

    expect(saved.at(-1)!.retention.ttlDays).toBe(30);
  });

  it("天数只收正整数", async () => {
    // 0 或负数会让「到期」对所有摘录成立——一打开书就全清空，且不可撤销。
    // NaN 更坏：`now - lastViewedAt > NaN` 恒为 false，回收静默失效，什么都不说。
    const { it: s } = settings();
    await s.load();

    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const result = await s.setRetentionDays(bad);
      expect(result.ok).toBe(false);
    }
    expect(s.config.retention.ttlDays).toBe(7);
  });
});

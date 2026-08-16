import { fieldSource, parseConfig, resolveEndpoint } from "../config/config";
import { errorChain } from "./error-chain";
import type { AppConfig, Capability, EndpointConfig } from "../config/config";
import type { Result } from "./workspace";

export interface SettingsDeps {
  load(): Promise<AppConfig>;
  save(config: AppConfig): Promise<void>;
  /** 拿这一组端点打一次真实调用；通了就正常返回，不通就抛。 */
  probe(endpoint: EndpointConfig): Promise<void>;
}

export interface Settings {
  readonly config: AppConfig;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  setDefault(field: keyof EndpointConfig, value: string): Promise<Result>;
  setOverride(capability: Capability, field: keyof EndpointConfig, value: string): Promise<Result>;
  clearOverride(capability: Capability, field: keyof EndpointConfig): Promise<Result>;
  check(capability: Capability): Promise<Result>;
  /** 读者已经知道「未标记的摘录会到期衰减」。在此之前一条都不回收。 */
  acknowledgeRetention(): Promise<Result>;
  setRetentionDays(days: number): Promise<Result>;
  /** 识别走本地引擎还是云端（ADR-0015）。 */
  setLocalRecognition(local: boolean): Promise<Result>;
}

/**
 * 设置这一屏的应用层。按屏切分而不是塞进 `Workspace`（ADR-0013 代价 2）。
 *
 * 每次改动立刻落盘：设置页没有「保存」按钮的心智——读者改完就走，指望它已经生效。
 */
export function createSettings(deps: SettingsDeps): Settings {
  let config: AppConfig = parseConfig(null);
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) listener();
  };

  async function persist(next: AppConfig): Promise<Result> {
    try {
      await deps.save(next);
    } catch (error) {
      return { ok: false, reason: "保存失败", error };
    }
    config = next;
    publish();
    return { ok: true };
  }

  return {
    get config() {
      return config;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load(): Promise<void> {
      config = await deps.load();
      publish();
    },

    setDefault(field, value): Promise<Result> {
      return persist({ ...config, default: { ...config.default, [field]: value } });
    },

    setOverride(capability, field, value): Promise<Result> {
      return persist({
        ...config,
        capabilities: {
          ...config.capabilities,
          [capability]: { ...config.capabilities[capability], [field]: value },
        },
      });
    },

    clearOverride(capability, field): Promise<Result> {
      // 删掉这个键，而不是设成空串。两者不是一回事：空串是「我就是要它为空」
      // （本地模型不需要 apiKey），删键才是「跟着默认组走」——`fieldSource` 看的
      // 正是键在不在。
      const rest = { ...config.capabilities[capability] };
      delete rest[field];
      return persist({ ...config, capabilities: { ...config.capabilities, [capability]: rest } });
    },

    acknowledgeRetention(): Promise<Result> {
      return persist({ ...config, retention: { ...config.retention, acknowledged: true } });
    },

    setRetentionDays(days: number): Promise<Result> {
      // 0 或负数会让「到期」对所有摘录成立——一打开书就全清空，且不可撤销。
      // NaN 更坏：`now - lastViewedAt > NaN` 恒为 false，回收静默失效，什么都不说。
      if (!Number.isInteger(days) || days < 1) {
        return Promise.resolve({ ok: false, reason: "保留天数要是 1 以上的整数。" });
      }
      return persist({ ...config, retention: { ...config.retention, ttlDays: days } });
    },

    setLocalRecognition(local: boolean): Promise<Result> {
      return persist({ ...config, localRecognition: local });
    },

    async check(capability: Capability): Promise<Result> {
      // **打这个功能解析后的端点，不是默认组。** 打默认组的话，读者给识别单独配了
      // 本地端点、自检说「通了」，实际通的是云端那个——他要到框选时才发现本地端点
      // 根本没起来。
      const endpoint = resolveEndpoint(config, capability);
      try {
        await deps.probe(endpoint);
        return { ok: true };
      } catch (error) {
        // 原因要带出来。只说一句「连不上」，读者无从判断是 key 错了、地址错了
        // 还是模型名错了。
        return { ok: false, reason: errorChain(error) || "连接失败", error };
      }
    },
  };
}

export { fieldSource };

/**
 * 模型配置：**每个功能各配各的端点**（ADR-0010）。
 *
 * 但绝大多数读者只有一个端点，所以有两条让配置保持短小的规则：
 *
 * 1. **扁平写法仍然有效**——`{ baseURL, apiKey, model }` 就是「全部功能都用它」。
 *    既有的 `config.json` 正是这个形状，不能让它一夜失效。
 * 文件读写不在这里——见 `config-file.ts`。这个模块必须保持**纯**：ADR-0006 说应用要
 * 跑在 Mac/Windows/手机上，纯逻辑一旦 import 了 `node:fs`，浏览器那一侧整个模块就加载
 * 不了（这不是假想，框选竖切页面第一次跑就是这么炸的）。
 *
 * 2. **回退按字段而非按组**——「同一个端点、翻译换个更快的模型」是最常见的配法，
 *    按组回退就得把 url 和 key 再抄一遍。
 */

/** 需要模型的功能。embedding 的形状与其余四个不同（文本进、向量出），但配置项一样。 */
export type Capability = "recognition" | "translation" | "chat" | "embedding" | "claim";

export interface EndpointConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** 未标记摘录的保留策略（ADR-0012）。 */
export interface RetentionConfig {
  ttlDays: number;
  /**
   * 读者是否已经知道「未标记的摘录会到期衰减」。
   *
   * **默认 false，且没确认过一条都不回收。** ADR-0012 记着「首次运行必须显式告知」，
   * 而删完再说不叫告知。默认 true 的话，读者第一次打开应用就可能已经丢了东西。
   */
  acknowledged: boolean;
}

export interface AppConfig {
  /** 没有单独配置的功能都落到它。 */
  default: EndpointConfig;
  /** 只写要覆盖的字段，其余跟随默认。 */
  capabilities: Partial<Record<Capability, Partial<EndpointConfig>>>;
  retention: RetentionConfig;
}

const EMPTY: EndpointConfig = { baseURL: "", apiKey: "", model: "" };

const DEFAULT_RETENTION: RetentionConfig = { ttlDays: 7, acknowledged: false };

/** 从 JSON 读出配置。扁平写法与分组写法都认。 */
export function parseConfig(raw: unknown): AppConfig {
  const source = (raw ?? {}) as Partial<AppConfig> & Partial<EndpointConfig>;

  // 分组写法有 default 字段；否则整个对象就是那唯一一组。
  const fallback: EndpointConfig =
    source.default !== undefined
      ? { ...EMPTY, ...source.default }
      : { ...EMPTY, baseURL: source.baseURL ?? "", apiKey: source.apiKey ?? "", model: source.model ?? "" };

  return {
    default: fallback,
    capabilities: source.capabilities ?? {},
    // 逐字段回退：旧文件根本没有这一段，落到 undefined 的话回收器那边
    // `ttlDays` 会算出 NaN，而 `now - lastViewedAt > NaN` 永远是 false
    // ——回收静默失效，不报任何错。
    retention: { ...DEFAULT_RETENTION, ...source.retention },
  };
}

/** 某个功能实际用哪个端点。逐字段回退到默认组。 */
export function resolveEndpoint(config: AppConfig, capability: Capability): EndpointConfig {
  return { ...config.default, ...(config.capabilities[capability] ?? {}) };
}

/**
 * 这一栏的值是这个功能自己配的，还是跟随默认组。
 *
 * 界面上必须能看出这个区别，否则读者改了默认组会**意外影响到**他以为已经独立配置的
 * 功能——而那多半要等到某次调用行为变了才发现。
 *
 * 判定看**键在不在**，不看值真不真。「我就是要它为空」和「我没配、跟着默认走」是
 * 两回事：本地模型不需要 apiKey，显式清空是一种真实配法。按真假值判会把它误认成
 * 未配置，然后偷偷灌进默认组的 key——**那是把云端的 key 发给了本地端点**。
 */
export function fieldSource(
  config: AppConfig,
  capability: Capability,
  field: keyof EndpointConfig,
): "own" | "inherited" {
  return field in (config.capabilities[capability] ?? {}) ? "own" : "inherited";
}

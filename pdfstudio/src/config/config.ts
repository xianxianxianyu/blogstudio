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

export interface AppConfig {
  /** 没有单独配置的功能都落到它。 */
  default: EndpointConfig;
  /** 只写要覆盖的字段，其余跟随默认。 */
  capabilities: Partial<Record<Capability, Partial<EndpointConfig>>>;
}

const EMPTY: EndpointConfig = { baseURL: "", apiKey: "", model: "" };

/** 从 JSON 读出配置。扁平写法与分组写法都认。 */
export function parseConfig(raw: unknown): AppConfig {
  const source = (raw ?? {}) as Partial<AppConfig> & Partial<EndpointConfig>;

  // 分组写法有 default 字段；否则整个对象就是那唯一一组。
  const fallback: EndpointConfig =
    source.default !== undefined
      ? { ...EMPTY, ...source.default }
      : { ...EMPTY, baseURL: source.baseURL ?? "", apiKey: source.apiKey ?? "", model: source.model ?? "" };

  return { default: fallback, capabilities: source.capabilities ?? {} };
}

/** 某个功能实际用哪个端点。逐字段回退到默认组。 */
export function resolveEndpoint(config: AppConfig, capability: Capability): EndpointConfig {
  return { ...config.default, ...(config.capabilities[capability] ?? {}) };
}

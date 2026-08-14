import { readFile, writeFile } from "node:fs/promises";

/**
 * 模型配置：**每个功能各配各的端点**（ADR-0010）。
 *
 * 但绝大多数读者只有一个端点，所以有两条让配置保持短小的规则：
 *
 * 1. **扁平写法仍然有效**——`{ baseURL, apiKey, model }` 就是「全部功能都用它」。
 *    既有的 `config.json` 正是这个形状，不能让它一夜失效。
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

/**
 * 从文件读配置。文件不存在时返回空配置而不是抛错——首次启动、还没配任何东西是
 * 正常状态，不是故障。调用方靠 `baseURL`/`apiKey` 是否为空来判断能不能用。
 */
export async function loadConfig(file: string): Promise<AppConfig> {
  const text = await readFile(file, "utf8").catch(() => null);
  return parseConfig(text === null ? null : (JSON.parse(text) as unknown));
}

/**
 * 写回配置。**总是写分组形式**——读进来时认扁平写法是为了兼容既有文件，
 * 写出去时统一成一种形状，免得同一份配置在两种形态之间来回漂。
 */
export async function saveConfig(file: string, config: AppConfig): Promise<void> {
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

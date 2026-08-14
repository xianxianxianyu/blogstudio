import { readFile, writeFile } from "node:fs/promises";
import { parseConfig } from "./config";
import type { AppConfig } from "./config";

// 配置的**文件**读写。单独一个文件，因为它依赖 `node:fs`——而 `config.ts` 的解析与
// 回退逻辑必须在浏览器里也能用（ADR-0006：Mac/Windows/手机通用）。
// 混在一起的后果试过了：页面 import 纯函数时把整个模块拖崩。

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

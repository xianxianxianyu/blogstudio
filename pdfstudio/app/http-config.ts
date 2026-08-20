import { apiFetch } from "./api-base";
import { parseConfig } from "../src/config/config";
import type { AppConfig } from "../src/config/config";

/**
 * 浏览器侧的配置读写：和书架、摘录一样转交给 dev server
 * （打包应用里这条边界是 IPC，ADR-0006）。
 *
 * 真实 key 只在这条连接上流动，**不进构建产物**——那条路由只挂在 configureServer 上
 * （ADR-0005）。
 */
export function createHttpConfigStore(route: string) {
  return {
    async load(): Promise<AppConfig> {
      const response = await apiFetch(route);
      if (!response.ok) throw new Error(`读配置失败：HTTP ${response.status}`);
      return parseConfig((await response.json()) as unknown);
    },

    async save(config: AppConfig): Promise<void> {
      // 总是写分组形式：读进来时认扁平写法是为了兼容既有文件，写出去统一成一种形状，
      // 免得同一份配置在两种形态之间来回漂。
      const response = await apiFetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${JSON.stringify(config, null, 2)}\n`,
      });
      if (!response.ok) throw new Error(`存配置失败：HTTP ${response.status} ${await response.text()}`);
    },
  };
}

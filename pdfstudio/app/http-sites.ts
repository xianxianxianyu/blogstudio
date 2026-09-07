import { apiFetch } from "./api-base";

/**
 * 允许在应用内加载的站点（`src/web/allow.ts`）。
 *
 * **不做「任意网站」的默认开放**——Electron 里 Safe Browsing 与 Certificate
 * Transparency 都是关的，官方自己说「要显示网站，浏览器是更安全的选择」。所以这是
 * 一份读者显式加进来的白名单。
 */
export interface SiteStore {
  load(): Promise<string[]>;
  save(sites: string[]): Promise<void>;
}

export function createHttpSiteStore(url: string): SiteStore {
  return {
    async load(): Promise<string[]> {
      const response = await apiFetch(url);
      // 读不到就当空——还没加过任何站点是正常状态，不该让整页打不开。
      return response.ok ? ((await response.json()) as string[]) : [];
    },
    async save(sites: string[]): Promise<void> {
      await apiFetch(url, { method: "POST", body: JSON.stringify(sites) });
    },
  };
}

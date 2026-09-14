import type { AboutContent, AboutLanguage, AboutView } from "../../blogstudio/src/publish/about";
import { apiFetch } from "./api-base";
import type { Destination } from "../../blogstudio/src/publish/cloud-site";
import type { Deployed } from "../../blogstudio/src/publish/deploy";
import type { Changes } from "../../blogstudio/src/publish/rsync-plan";
import type { SyncRecord } from "../../blogstudio/src/publish/publish-store";

export type { Destination };

export interface PublishView {
  destinations: Destination[];
  /** 配置里写坏的那几条。**要显示出来**——手写的文件写错一个字是常事。 */
  problems: string[];
  /** 每个去处上次同步动了多少。**只用于显示**，差异永远问云端要。 */
  syncs: Record<string, SyncRecord>;
}

export interface Publishing {
  view(): Promise<PublishView>;
  about(): Promise<AboutView>;
  saveAbout(language: AboutLanguage, content: AboutContent, revision: string): Promise<AboutView>;
  /** 干跑：这次同步会动什么。**会先构建，但不写远端。** */
  previewSync(destination: string): Promise<Changes & { images: string[] }>;
  /** 真跑。**唯一不可逆的一步。** */
  sync(destination: string): Promise<Deployed>;
}

export function createHttpPublishing(url: string): Publishing {
  const at = (destination: string): string => `${url}/${encodeURIComponent(destination)}`;

  const ask = async (where: string, method?: string): Promise<unknown> => {
    const response = await apiFetch(where, method ? { method } : undefined);
    // **失败必须响。** 吞掉的话界面会显示「同步好了」，而公网上什么都没变。
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };

  return {
    async view() {
      const response = await apiFetch(url);
      // 读不到就当还没配过——那是正常状态，不该让整页打不开。
      return response.ok
        ? ((await response.json()) as PublishView)
        : { destinations: [], problems: [], syncs: {} };
    },
    about: () => ask(`${url}/_about`) as Promise<AboutView>,
    async saveAbout(language, content, revision) {
      const response = await apiFetch(`${url}/_about`, { method: "POST", body: JSON.stringify({ language, content, revision }) });
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<AboutView>;
    },
    previewSync: (destination) => ask(at(destination)) as Promise<Changes & { images: string[] }>,
    sync: (destination) => ask(at(destination), "POST") as Promise<Deployed>,
  };
}

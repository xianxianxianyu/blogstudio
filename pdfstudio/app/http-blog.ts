import { apiFetch } from "./api-base";
import type { Article, ArticleSummary, Trashed } from "../../blogstudio/src/blog/article-store";

export type { Article, ArticleSummary, Trashed };

/**
 * 统一目录里那些文章。**这里的每一个动作都只改本地文件**——
 * 云端只在「同步」那一下才变（`http-publish.ts`）。
 */
/** 列表 + 标签空间。标签跟着列表一起回来，省一次往返。 */
export interface BlogView {
  articles: ArticleSummary[];
  /** `[标签, 有几篇]`，用得多的在前。**tags 与 categories 合在一起**。 */
  labels: [string, number][];
}

export interface BlogClient {
  /** `q` 有词就搜标题、标签、正文；空串是「不筛」。 */
  list(q?: string): Promise<BlogView>;
  load(slug: string): Promise<Article>;
  retag(slug: string, tags: string[]): Promise<void>;
  withdraw(slug: string, draft: boolean): Promise<void>;
  /** 上架：`draft: false`，并把 `[ctx:]` 落成脚注。回报库里认不出的那些 id。 */
  promote(slug: string): Promise<{ missing: string[] }>;
  /** 移进回收站。**不是删除**——回报它的落点。 */
  remove(slug: string): Promise<{ trashed: string }>;
  /** 换地址。**只在下架时能用**（服务端拦着）。 */
  rename(slug: string, to: string): Promise<void>;
  /** 粘进编辑器的图：存进仓库，回报正文里该写的路径。 */
  uploadImage(file: File): Promise<string>;
  /** 回收站里有什么。**读一次就顺手清掉超过一个月的**。 */
  trash(): Promise<Trashed[]>;
  /** 放回来，返回它的 slug。 */
  restore(name: string): Promise<string>;
}

export function createHttpBlog(url: string): BlogClient {
  const ask = async (at: string, init?: RequestInit): Promise<unknown> => {
    const response = await apiFetch(at, init);
    // **失败必须响。** 吞掉的话界面会显示「改好了」，而文件根本没变。
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const act = (slug: string, action: string, body?: string) =>
    ask(`${url}/${encodeURIComponent(slug)}/${action}`, { method: "POST", body });

  return {
    async list(q = "") {
      const response = await apiFetch(q === "" ? url : `${url}?q=${encodeURIComponent(q)}`);
      // 读不到就当空——「还没配过 destinations.json」是正常状态，不该让整页打不开。
      return response.ok ? ((await response.json()) as BlogView) : { articles: [], labels: [] };
    },
    load: (slug) => ask(`${url}/${encodeURIComponent(slug)}`) as Promise<Article>,
    retag: (slug, tags) => act(slug, "retag", JSON.stringify(tags)).then(() => undefined),
    withdraw: (slug, draft) => act(slug, "withdraw", String(draft)).then(() => undefined),
    promote: (slug) => act(slug, "promote") as Promise<{ missing: string[] }>,
    remove: (slug) => act(slug, "remove") as Promise<{ trashed: string }>,
    rename: (slug, to) => act(slug, "rename", to).then(() => undefined),
    trash: () => ask(`${url}/trash`) as Promise<Trashed[]>,
    restore: (name) =>
      (ask(`${url}/trash/${encodeURIComponent(name)}`, { method: "POST" }) as Promise<{ slug: string }>)
        .then((out) => out.slug),

    async uploadImage(file) {
      // 原始字节，不 base64：一张截图编码之后胖三分之一，而它要多绕几道。
      const response = await apiFetch(`${url}/images?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      // **存不下必须响**：吞掉的话编辑器里会出现一张看起来正常、其实指向空气的图。
      if (!response.ok) throw new Error(await response.text());
      return ((await response.json()) as { url: string }).url;
    },
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Destination } from "./cloud-site";

/**
 * 发布配置，与「同步过几次」的账本。
 *
 * **分成两份文件，不合成一份。** 配置是你手写的（哪个仓库、哪台机器、哪个目录），
 * 账本是应用写的。合在一起的话，每记一次同步就要重写一遍你手写的那份——Loop 的开关
 * 为同一个理由单独用一个标记文件，不碰 `loop.md`。
 *
 * - `destinations.json` —— 你写，**我们只读，一个字都不回写**
 * - `published.json` —— 我们写，你不用管。**只记同步**：上一版还记「哪篇稿子落在哪条
 *   路径」，ADR-0005 之后 id 就是 slug 就是文件名，那半本账没有内容了（issue 07）。
 */

export interface Config {
  /** 本地那份博客仓库。**它是固定的中转站**，不是一个可选项（见 `.scratch/blog-deploy/spec.md`）。 */
  repo: string;
  /** Hugo 站点目录，相对 `repo`。 */
  site: string;
  /** 文章放哪，相对 `repo`。 */
  articles: string;
  destinations: Destination[];
}

/** 一次同步留下的痕迹。**只用于显示**——差异永远问云端要，不从这儿猜。 */
export interface SyncRecord {
  at: number;
  added: number;
  changed: number;
  deleted: number;
}

export interface PublishStore {
  config(): Promise<{ config: Config | null; problems: string[] }>;
  syncs(): Promise<Record<string, SyncRecord>>;
  recordSync(destination: string, record: SyncRecord): Promise<void>;
}

/** 账本整个的形状：按去处。老账本里的 `sent` 读到就丢，写回时不带。 */
interface Ledger {
  syncs?: Record<string, SyncRecord>;
}

const TOP = ["repo", "site", "articles"] as const;
const FIELDS = ["name", "host", "path", "baseURL"] as const;

const text = (value: unknown): boolean => typeof value === "string" && value !== "";

export function parseConfig(raw: string): { config: Config | null; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: null, problems: ["destinations.json 不是合法的 JSON"] };
  }

  /**
   * **认出上一版的形状。**
   *
   * 上一轮（ADR-0003）这份文件是个数组，每条带 `repo`/`branch`/`articles`——那时候
   * 「去处」指的是本地一份 git 工作副本。因为字段对不上就显示成「还没有去处」的话，
   * 人会以为配置丢了，然后重写一份，而旧的那份还在原地。
   */
  if (Array.isArray(parsed)) {
    return {
      config: null,
      problems: [
        "这是上一版的配置（一个数组，每条带 repo/branch/articles）。现在「去处」指的是一个云端站点：" +
          "外层改成对象，填 repo / site / articles，去处放进 destinations，每条写 name / host / path / baseURL。",
      ],
    };
  }

  const row = (parsed ?? {}) as Partial<Config>;
  const problems: string[] = [];

  const missing = TOP.filter((key) => !text(row[key]));
  if (missing.length > 0) problems.push(`最外层缺${missing.join("、")}`);

  const list: Destination[] = [];
  const incoming = Array.isArray(row.destinations) ? row.destinations : [];
  incoming.forEach((one, at) => {
    const each = one as Partial<Record<(typeof FIELDS)[number], unknown>>;
    const gaps = FIELDS.filter((key) => !text(each[key]));
    if (gaps.length > 0) {
      problems.push(`第 ${at + 1} 个去处缺${gaps.join("、")}`);
      return;
    }
    const destination = each as unknown as Destination;
    // 名字是账本里的键，重了就会把两个去处的记录搅在一起。
    if (list.some((had) => had.name === destination.name)) {
      problems.push(`有两个去处都叫「${destination.name}」`);
      return;
    }
    // baseURL 写错的后果是整站链接全废，**而页面看起来完全正常**。
    if (!/^https?:\/\//.test(destination.baseURL)) {
      problems.push(`「${destination.name}」的 baseURL 得是 http:// 或 https:// 开头`);
      return;
    }
    if (!destination.baseURL.endsWith("/")) {
      problems.push(`「${destination.name}」的 baseURL 结尾要有斜杠`);
      return;
    }
    /**
     * 声明了图片传别处，却没把 `images/` 从 rsync 里排掉——那 62 MB 会照样往那台
     * 机器上传一遍，然后没人用。**报出来，不猜他想干什么。**
     */
    if (destination.images !== undefined && !(destination.exclude ?? []).some((one) => one.startsWith("images"))) {
      problems.push(`「${destination.name}」说了图片传 OSS，却没有 exclude: ["images/"]——两份都会传`);
    }
    list.push(destination);
  });

  if (incoming.length === 0) problems.push("一个去处都没有");
  if (missing.length > 0 || list.length === 0) return { config: null, problems };

  return { config: { repo: row.repo!, site: row.site!, articles: row.articles!, destinations: list }, problems };
}

export function createPublishStore(root: string): PublishStore {
  const configFile = path.join(root, "destinations.json");
  const ledgerFile = path.join(root, "published.json");

  const readLedger = async (): Promise<Ledger> => {
    const raw = await readFile(ledgerFile, "utf8").catch(() => null);
    if (raw === null) return {};
    try {
      return JSON.parse(raw) as Ledger;
    } catch {
      // 账本坏了不该让「送出去」整个瘫掉：最坏的后果是这一篇被当成没发过，
      // 而那只是多一次确认，不是丢东西。
      return {};
    }
  };

  const write = async (next: Ledger): Promise<void> => {
    await mkdir(root, { recursive: true });
    await writeFile(ledgerFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  };

  return {
    async config() {
      // 没有这个文件是正常状态：还没配过。
      const raw = await readFile(configFile, "utf8").catch(() => null);
      return raw === null ? { config: null, problems: [] } : parseConfig(raw);
    },

    async syncs() {
      return (await readLedger()).syncs ?? {};
    },

    async recordSync(destination, record) {
      const all = await readLedger();
      // **记另一个去处，前一个还在**：摊开再写，不是整个换掉。
      await write({ syncs: { ...(all.syncs ?? {}), [destination]: record } });
    },
  };
}

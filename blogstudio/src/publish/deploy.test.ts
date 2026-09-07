import { describe, expect, it } from "vitest";
import type { CloudSite, Destination, Probe } from "./cloud-site";
import type { Changes } from "./rsync-plan";
import { previewSync, syncOnly, type Config, type ImageSide } from "./deploy";

const CN: Destination = {
  name: "moyutianzun.cn",
  host: "myblog-preview",
  path: "/srv/blog",
  baseURL: "https://moyutianzun.cn/",
};

const CONFIG: Config = {
  repo: "/repo",
  site: "site",
  articles: "site/content/blog",
  destinations: [CN],
};

function fakes(
  over: {
    probe?: Partial<Probe>;
    changes?: Partial<Changes>;
    /** OSS 那边已经有哪几张。 */
    there?: string[];
    /** `false` = 这个去处的图跟着 rsync 走，没有单独一步。 */
    target?: false;
  } = {},
) {
  const built: string[][] = [];
  const synced: string[] = [];
  const planned: string[] = [];

  const changes: Changes = { added: ["blog/a/index.html"], changed: [], deleted: [], ...over.changes };
  const site: CloudSite = {
    probe: async () => ({ exists: true, looksLikeSite: true, slugs: [], ...over.probe }),
    plan: async (dir) => {
      planned.push(dir);
      return changes;
    },
    sync: async (dir) => {
      synced.push(dir);
      return changes;
    },
  };

  const build = async (args: string[]) => void built.push(args);

  /** 图片这一侧。`target: null` = 图片跟正文一起走 rsync（`.com` 那种）。 */
  const uploaded: string[][] = [];
  const there: string[] = over.there ?? [];
  const images = (needed: string[] = []): ImageSide => ({
    target:
      over.target === false
        ? null
        : { list: async () => there, put: async (_dir, names) => void uploaded.push(names) },
    needed,
    dir: "/repo/site/static/images",
  });

  return { site, build, built, synced, planned, images, uploaded };
}

describe("syncOnly —— 构建、同步", () => {
  it("两段依次做完，回报同步的结果", async () => {
    const it_ = fakes();
    const out = await syncOnly(CONFIG, CN, it_.site, it_.build, it_.images());

    // 构建带的是这个去处的 baseURL 和它自己的产物目录。
    expect(it_.built[0]).toContain("https://moyutianzun.cn/");
    expect(it_.built[0]![it_.built[0]!.indexOf("-d") + 1]).toBe("/repo/site/public-moyutianzun.cn");
    // 同步的是刚构建出来的那个目录，不是别的。
    expect(it_.synced).toEqual(["/repo/site/public-moyutianzun.cn"]);
    expect(out.changes.added).toEqual(["blog/a/index.html"]);
  });

  it("**只传那边没有的那几张**", async () => {
    const it_ = fakes({ there: ["旧图.png"] });
    const out = await syncOnly(CONFIG, CN, it_.site, it_.build, it_.images(["旧图.png", "新图.png"]));
    expect(it_.uploaded).toEqual([["新图.png"]]);
    expect(out.images).toEqual(["新图.png"]);
  });

  it("**图片先传，正文后同步**", async () => {
    // 反过来的话，中间那段时间页面上是一排破图。
    const order: string[] = [];
    const it_ = fakes();
    it_.site.sync = async () => {
      order.push("同步正文");
      return { added: [], changed: [], deleted: [] };
    };
    const side = {
      ...it_.images(["新图.png"]),
      target: { list: async () => [], put: async () => void order.push("传图") },
    };
    await syncOnly(CONFIG, CN, it_.site, it_.build, side);
    expect(order).toEqual(["传图", "同步正文"]);
  });

  it("图跟着 rsync 走的去处（`.com`），没有单独那一步", async () => {
    const it_ = fakes({ target: false });
    const out = await syncOnly(CONFIG, CN, it_.site, it_.build, it_.images(["随便几张.png"]));
    expect(it_.uploaded).toEqual([]);
    expect(out.images).toEqual([]);
  });

  it("**云端不像站点就停在同步之前**——构建已经做了，失败停在哪一段要说得出来", async () => {
    const it_ = fakes({ probe: { looksLikeSite: false } });
    // 让 sync 自己抛，跟真适配器一样。
    it_.site.sync = async () => {
      throw new Error("里没有 index.html，不像一个站点");
    };
    await expect(syncOnly(CONFIG, CN, it_.site, it_.build, it_.images())).rejects.toThrow("不像一个站点");
    expect(it_.built).toHaveLength(1);
  });
});

describe("previewSync —— 干跑", () => {
  it("先构建，然后问云端会动什么，**不写任何东西**", async () => {
    const it_ = fakes({ changes: { deleted: ["blog/old/index.html"] } });
    const out = await previewSync(CONFIG, CN, it_.site, it_.build, it_.images());
    expect(it_.built).toHaveLength(1);
    expect(it_.planned).toEqual(["/repo/site/public-moyutianzun.cn"]);
    expect(it_.synced).toEqual([]);
    expect(out.deleted).toEqual(["blog/old/index.html"]);
  });

  it("**预览要说出图这一侧**，而且一张都不传", async () => {
    const it_ = fakes({ there: ["旧图.png"] });
    const out = await previewSync(CONFIG, CN, it_.site, it_.build, it_.images(["旧图.png", "新图.png"]));
    expect(out.images).toEqual(["新图.png"]);
    expect(it_.uploaded).toEqual([]);
  });
});

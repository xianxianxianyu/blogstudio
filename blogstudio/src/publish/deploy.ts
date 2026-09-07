import path from "node:path";
import { buildArgs, outDirOf } from "./build";
import type { CloudSite, Destination } from "./cloud-site";
import type { Changes } from "./rsync-plan";
import { imagesToUpload, type ImageTarget } from "./image-target";

export type { Config } from "./publish-store";
import type { Config } from "./publish-store";

/**
 * 同步 = **构建 → 同步**，两段。
 *
 * 文章从哪儿来这一层不管：上架、下架、改标签、删除全是改本地文件（`../blog/`），
 * 改完之后唯一要做的事就是这一条——它不是「顺带做的」，它是那几个操作的出口。
 *
 * 上一版这里还有前两段「翻译稿子 → 写进仓库」（按稿子发布）。ADR-0005 之后稿子退休、
 * 统一目录就是仓库，那两段连同 `prepare`/`deploy` 一起删掉了——留着的话它读的是一个
 * 已经退休的目录，而界面上没有任何地方会调它。
 *
 * **只有同步不可逆**（`rsync --delete`），所以它在 `CloudSite.sync` 里自己还有一道 probe。
 */

/** 跑一次 hugo。**端口**：这一层不认识 child_process。 */
export type Build = (args: string[]) => Promise<void>;

export interface Deployed {
  changes: Changes;
  /** 这次传上去的图。**跟正文分开报**——它们走的不是同一条路。 */
  images: string[];
  at: number;
}

/**
 * 图片这一侧要做什么。
 *
 * `target` 为 `null` 表示**图片跟正文一起走 rsync**（`.com` 就是这样）——那就没有
 * 单独的一步，`images` 永远是空的。
 */
export interface ImageSide {
  target: ImageTarget | null;
  /** 这次发布的内容用到哪几张图（从索引来）。 */
  needed: string[];
  /** 图片在本地哪个目录。 */
  dir: string;
}

/** 这次要传哪几张。**不传就不知道**——问那边要，不猜。 */
async function pendingImages(side: ImageSide): Promise<string[]> {
  if (side.target === null) return [];
  return imagesToUpload(side.needed, await side.target.list());
}

/** 把本地现在这一份推上去。 */
export async function syncOnly(
  config: Config,
  destination: Destination,
  site: CloudSite,
  build: Build,
  images: ImageSide,
): Promise<{ changes: Changes; images: string[] }> {
  /**
   * **图片先传。**
   *
   * 顺序是有意的：正文先上线、图片后到的话，中间那段时间页面上是一排破图；
   * 反过来只是多了几张暂时没人引用的图，而那没有任何坏处。
   */
  const pending = await pendingImages(images);
  if (images.target !== null && pending.length > 0) await images.target.put(images.dir, pending);

  // **一个去处一个 baseURL、一个产物目录**（`build.ts`）。
  const siteRoot = path.join(config.repo, config.site);
  await build(buildArgs(siteRoot, destination));
  return { changes: await site.sync(outDirOf(siteRoot, destination)), images: pending };
}

/** 干跑：这次同步会动什么。**不写任何东西**，但要先构建才知道。 */
export async function previewSync(
  config: Config,
  destination: Destination,
  site: CloudSite,
  build: Build,
  images: ImageSide,
): Promise<Changes & { images: string[] }> {
  const siteRoot = path.join(config.repo, config.site);
  await build(buildArgs(siteRoot, destination));
  return {
    ...(await site.plan(outDirOf(siteRoot, destination))),
    // **预览要说出图这一侧**，否则「同步」会悄悄多做一件事。
    images: await pendingImages(images),
  };
}

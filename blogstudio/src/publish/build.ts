import path from "node:path";
import type { Destination } from "./cloud-site";
import { slugOf } from "./slug";

/**
 * 构建一份给某个去处的产物。
 *
 * 这一层只拼参数，不跑 hugo——**最容易出错的正是参数**（少一个 `--baseURL`、
 * 产物目录串了），而那种错的表现是「页面看起来完全正常」。
 */

/**
 * 这个去处的产物放哪。**一个去处一个目录。**
 *
 * 共用 `site/public/` 的话，后同步的那个会带着前一个的绝对链接——`.cn` 的 RSS、
 * sitemap、canonical 全指向 `.com`，而页面看着完全正常，没有任何地方会报错。
 */
export function outDirOf(siteRoot: string, destination: Destination): string {
  /**
   * 名字要过一遍 slug。**去处的名字是人手写的**，而它在这里会变成一个目录名，
   * 紧接着交给 `--cleanDestinationDir`——那个参数会**清空**它指向的目录。
   * 一个写成 `../..` 的名字就是在删别处的东西。
   */
  const safe = slugOf(destination.name);
  if (safe === "") throw new Error(`去处的名字「${destination.name}」没法当目录名`);
  return path.join(siteRoot, `public-${safe}`);
}

export function buildArgs(siteRoot: string, destination: Destination): string[] {
  return [
    "--minify",
    // 不清的话，删掉的那篇文章会在产物里留着，然后被同步上去。rsync 只负责把两边
    // 对齐，而那时候「本地」这一边本身就是脏的。
    "--cleanDestinationDir",
    // **一个去处一个 baseURL。** 这是这一整个文件存在的理由。
    "--baseURL",
    destination.baseURL,
    // 绝对路径，跟当前工作目录无关：相对路径换个目录照样跑得通，只是干在别处——
    // 而这条命令会删东西。
    "-s",
    siteRoot,
    "-d",
    outDirOf(siteRoot, destination),
  ];
  // 不带 `-D` / `-E`：草稿与过期文章不该因为一次部署就上线。Hugo 默认就不带，
  // 这里写下来是为了让「有人哪天想加」这件事必须先读到这行注释。
}

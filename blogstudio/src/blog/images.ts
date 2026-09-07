import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 文章里的图片。**它们跟文章住在同一个仓库里**——`site/static/images/`，
 * Hugo 把 `static/` 原样拷进产物，所以图片跟文章走完全同一条同步链路。
 *
 * 不经过任何图床、任何上传服务、任何凭证：**一张图就是仓库里的一个文件**，
 * 跟一篇文章就是仓库里的一份 markdown 是同一件事（ADR-0011 的形状）。
 */

/** 只收这几种。**认不出就当 png**——从剪贴板粘进来的图常常连文件名都没有。 */
const KINDS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/**
 * 一张图叫什么。**名字由内容决定**（sha256 前 16 位）。
 *
 * 用内容而不是时间戳，是为了**同一张截图粘进两篇文章时只存一份**——而拿时间戳做名字，
 * 同一张图会随粘贴次数增殖，然后你在 `static/images/` 里看到十几张一模一样的东西，
 * 却不敢删任何一张。
 *
 * 原文件名只用来取扩展名，**其余一个字都不进最终名字**：它会变成文件名，也会变成
 * URL 的一截，而它是从外面来的（拖进来的文件、剪贴板）。
 */
export function imageNameOf(bytes: Uint8Array, filename: string): string {
  const dot = filename.lastIndexOf(".");
  const raw = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
  const kind = KINDS.has(raw) ? raw : "png";
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${hash}.${kind}`;
}

/** 正文里用到了哪几张（`<img src=…>` 与 markdown 的 `![](…)` 都认，去重）。 */
export function imagesIn(markdown: string): string[] {
  const found = new Set<string>();
  // `--minify` 之后属性没有引号，所以两种都要认。
  for (const hit of markdown.matchAll(/(?:src=["']?|\]\()\/images\/([^"'\s)>]+)/g)) {
    found.add(hit[1]!);
  }
  return [...found];
}

export interface ImageStore {
  /** 存一张，回报它在正文里该写的路径（`/images/xxx.png`）。 */
  put(bytes: Uint8Array, filename: string): Promise<string>;
  /** 现在有哪些（文件名，不带路径）。 */
  list(): Promise<string[]>;
}

export function createImageStore(repoRoot: string, imagesDir: string): ImageStore {
  const dir = path.join(repoRoot, imagesDir);
  return {
    async put(bytes, filename) {
      const name = imageNameOf(bytes, filename);
      // 每次写之前确保目录在（`article-store.ts` 同一个理由）。
      await mkdir(dir, { recursive: true });
      // 名字由内容决定，所以重复写就是写同样的字节——**不用先查在不在**。
      await writeFile(path.join(dir, name), bytes);
      return `/images/${name}`;
    },
    // 目录还不存在是正常状态：一张图都还没有。
    list: () => readdir(dir).catch(() => [] as string[]),
  };
}

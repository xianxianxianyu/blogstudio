import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Clip } from "./clip";
import type { Screenshot } from "../recognizer/recognizer";

/**
 * 摘录持久化。**一条摘录 = 一个文件夹**（ADR-0011）：
 *
 *     <root>/<docId>/<clipId>/index.md      双语 markdown + frontmatter
 *     <root>/<docId>/<clipId>/.asset/       截图与抠出的图
 *
 * markdown 不是为存储发明的格式——`CONTEXT.md` 说摘录本来就「持有双语 markdown」，
 * 而且它「直接映射到 Blog Studio 的 markdown block（无需格式转换）」。存 SQLite BLOB
 * 反倒要多一层编解码，还让摘录变成不可读的二进制。
 *
 * **文件是唯一真相**，数据库（尚未接入）只当可重建的索引。
 */
export interface ClipStore {
  save(docId: string, clip: Clip): Promise<void>;
  listByDoc(docId: string): Promise<Clip[]>;
  delete(docId: string, clipId: string): Promise<void>;
}

/** frontmatter 的 schema 版本。它是内部存储格式，改结构时靠它辨认旧文件。 */
const SCHEMA_VERSION = 1;

const ASSET_DIR = ".asset";
const SCREENSHOT_FILE = "screenshot";
const MARKDOWN_FILE = "index.md";

interface Frontmatter {
  version: number;
  id: string;
  state: Clip["state"];
  label: Clip["label"];
  /** 保留轴（ADR-0012）。真相在文件里——只存数据库的话，一次索引重建就全丢了。 */
  important: boolean;
  lastViewedAt: number;
  region: Clip["region"];
  /** ClipContent 里除去图片字节的部分——图片另存在 .asset/ 下。 */
  content: {
    route: string;
    anchor: Clip["region"];
    sourceText: string | null;
    translation?: string;
    multimodal?: string;
    /** 抠出的图各自的元数据；字节按下标存在 .asset/image-<i>.<ext>。 */
    images: Omit<Screenshot, "bytes">[];
  } | null;
  screenshot: Omit<Screenshot, "bytes"> | null;
}

const extension = (mime: Screenshot["mime"]) => (mime === "image/png" ? "png" : "jpg");

function render(clip: Clip): string {
  const front: Frontmatter = {
    version: SCHEMA_VERSION,
    id: clip.id,
    state: clip.state,
    label: clip.label,
    important: clip.important,
    lastViewedAt: clip.lastViewedAt,
    region: { ...clip.region, pixels: undefined as never },
    content: clip.content
      ? {
          route: clip.content.route,
          anchor: { page: clip.content.anchor.page, rect: clip.content.anchor.rect } as never,
          sourceText: clip.content.sourceText,
          translation: clip.content.translation,
          multimodal: clip.content.multimodal,
          images: clip.content.images.map(({ mime, width, height }) => ({ mime, width, height })),
        }
      : null,
    screenshot: clip.content
      ? {
          mime: clip.content.screenshot.mime,
          width: clip.content.screenshot.width,
          height: clip.content.screenshot.height,
        }
      : null,
  };

  // 正文按读者读到的顺序排：原文、译文、笔记。手改这个文件是允许的（ADR-0011），
  // 所以它得像一份笔记而不是一坨序列化数据。
  const body = [
    clip.sourceText === null ? null : `## 原文\n\n${clip.sourceText}`,
    clip.translation === null ? null : `## 译文\n\n${clip.translation}`,
    clip.note === null ? null : `## 笔记\n\n${clip.note}`,
  ].filter((section): section is string => section !== null);

  return `---\n${JSON.stringify(front, null, 2)}\n---\n\n${body.join("\n\n")}\n`;
}

function parse(
  markdown: string,
  screenshotBytes: Uint8Array | null,
  imageBytes: Uint8Array[],
): Clip {
  const end = markdown.indexOf("\n---", 4);
  const front = JSON.parse(markdown.slice(4, end)) as Frontmatter;
  const body = markdown.slice(end + 4);

  const section = (title: string): string | null => {
    const start = body.indexOf(`## ${title}\n\n`);
    if (start < 0) return null;
    const from = start + `## ${title}\n\n`.length;
    const next = body.indexOf("\n\n## ", from);
    return (next < 0 ? body.slice(from) : body.slice(from, next)).trim();
  };

  const screenshot: Screenshot | null =
    front.screenshot && screenshotBytes
      ? { ...front.screenshot, bytes: screenshotBytes }
      : null;

  return {
    id: front.id,
    state: front.state,
    region: { ...front.region, pixels: screenshot! },
    content:
      front.content && screenshot
        ? {
            route: front.content.route as "text" | "vision",
            anchor: front.content.anchor as never,
            sourceText: front.content.sourceText,
            ...(front.content.translation === undefined
              ? {}
              : { translation: front.content.translation }),
            ...(front.content.multimodal === undefined
              ? {}
              : { multimodal: front.content.multimodal }),
            // 逐张还原，不拿 screenshot 顶替：canonical 区分「抠出的图」与「整块回显」，
            // 今天它们恰好相等，靠数量重建看着无损——真抠图落地那天就会静默丢数据。
            images: front.content.images.map((meta, index) => ({
              ...meta,
              bytes: imageBytes[index] ?? new Uint8Array(),
            })),
            screenshot,
          }
        : null,
    sourceText: section("原文"),
    translation: section("译文"),
    note: section("笔记"),
    label: front.label,
    // `?? false` 而不是直接取：已经落过盘的摘录都没有这个字段，读成 undefined 的话
    // 回收器那边 `!clip.important` 与 `clip.important === false` 会得到不同答案，
    // 而这类差别通常要等到东西被删掉才发现。
    important: front.important ?? false,
    // 旧文件没有这个字段。落到 0 意味着「很久以前看过」，下次回收就会清掉它——
    // 而它可能是读者昨天刚存的。落到读文件的当下更保守：给它一个完整的保留期，
    // 代价只是晚一个周期回收。**默认值要偏向不丢数据。**
    lastViewedAt: front.lastViewedAt ?? Date.now(),
  };
}

export function createClipStore(root: string): ClipStore {
  const folder = (docId: string, clipId: string) => path.join(root, docId, clipId);

  return {
    async save(docId: string, clip: Clip): Promise<void> {
      const target = folder(docId, clip.id);
      // 先写到临时目录再 rename——同一文件系统上 rename 是原子的，崩溃不会留下半条摘录。
      // 顺序不能反：文件是真相，先落它，索引落后可以靠重建修复（ADR-0011）。
      const staging = `${target}.tmp`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(path.join(staging, ASSET_DIR), { recursive: true });

      if (clip.content) {
        const { screenshot, images } = clip.content;
        await writeFile(
          path.join(staging, ASSET_DIR, `${SCREENSHOT_FILE}.${extension(screenshot.mime)}`),
          screenshot.bytes,
        );
        for (const [index, image] of images.entries()) {
          await writeFile(
            path.join(staging, ASSET_DIR, `image-${index}.${extension(image.mime)}`),
            image.bytes,
          );
        }
      }
      await writeFile(path.join(staging, MARKDOWN_FILE), render(clip), "utf8");

      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    },

    async listByDoc(docId: string): Promise<Clip[]> {
      const dir = path.join(root, docId);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const clips: Clip[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.endsWith(".tmp")) continue;
        const markdown = await readFile(path.join(dir, entry.name, MARKDOWN_FILE), "utf8");
        const assets = await readdir(path.join(dir, entry.name, ASSET_DIR)).catch(() => []);
        const assetPath = (name: string) => path.join(dir, entry.name, ASSET_DIR, name);
        const shot = assets.find((name) => name.startsWith(SCREENSHOT_FILE));
        const bytes = shot ? new Uint8Array(await readFile(assetPath(shot))) : null;

        const images: Uint8Array[] = [];
        for (
          let index = 0, name = assets.find((n) => n.startsWith(`image-${index}.`));
          name !== undefined;
          index++, name = assets.find((n) => n.startsWith(`image-${index}.`))
        ) {
          images.push(new Uint8Array(await readFile(assetPath(name))));
        }

        clips.push(parse(markdown, bytes, images));
      }

      return clips;
    },

    async delete(docId: string, clipId: string): Promise<void> {
      await rm(folder(docId, clipId), { recursive: true, force: true });
    },
  };
}

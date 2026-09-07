import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTags, type Tag } from "./tag";

/**
 * 标签表落在书架根上：`<root>/tags.md`。
 *
 * 与 `index.md` 同一种 markdown + frontmatter 形式，理由和那边一样——它要能被人
 * 打开来看、能手改（ADR-0011）。正文写成一份人读的清单，不是一坨序列化数据。
 *
 * **摘录只存 `tagId`，名字不冗余进摘录文件**：改名不该重写几百个文件。这不违反
 * 「文件是唯一真相」——那条针对的是摘录的**内容**（原文、译文、笔记、截图）必须在
 * 索引丢失后还能重建，而 `tags.md` 自己也是磁盘上的文件，不是数据库。
 */

const TAGS_FILE = "tags.md";
const SCHEMA_VERSION = 1;

export interface TagStore {
  load(): Promise<Tag[]>;
  save(tags: Tag[]): Promise<void>;
}

function render(tags: Tag[]): string {
  const front = JSON.stringify({ version: SCHEMA_VERSION, tags }, null, 2);
  const list = tags.map((tag) => `- ${tag.name}（${tag.id}）`).join("\n");
  return `---\n${front}\n---\n\n# 标签\n\n${list}\n`;
}

function parse(markdown: string): Tag[] {
  const end = markdown.indexOf("\n---", 4);
  const { tags } = JSON.parse(markdown.slice(4, end)) as { tags: Tag[] };
  return normalizeTags(tags);
}

export function createTagStore(root: string): TagStore {
  const file = path.join(root, TAGS_FILE);

  return {
    async load(): Promise<Tag[]> {
      const markdown = await readFile(file, "utf8").catch(() => null);
      // 文件不在（首次打开）或被改坏了，都退回默认的五个而不是空表：读者点开调色盘
      // 看到五个没名字的色块，只会以为功能坏了。
      if (markdown === null) return normalizeTags([]);
      try {
        return parse(markdown);
      } catch {
        return normalizeTags([]);
      }
    },

    async save(tags: Tag[]): Promise<void> {
      // **每次写之前都保证目录在**，不是靠调用方启动时建过一次。
      // `local-api.ts` 那句 `mkdirSync(libraryRoot)` 的语义是「首次运行把家搭起来」；
      // 把 store 的正确性挂在它上面，就等于挂在「调用方启动时做过什么」上——
      // 目录中途没了的话，改标记名会一直 ENOENT 到重启为止，而界面上只有一句
      // 「保存失败」。`mkdir -p` 在目录已存在时几乎不花什么。
      await mkdir(root, { recursive: true });
      await writeFile(file, render(normalizeTags(tags)), "utf8");
    },
  };
}

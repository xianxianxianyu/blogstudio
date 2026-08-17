import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Section } from "../clip/outline";

/**
 * 生成的目录落在这本书自己的文件夹里：`<root>/<docId>/outline.md`。
 *
 * 与 `index.md`、摘录的 `index.md` 同一种形状：frontmatter 放机器读的，正文放人读的
 * （ADR-0011——文件是唯一真相，且**允许手改**）。这一点在这里格外要紧：自动解析出来的
 * 目录，英文书上三项全对只有 57%，中文侧一条公开数据都没有。**手改是主路径不是逃生
 * 口**，所以它得长得像一份可以直接编辑的大纲。
 *
 * 跟 PDF 自带的目录谁优先：**这一份优先**。读者会去生成，正是因为自带的没有或不好用；
 * 自带的后来冒出来，不该把手工修过的覆盖掉。
 */

const OUTLINE_FILE = "outline.md";
const SCHEMA_VERSION = 1;

export interface OutlineStore {
  /** 没有生成过就返回 null——与「生成了一份空目录」不是一回事。 */
  load(docId: string): Promise<Section[] | null>;
  save(docId: string, sections: Section[]): Promise<void>;
  remove(docId: string): Promise<void>;
}

function render(sections: Section[]): string {
  const front = JSON.stringify({ version: SCHEMA_VERSION, sections }, null, 2);
  // 正文按 markdown 的标题层级写，缩进即层级——手改的人不用看 frontmatter 也知道结构。
  const body = sections
    .map((section) => `${"  ".repeat(section.level)}- ${section.title} · 第 ${section.page} 页`)
    .join("\n");
  return `---\n${front}\n---\n\n# 目录\n\n> 自动识别，可能有错，改这里或在应用里改都行。\n\n${body}\n`;
}

function parse(markdown: string): Section[] {
  const end = markdown.indexOf("\n---", 4);
  const { sections } = JSON.parse(markdown.slice(4, end)) as { sections: Section[] };
  return sections;
}

export function createOutlineStore(root: string): OutlineStore {
  const file = (docId: string) => path.join(root, docId, OUTLINE_FILE);

  return {
    async load(docId: string): Promise<Section[] | null> {
      const markdown = await readFile(file(docId), "utf8").catch(() => null);
      if (markdown === null) return null;
      try {
        return parse(markdown);
      } catch {
        // 手改坏了不该让书打不开：退回「没有生成过」，摘录栏自动按页排。
        return null;
      }
    },

    async save(docId: string, sections: Section[]): Promise<void> {
      await writeFile(file(docId), render(sections), "utf8");
    },

    async remove(docId: string): Promise<void> {
      await rm(file(docId), { force: true });
    },
  };
}

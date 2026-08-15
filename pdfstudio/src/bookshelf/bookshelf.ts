import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 书架：读者手上的 PDF 都住在这儿。
 *
 * **一个文档一个文件夹**，摘录住在里面（`clips/` 由 `ClipStore` 管）：
 *
 *     <root>/<docId>/document.pdf   原样复制进来的字节
 *     <root>/<docId>/index.md       书名、文件名、导入时间
 *     <root>/<docId>/clips/…        这篇文档下的摘录
 *
 * 分成两棵树的话，删一个文档会在另一棵里留下孤儿摘录——而孤儿摘录的锚点指向一份
 * 已经不存在的 PDF，永远打不开。合成一棵，删文档就是删一个文件夹。
 */
export interface Doc {
  /** 内容哈希。见 `import` 的注释——它不来自文件名。 */
  id: string;
  title: string;
  filename: string;
  importedAt: number;
}

export interface ImportRequest {
  filename: string;
  bytes: Uint8Array;
  /** 导入时刻由调用方给，理由和 reducer 那边一样：这一层也不该自己去看时钟。 */
  at: number;
}

export interface Bookshelf {
  import(request: ImportRequest): Promise<Doc>;
  list(): Promise<Doc[]>;
  read(docId: string): Promise<Uint8Array>;
  rename(docId: string, title: string): Promise<void>;
  remove(docId: string): Promise<void>;
}

/** `index.md` frontmatter 的 schema 版本，与摘录那份各走各的。 */
const SCHEMA_VERSION = 1;

const DOCUMENT_FILE = "document.pdf";
const META_FILE = "index.md";

function render(doc: Doc): string {
  return `---\n${JSON.stringify({ version: SCHEMA_VERSION, ...doc }, null, 2)}\n---\n\n# ${doc.title}\n`;
}

function parse(markdown: string): Doc {
  const front = JSON.parse(markdown.split("---")[1]) as Doc;
  return { id: front.id, title: front.title, filename: front.filename, importedAt: front.importedAt };
}

export function createBookshelf(root: string): Bookshelf {
  const folder = (docId: string) => path.join(root, docId);

  return {
    /**
     * id 是**内容的 sha-256**，不掺文件名。
     *
     * 于是同一篇论文再导入一次就是同一条，已有的摘录原样接上——读者的心智本来就是
     * 「这就是那篇论文」。用随机 id 的话再导入一次会变成一篇新文档，摘录全部对不上；
     * 掺进文件名的话，在 Finder 里改个名就等于丢摘录。
     */
    async import({ filename, bytes, at }: ImportRequest): Promise<Doc> {
      const id = createHash("sha256").update(bytes).digest("hex");
      const target = folder(id);

      // 已经在架上就直接返回原条目。第二次导入是「我又拖了一次同一个文件」，
      // 不是「把我改过的书名和导入时间清掉」。
      const existing = await readFile(path.join(target, META_FILE), "utf8").catch(() => null);
      if (existing !== null) return parse(existing);

      const doc: Doc = { id, title: filename.replace(/\.pdf$/i, ""), filename, importedAt: at };

      // 与 ClipStore 同样的落盘姿势：先写临时目录再 rename（同一文件系统上原子），
      // 崩溃不会在架上留下一本只有元数据、没有 PDF 的书。
      const staging = `${target}.tmp`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, DOCUMENT_FILE), bytes);
      await writeFile(path.join(staging, META_FILE), render(doc), "utf8");
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);

      return doc;
    },

    async list(): Promise<Doc[]> {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const docs: Doc[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.endsWith(".tmp")) continue;
        const markdown = await readFile(path.join(root, entry.name, META_FILE), "utf8").catch(() => null);
        if (markdown !== null) docs.push(parse(markdown));
      }

      return docs.sort((a, b) => a.importedAt - b.importedAt);
    },

    async read(docId: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(path.join(folder(docId), DOCUMENT_FILE)));
    },

    async rename(docId: string, title: string): Promise<void> {
      const file = path.join(folder(docId), META_FILE);
      await writeFile(file, render({ ...parse(await readFile(file, "utf8")), title }), "utf8");
    },

    async remove(docId: string): Promise<void> {
      // 一个文件夹装下 PDF、元数据和全部摘录，所以删除就是删它——不需要再去
      // 别处清一遍，也就不会漏。
      await rm(folder(docId), { recursive: true, force: true });
    },
  };
}

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBookshelf } from "./bookshelf";
import { createClipStore } from "../clip/clip-store";
import type { Clip } from "../clip/clip";
import type { Screenshot } from "../recognizer/recognizer";

/** 不是合法 PDF 也无妨：书架只管字节进出与去重，不解析内容。 */
const PAPER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x01]);
const OTHER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x02]);

const IMPORTED_AT = 1_700_000_000_000;

const shelf = async () => createBookshelf(await mkdtemp(path.join(tmpdir(), "shelf-")));

const PIXELS: Screenshot = { mime: "image/png", bytes: new Uint8Array([1]), width: 4, height: 4 };

const clip = (id: string, docPage = 1): Clip => ({
  id,
  state: "ready",
  region: { page: docPage, rect: { x: 1, y: 2, width: 30, height: 40 }, pixels: PIXELS },
  content: {
    route: "text",
    anchor: { page: docPage, rect: { x: 1, y: 2, width: 30, height: 40 } },
    sourceText: "Attention",
    images: [],
    screenshot: PIXELS,
  },
  sourceText: "Attention",
  translation: null,
  note: null,
  label: "dot",
  important: false,
    tagId: null,
  lastViewedAt: IMPORTED_AT,
});

describe("书架", () => {
  it("导入后能逐字节读回来", async () => {
    // PDF 是地面真值：锚点回跳、墓碑重新识别都指着它。存进来的字节和读出去的
    // 差一个 byte，pdf.js 那侧就是另一份文档了。
    const target = await shelf();
    const doc = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });

    expect(new Uint8Array(await target.read(doc.id))).toEqual(PAPER);
  });

  it("同一篇论文导入两次是同一条，不重复", async () => {
    // **这是内容哈希唯一真正的理由。** 用随机 id 的话再导入一次就是一篇新文档，
    // 你已有的摘录全部对不上——而读者的心智是「这就是那篇论文」。
    const target = await shelf();
    const first = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });
    const again = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT + 1 });

    expect(again.id).toBe(first.id);
    expect(await target.list()).toHaveLength(1);
  });

  it("文件名改了还是同一条", async () => {
    // 你在 Finder 里把它改成「1706.03762v7.pdf」，它仍是同一篇论文。
    // id 只能来自内容，一旦掺进文件名，改名就等于丢摘录。
    const target = await shelf();
    const first = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });
    const renamed = await target.import({ filename: "1706.03762v7.pdf", bytes: PAPER, at: IMPORTED_AT });

    expect(renamed.id).toBe(first.id);
  });

  it("不同的论文是不同的条目", async () => {
    const target = await shelf();
    const a = await target.import({ filename: "a.pdf", bytes: PAPER, at: IMPORTED_AT });
    const b = await target.import({ filename: "b.pdf", bytes: OTHER, at: IMPORTED_AT });

    expect(b.id).not.toBe(a.id);
    expect(await target.list()).toHaveLength(2);
  });

  it("重复导入不覆盖已有的书名与导入时间", async () => {
    // 读者可能已经改过书名。第二次导入是「我又拖了一次同一个文件」，
    // 不是「把我的编辑清掉」。
    const target = await shelf();
    const doc = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });
    await target.rename(doc.id, "Attention Is All You Need");
    await target.import({ filename: "另存一份.pdf", bytes: PAPER, at: IMPORTED_AT + 999 });

    const [back] = await target.list();
    expect(back.title).toBe("Attention Is All You Need");
    expect(back.importedAt).toBe(IMPORTED_AT);
  });

  it("书名默认取文件名去掉后缀", async () => {
    const target = await shelf();
    const doc = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });

    expect(doc.title).toBe("attention");
  });

  it("删掉文档，它的摘录一起没", async () => {
    // 一个文档一个文件夹，摘录住在里面。分成两棵树的话删文档会留下孤儿摘录
    // ——而孤儿摘录的锚点指向一份已经不存在的 PDF，永远打不开。
    const root = await mkdtemp(path.join(tmpdir(), "shelf-"));
    const target = createBookshelf(root);
    const doc = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });
    const clips = createClipStore(root);
    await clips.save(doc.id, clip("c1"));
    expect(await clips.listByDoc(doc.id)).toHaveLength(1);

    await target.remove(doc.id);

    expect(await target.list()).toEqual([]);
    expect(await clips.listByDoc(doc.id)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("原文件留在书架里，不是引用原路径", async () => {
    // ADR-0012 的墓碑要「按锚点重新识别」，前提是 PDF 还在。引用原路径的话，
    // 读者在 Finder 里挪一下文件，所有墓碑和锚点回跳就静默失效了。
    const root = await mkdtemp(path.join(tmpdir(), "shelf-"));
    const target = createBookshelf(root);
    const doc = await target.import({ filename: "attention.pdf", bytes: PAPER, at: IMPORTED_AT });

    expect(new Uint8Array(await readFile(path.join(root, doc.id, "document.pdf")))).toEqual(PAPER);
  });
});

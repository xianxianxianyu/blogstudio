import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTags, normalizeTags, renameTag, TAG_COLORS } from "./tag";
import { createTagStore } from "./tag-store";

const store = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tagstore-"));
  return { root, tags: createTagStore(root) };
};

describe("标签表", () => {
  it("文件不存在时给默认的五个，而不是空表", async () => {
    const { tags } = await store();

    // 空表的话，读者第一次点开调色盘看到五个没名字的色块，只会以为功能坏了。
    expect(await tags.load()).toEqual(defaultTags());
  });

  it("存进去读出来，五条一模一样", async () => {
    const { tags } = await store();
    const renamed = renameTag(defaultTags(), "pink", "反例");

    await tags.save(renamed);

    expect(await tags.load()).toEqual(renamed);
  });

  it("手改坏了也补齐成五条——文件可以手改，就不能因为改错一个字少一格", async () => {
    const { root, tags } = await store();

    await writeFile(
      path.join(root, "tags.md"),
      // 少了三条、多一个不认识的颜色、名字是空白
      `---\n${JSON.stringify({
        version: 1,
        tags: [{ id: "blue", name: "术语" }, { id: "green", name: "   " }, { id: "teal", name: "青" }],
      })}\n---\n`,
      "utf8",
    );

    const loaded = await tags.load();

    expect(loaded.map((tag) => tag.id)).toEqual(TAG_COLORS);
    expect(loaded.find((tag) => tag.id === "blue")?.name).toBe("术语");
    // 空白名退回默认，而不是留一个看不见名字的标签
    expect(loaded.find((tag) => tag.id === "green")?.name).toBe("读懂了");
  });

  it("文件被彻底改烂时退回默认，而不是抛错让阅读页打不开", async () => {
    const { root, tags } = await store();
    await writeFile(path.join(root, "tags.md"), "这不是 frontmatter", "utf8");

    expect(await tags.load()).toEqual(defaultTags());
  });

  it("落盘的是可读的 markdown，名字和颜色都在正文里", async () => {
    const { root, tags } = await store();

    await tags.save(renameTag(defaultTags(), "pink", "反例"));
    const markdown = await readFile(path.join(root, "tags.md"), "utf8");

    expect(markdown).toContain("# 标签");
    expect(markdown).toContain("- 反例（pink）");
  });

  it("改名只改那一条，其余四条原样", async () => {
    const renamed = renameTag(defaultTags(), "blue", "定义");

    expect(renamed.find((tag) => tag.id === "blue")?.name).toBe("定义");
    expect(renamed.filter((tag) => tag.id !== "blue")).toEqual(
      defaultTags().filter((tag) => tag.id !== "blue"),
    );
  });

  it("改成空白名退回默认——标签不能没有名字", async () => {
    expect(renameTag(defaultTags(), "blue", "   ").find((tag) => tag.id === "blue")?.name).toBe(
      "术语",
    );
  });

  it("归一是按固定顺序，不跟着文件里的顺序走", () => {
    const shuffled = [...defaultTags()].reverse();

    // 调色盘的色序必须稳定：今天紫在最左、明天黄在最左，肌肉记忆就废了。
    expect(normalizeTags(shuffled).map((tag) => tag.id)).toEqual(TAG_COLORS);
  });
});

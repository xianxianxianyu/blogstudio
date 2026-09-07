import { describe, expect, it } from "vitest";
import { putFields, readFields } from "./fields";

const HAD = [
  "---",
  'title: "旧标题"',
  'date: "2026-03-05T17:06:39+08:00"',
  "draft: false",
  "categories: [agent]",
  "tags: [agent, 多agent]",
  "---",
  "",
  "正文。",
].join("\n");

describe("readFields", () => {
  it("读出顶层那几个", () => {
    expect(readFields(HAD)).toEqual({
      title: '"旧标题"',
      date: '"2026-03-05T17:06:39+08:00"',
      draft: "false",
      categories: "[agent]",
      tags: "[agent, 多agent]",
    });
  });

  it("嵌在别的键底下的不算顶层", () => {
    // PaperMod 的 `cover:` 底下就有一个 `title`。
    const nested = ["---", "cover:", '  title: "封面"', 'title: "真的"', "---"].join("\n");
    expect(readFields(nested).title).toBe('"真的"');
  });

  it("同名键取**第一个**", () => {
    // YAML 自己也是这么定的。取最后一个的话，一份被手改坏、留了两行 title 的文件，
    // 界面上显示的和 Hugo 渲染的会是两个不同的标题。
    const twice = ["---", 'title: "第一个"', 'title: "第二个"', "---"].join("\n");
    expect(readFields(twice).title).toBe('"第一个"');
  });

  it("没有 frontmatter 就是空", () => {
    expect(readFields("# 只有正文")).toEqual({});
  });
});

describe("putFields", () => {
  it("换掉一个，别的一个字都不动", () => {
    const out = putFields(HAD, { title: '"新标题"' });
    expect(out).toContain('title: "新标题"');
    expect(out).toContain('date: "2026-03-05T17:06:39+08:00"');
    expect(out).toContain("categories: [agent]");
    expect(out).toContain("tags: [agent, 多agent]");
    expect(out).toContain("正文。");
    expect(out).not.toContain("旧标题");
  });

  it("原来没有的键，补在 frontmatter 末尾", () => {
    expect(putFields(HAD, { weight: "10" })).toContain("weight: 10");
  });

  it("**换掉多行的列表时，那几行跟着一起走**", () => {
    // 只换 `tags:` 那一行的话，`- a` `- b` 会变成孤儿——YAML 直接坏掉，
    // 而 Hugo 报的错跟这件事看不出关系。
    const block = ["---", 'title: "题"', "tags:", "  - a", "  - b", "draft: false", "---", "", "正文"].join("\n");
    const out = putFields(block, { tags: "[c]" });
    expect(out).toBe(["---", 'title: "题"', "tags: [c]", "draft: false", "---", "", "正文"].join("\n"));
  });

  it("不缩进的列表项也算那个键的一部分", () => {
    // `tags:` 后面跟不缩进的 `- a` 同样是合法 YAML。
    const flat = ["---", "tags:", "- a", "- b", "draft: false", "---"].join("\n");
    expect(putFields(flat, { tags: "[c]" })).toBe(["---", "tags: [c]", "draft: false", "---"].join("\n"));
  });

  it("换掉的是顶层那个，不是嵌套里那个", () => {
    const nested = ["---", "cover:", '  title: "封面"', 'title: "旧"', "---", "", "正文"].join("\n");
    const out = putFields(nested, { title: '"新"' });
    expect(out).toContain('  title: "封面"');
    expect(out).toContain('title: "新"');
    expect(out).not.toContain('title: "旧"');
  });

  it("整篇没有 frontmatter 时，造一份出来，正文原样留着", () => {
    const out = putFields("# 只有正文\n\n一段。", { title: '"题"', draft: "true" });
    expect(out).toBe(['---', 'title: "题"', "draft: true", "---", "", "# 只有正文", "", "一段。"].join("\n"));
  });

  it("正文里的 `---` 不会被当成 frontmatter 的结尾之后的东西弄丢", () => {
    const withRule = ["---", 'title: "题"', "---", "", "正文", "", "---", "", "分隔线之后"].join("\n");
    const out = putFields(withRule, { title: '"新"' });
    expect(out).toContain("分隔线之后");
    expect(out.match(/^---$/gm)).toHaveLength(3);
  });
});

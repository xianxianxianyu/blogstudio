import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArticleStore } from "./article-store";

const repo = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "blog-"));
  return root;
};
const store = (root: string) => createArticleStore(root, "site/content/blog");
const put = (root: string, name: string, text: string) =>
  writeFile(path.join(root, "site/content/blog", name), text, "utf8");

const REAL = [
  "---",
  'title: "agent系列：（三）context and memory"',
  'date: "2026-03-05T17:06:39+08:00"',
  "draft: false",
  "categories: [agent]",
  "tags: [agent, 多agent]",
  "---",
  "",
  "<p>正文是原始 HTML</p>",
].join("\n");

describe("ArticleStore", () => {
  it("读一篇真实形状的文章", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "x", title: "占位", markdown: "", draft: true });
    await put(root, "agent-三.md", REAL);

    const one = await it_.load("agent-三");
    // updatedAt 是文件的 mtime，跟内容无关，单独看。
    expect(one!.updatedAt).toBeGreaterThan(0);
    expect({ ...one, updatedAt: undefined }).toEqual({
      updatedAt: undefined,
      slug: "agent-三",
      title: "agent系列：（三）context and memory",
      date: "2026-03-05T17:06:39+08:00",
      draft: false,
      categories: ["agent"],
      tags: ["agent", "多agent"],
      markdown: "<p>正文是原始 HTML</p>",
    });
  });

  it("**没有 frontmatter 的文件也收**，标题退回正文第一个标题行", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "seed", title: "占位", markdown: "", draft: true });
    await put(root, "手写的.md", "# 我是手写的\n\n正文。");

    const one = await it_.load("手写的");
    expect(one!.title).toBe("我是手写的");
    // 没标记就当在架——那 92 篇里有的就没有 draft 字段。
    expect(one!.draft).toBe(false);
    expect(one!.markdown).toBe("# 我是手写的\n\n正文。");
  });

  it("去引号只去成对的那两个，别把标题里的引号啃掉", async () => {
    // 标题里带引号是常事（英寸、引述）。一律 replace 掉的话，`5" 屏幕` 会变成 `5 屏幕`。
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "seed", title: "占位", markdown: "", draft: true });
    await put(root, "带引号.md", '---\ntitle: 5" 屏幕\n---\n\n正文');
    expect((await it_.load("带引号"))!.title).toBe('5" 屏幕');
  });

  it("**frontmatter 的 title 优先于正文的标题行**", async () => {
    // 那 92 篇的正文里多半没有 H1（Hugo 自己渲染标题），但有的两样都有。
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "seed", title: "占位", markdown: "", draft: true });
    await put(root, "两个.md", '---\ntitle: "frontmatter 的"\n---\n\n# 正文的\n\n一段。');
    expect((await it_.load("两个"))!.title).toBe("frontmatter 的");
  });

  it("存一篇：**别的手写字段一个都不动**", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "seed", title: "占位", markdown: "", draft: true });
    await put(root, "有标签的.md", REAL);

    const one = (await it_.load("有标签的"))!;
    await it_.save({ ...one, tags: ["新标签"] });

    const text = await readFile(path.join(root, "site/content/blog/有标签的.md"), "utf8");
    expect(text).toContain("tags: [新标签]");
    expect(text).toContain("categories: [agent]");
    expect(text).toContain('date: "2026-03-05T17:06:39+08:00"');
    expect(text).toContain("<p>正文是原始 HTML</p>");
  });

  it("**`Article` 类型里没有的字段，也一个都不能丢**", async () => {
    // 这才是真正会丢的那些：PaperMod 的 cover、weight、还有人写的注释。
    // 只测 tags/categories 的话，它们恰好会被原样写回去，测不出重造 frontmatter 的错。
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "seed", title: "占位", markdown: "", draft: true });
    await put(
      root,
      "有花活的.md",
      [
        "---",
        'title: "题"',
        "# 这一行是我写的注释",
        "weight: 10",
        "cover:",
        '  image: "/upload/a.png"',
        '  title: "封面说明"',
        "---",
        "",
        "正文",
      ].join("\n"),
    );

    const one = (await it_.load("有花活的"))!;
    await it_.save({ ...one, title: "新题" });

    const text = await readFile(path.join(root, "site/content/blog/有花活的.md"), "utf8");
    expect(text).toContain("# 这一行是我写的注释");
    expect(text).toContain("weight: 10");
    expect(text).toContain('  image: "/upload/a.png"');
    expect(text).toContain('  title: "封面说明"');
    expect(text).toContain('title: "新题"');
  });

  it("列出来时按日期倒序，新的在前", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "老的", title: "老的", markdown: "", draft: false, date: "2020-01-01T00:00:00+08:00" });
    await it_.save({ slug: "新的", title: "新的", markdown: "", draft: false, date: "2026-01-01T00:00:00+08:00" });
    expect((await it_.list()).map((one) => one.slug)).toEqual(["新的", "老的"]);
  });

  it("列表里在架和下架都在，各自标着", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "在架的", title: "在架的", markdown: "", draft: false });
    await it_.save({ slug: "下架的", title: "下架的", markdown: "", draft: true });
    const all = await it_.list();
    expect(all).toHaveLength(2);
    expect(all.find((one) => one.slug === "下架的")!.draft).toBe(true);
  });

  it("换地址：文件跟着走", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "旧地址", title: "题", markdown: "正文", draft: true });
    await it_.rename("旧地址", "新地址");
    expect(await it_.load("旧地址")).toBeNull();
    expect((await it_.load("新地址"))!.markdown).toBe("正文");
  });

  it("**换到一个已经有人的地址：拒绝**", async () => {
    // 不拦的话就是一篇静悄悄盖掉另一篇。
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "甲", title: "甲", markdown: "甲的正文", draft: true });
    await it_.save({ slug: "乙", title: "乙", markdown: "乙的正文", draft: true });
    await expect(it_.rename("甲", "乙")).rejects.toThrow();
    expect((await it_.load("乙"))!.markdown).toBe("乙的正文");
  });

  it("没有这一篇就是 null，不抛", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "seed", title: "占位", markdown: "", draft: true });
    expect(await it_.load("从来没有过")).toBeNull();
  });

  it("**删除是移进回收站**，不是消失", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "要删的", title: "要删的", markdown: "正文原样", draft: false });

    const gone = await it_.remove("要删的", 1787900000000);

    expect(await it_.load("要删的")).toBeNull();
    expect(gone).toContain(".trash/");
    // 回收站里那份内容一模一样。
    expect(await readFile(path.join(root, gone), "utf8")).toContain("正文原样");
  });

  it("**同一个 slug 删两次，回收站里是两份**", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "同名", title: "第一次", markdown: "第一份", draft: false });
    await it_.remove("同名", 1787900000000);
    await it_.save({ slug: "同名", title: "第二次", markdown: "第二份", draft: false });
    await it_.remove("同名", 1787900001000);

    const trash = await readdir(path.join(root, ".trash"));
    expect(trash).toHaveLength(2);
  });

  it("回收站列得出来：什么时候丢的、叫什么", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "要删的", title: "要删的标题", markdown: "正文", draft: false });
    const when = new Date(2026, 7, 30, 17, 50, 2).getTime();
    await it_.remove("要删的", when);

    const all = await it_.trash(when + 1000);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ slug: "要删的", title: "要删的标题", at: when });
  });

  it("**放回去**：文件回到统一目录，回收站里没了", async () => {
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "要删的", title: "题", markdown: "正文原样", draft: true });
    const when = Date.now();
    await it_.remove("要删的", when);

    const [one] = await it_.trash(when);
    const back = await it_.restore(one!.name);

    expect(back).toBe("要删的");
    expect((await it_.load("要删的"))!.markdown).toBe("正文原样");
    expect(await it_.trash(when)).toEqual([]);
  });

  it("**放回去时撞名就拒绝**，不覆盖", async () => {
    // 丢掉之后又写了一篇同名的，是最容易撞上的那种。
    const root = await repo();
    const it_ = store(root);
    await it_.save({ slug: "同名", title: "旧的", markdown: "旧正文", draft: true });
    const when = Date.now();
    await it_.remove("同名", when);
    await it_.save({ slug: "同名", title: "新的", markdown: "新正文", draft: true });

    const [one] = await it_.trash(when);
    await expect(it_.restore(one!.name)).rejects.toThrow();
    expect((await it_.load("同名"))!.markdown).toBe("新正文");
  });

  it("**超过一个月的自动清掉**，没到期的留着", async () => {
    const root = await repo();
    const it_ = store(root);
    const DAY = 24 * 60 * 60 * 1000;
    const now = new Date(2026, 7, 30, 12, 0, 0).getTime();

    await it_.save({ slug: "老的", title: "老的", markdown: "", draft: true });
    await it_.remove("老的", now - 40 * DAY);
    await it_.save({ slug: "新的", title: "新的", markdown: "", draft: true });
    await it_.remove("新的", now - 3 * DAY);

    const left = await it_.trash(now);

    expect(left.map((one) => one.slug)).toEqual(["新的"]);
    // 真的从磁盘上没了，不是只是没列出来。
    expect(await readdir(path.join(root, ".trash"))).toHaveLength(1);
  });

  it("**只清不列**：purge 不读文件，只看名字", async () => {
    const root = await repo();
    const it_ = store(root);
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await it_.save({ slug: "老的", title: "老的", markdown: "", draft: true });
    await it_.remove("老的", now - 40 * DAY);
    await it_.save({ slug: "新的", title: "新的", markdown: "", draft: true });
    await it_.remove("新的", now - 3 * DAY);

    const gone = await it_.purge(now);

    expect(gone).toHaveLength(1);
    expect(gone[0]).toContain("老的");
    expect(await readdir(path.join(root, ".trash"))).toHaveLength(1);
  });

  it("回收站还不存在时，purge 是空操作", async () => {
    expect(await store(await repo()).purge(Date.now())).toEqual([]);
  });

  it("回收站里**新丢的在前**——找的多半是刚丢的那件", async () => {
    const root = await repo();
    const it_ = store(root);
    const now = Date.now();
    await it_.save({ slug: "先丢的", title: "先丢的", markdown: "", draft: true });
    await it_.remove("先丢的", now - 60_000);
    await it_.save({ slug: "后丢的", title: "后丢的", markdown: "", draft: true });
    await it_.remove("后丢的", now - 1000);

    expect((await it_.trash(now)).map((one) => one.slug)).toEqual(["后丢的", "先丢的"]);
  });

  it("**手拖进回收站的文件：列出来，但永远不自动清**", async () => {
    const root = await repo();
    const it_ = store(root);
    await mkdir(path.join(root, ".trash"), { recursive: true });
    await writeFile(path.join(root, ".trash/我自己放的.md"), "---\ntitle: \"手放的\"\n---\n\n正文", "utf8");

    const all = await it_.trash(Date.now() + 999 * 24 * 60 * 60 * 1000);

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ at: null, title: "手放的" });
  });

  it("回收站是空的（或者根本没有）不是错误", async () => {
    const root = await repo();
    expect(await store(root).trash(Date.now())).toEqual([]);
  });

  it("slug 不能当文件名的一律拒绝", async () => {
    const root = await repo();
    const it_ = store(root);
    for (const bad of ["../逃出去", "a/b", ""]) {
      await expect(it_.save({ slug: bad, title: "x", markdown: "", draft: true }), bad).rejects.toThrow();
    }
  });
});

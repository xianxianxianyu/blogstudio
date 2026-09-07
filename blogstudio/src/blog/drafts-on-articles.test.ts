import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArticleStore } from "./article-store";
import { draftsOnArticles, isRawHtml } from "./drafts-on-articles";

async function ready() {
  const root = await mkdtemp(path.join(tmpdir(), "doa-"));
  const articles = createArticleStore(root, "site/content/blog");
  return { articles, drafts: draftsOnArticles(articles) };
}

describe("isRawHtml", () => {
  it("认得那 87 篇的形状", () => {
    expect(isRawHtml('<p style="">这篇文章记录…</p><h1>安装</h1>')).toBe(true);
    expect(isRawHtml("<div class=x>…")).toBe(true);
    expect(isRawHtml("\n\n  <pre><code>…")).toBe(true);
  });

  it("真 markdown 不算", () => {
    expect(isRawHtml("# 标题\n\n一段。")).toBe(false);
    expect(isRawHtml("正文里提到 <p> 这个标签")).toBe(false);
    expect(isRawHtml("")).toBe(false);
  });

  it("行内 HTML 不算——那是 markdown 里的正常写法", () => {
    expect(isRawHtml("一段里有 <strong>加粗</strong>。")).toBe(false);
  });
});

describe("Writer 直接编辑统一目录", () => {
  it("新起的一篇**一律下架**", async () => {
    // 还没写完的东西不该出现在网站上。
    const it_ = await ready();
    await it_.drafts.save({ id: "新的", markdown: "# 新的\n\n还在写。", createdAt: 0, updatedAt: 0 });
    expect((await it_.articles.load("新的"))!.draft).toBe(true);
  });

  it("**改正文不动 frontmatter**——包括 title", async () => {
    // 那 92 篇的标题都在 frontmatter 里、正文里没有 H1。跟着正文改标题
    // 会把手写的那个覆盖掉，而那不是打字该有的副作用。
    const it_ = await ready();
    await it_.articles.save({
      slug: "有的", title: "手写的标题", markdown: "旧正文", draft: false, tags: ["a"], date: "2026-01-01",
    });
    await it_.drafts.save({ id: "有的", markdown: "# 正文里的新标题\n\n新正文", createdAt: 0, updatedAt: 0 });

    const one = (await it_.articles.load("有的"))!;
    expect(one.title).toBe("手写的标题");
    expect(one.draft).toBe(false);
    expect(one.tags).toEqual(["a"]);
    expect(one.markdown).toBe("# 正文里的新标题\n\n新正文");
  });

  it("**下架的一篇：正文第一个 `# ` 就是它的名字**——新起的那篇从「未命名」长成真名字", async () => {
    // Writer 的 `create()` 用空正文落盘，那一刻的名字是「未命名」；不跟着正文长，
    // 它就永远叫这个，而界面上没有任何一处能改它。
    const it_ = await ready();
    await it_.drafts.save({ id: "新的", markdown: "", createdAt: 0, updatedAt: 0 });
    expect((await it_.articles.load("新的"))!.title).toBe("未命名");

    await it_.drafts.save({ id: "新的", markdown: "# 我的题\n\n正文", createdAt: 0, updatedAt: 0 });
    expect((await it_.articles.load("新的"))!.title).toBe("我的题");
    // 再改一次标题也跟着走——它还没上架，名字就是正文说了算。
    await it_.drafts.save({ id: "新的", markdown: "# 改了的题\n\n正文", createdAt: 0, updatedAt: 0 });
    expect((await it_.articles.load("新的"))!.title).toBe("改了的题");
  });

  it("下架但正文里没有 `# `（那 26 篇迁来的）：标题不动", async () => {
    const it_ = await ready();
    await it_.articles.save({ slug: "迁来的", title: "手写的标题", markdown: "<p>正文</p>", draft: true });
    // 这一篇是 HTML，本来就拒绝写回；换一篇纯 markdown 但只有二级标题的。
    await it_.articles.save({ slug: "只有小节", title: "手写的标题", markdown: "## 小节\n\n正文", draft: true });
    await it_.drafts.save({ id: "只有小节", markdown: "## 换了小节\n\n新正文", createdAt: 0, updatedAt: 0 });
    expect((await it_.articles.load("只有小节"))!.title).toBe("手写的标题");
  });

  it("代码块里的 `# ` 不算标题", async () => {
    const it_ = await ready();
    await it_.drafts.save({ id: "x", markdown: "", createdAt: 0, updatedAt: 0 });
    await it_.drafts.save({ id: "x", markdown: "```sh\n# 注释\n```\n\n# 真标题", createdAt: 0, updatedAt: 0 });
    expect((await it_.articles.load("x"))!.title).toBe("真标题");
  });

  it("**正文是原始 HTML 的，拒绝写回**", async () => {
    // markdown 往返会把它改坏：代码缩进丢了、下划线变成 \_。实测过。
    const it_ = await ready();
    await it_.articles.save({
      slug: "老文章", title: "老文章", draft: false,
      markdown: '<p style="">正文</p><pre><code>a_b\n\n  缩进</code></pre>',
    });
    await expect(
      it_.drafts.save({ id: "老文章", markdown: "改过的", createdAt: 0, updatedAt: 0 }),
    ).rejects.toThrow(/HTML/);
    // 文件一个字都没动。
    expect((await it_.articles.load("老文章"))!.markdown).toContain("<pre><code>");
  });

  it("新起的一篇不受影响", async () => {
    const it_ = await ready();
    await expect(
      it_.drafts.save({ id: "新的", markdown: "# 新的\n\n正文", createdAt: 0, updatedAt: 0 }),
    ).resolves.toBeUndefined();
  });

  it("列表按**最近改动**排，不是按发表日期", async () => {
    const it_ = await ready();
    // 发表日期很老，但刚刚改过。
    await it_.articles.save({ slug: "老文新改", title: "老文新改", markdown: "", draft: false, date: "2020-01-01" });
    await new Promise((ok) => setTimeout(ok, 10));
    await it_.articles.save({ slug: "新文", title: "新文", markdown: "", draft: false, date: "2026-01-01" });
    await new Promise((ok) => setTimeout(ok, 10));
    await it_.drafts.save({ id: "老文新改", markdown: "刚改的", createdAt: 0, updatedAt: 0 });

    expect((await it_.drafts.list()).map((one) => one.id)).toEqual(["老文新改", "新文"]);
  });

  it("标题走 frontmatter，不从正文猜", async () => {
    const it_ = await ready();
    await it_.articles.save({ slug: "x", title: "frontmatter 的", markdown: "# 正文的", draft: false });
    expect((await it_.drafts.list())[0]!.title).toBe("frontmatter 的");
  });

  it("读回来的 id 就是 slug", async () => {
    const it_ = await ready();
    await it_.drafts.save({ id: "地址", markdown: "正文", createdAt: 0, updatedAt: 0 });
    const one = (await it_.drafts.load("地址"))!;
    expect(one.id).toBe("地址");
    expect(one.markdown).toBe("正文");
  });

  it("删除走的是回收站，不是真删", async () => {
    const it_ = await ready();
    await it_.drafts.save({ id: "要删的", markdown: "正文", createdAt: 0, updatedAt: 0 });
    await it_.drafts.remove("要删的");
    expect(await it_.drafts.load("要删的")).toBeNull();
  });
});

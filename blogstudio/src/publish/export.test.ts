import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSite } from "./ssh-site";
import { createAboutStore } from "./about-store";
import { aboutContent } from "./about";
import { articleSection } from "./scope";
import { moveArticle } from "./move-article";
import { createArticleStore } from "../blog/article-store";

const root = () => mkdtemp(path.join(tmpdir(), "export-"));
async function put(dir: string, file: string, text: string) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), text);
}
const content = { title: "关于", intro: "介绍", currentTitle: "当前", current: ["写作"], directionsTitle: "方向", directions: [{ id: "d01", title: "研究", goal: ["问题"], done: [], problem: [], note: "" }], contactTitle: "联系", links: [{ label: "GitHub", text: "me", url: "https://github.com/me" }] };

describe("Export 的栏目边界", () => {
  it("干跑和实跑均保留推荐、旧地址、资源和上传文件，仍发布 Blog / Project / About 与首页", async () => {
    const from = await root(), to = await root();
    const keep = ["recommend/index.html", "en/recommend/index.html", "loop/index.html", "en/loop/index.html", "css/loop.old.css", "js/loop.old.js", "assets/css/old-hash.css", "upload/manual.txt"];
    for (const f of keep) await put(to, f, "云端推荐");
    for (const f of keep.filter(f => !f.startsWith("assets/"))) await put(from, f, "不应发布");
    await put(to, "recommend/online-only.html", "线上独有");
    await put(to, "blog/old/index.html", "已下架");
    await put(to, "index.html", "旧首页");
    const changed = ["index.html", "blog/new/index.html", "projects/new/index.html", "about/index.html", "en/about/index.html", "assets/css/new.css"];
    for (const f of changed) await put(from, f, "新内容");
    const site = createSite(to + "/", async () => ({ exists: true, looksLikeSite: true, slugs: [] }));
    const plan = await site.plan(from);
    expect(plan.deleted).toContain("blog/old/index.html");
    expect([...plan.added, ...plan.changed, ...plan.deleted].some(f => /recommend|loop\.|\/loop\//.test(f))).toBe(false);
    await site.sync(from);
    for (const f of keep) expect(await readFile(path.join(to, f), "utf8")).toBe("云端推荐");
    for (const f of changed) expect(await readFile(path.join(to, f), "utf8")).toBe("新内容");
    expect(await readFile(path.join(to, "recommend/online-only.html"), "utf8")).toBe("线上独有");
    await expect(access(path.join(to, "blog/old/index.html"))).rejects.toThrow();
  });
  it("栏目参数不能绕过 Blog / Project 白名单", () => {
    expect(articleSection(null)).toBe("blog");
    expect(articleSection("projects")).toBe("projects");
    for (const value of ["recommend", "loop", "about", "../projects"]) expect(() => articleSection(value)).toThrow();
  });
});

describe("About 保存", () => {
  it("保留另一语言、卡片排序及 Markdown，拒绝过期窗口和并发覆盖", async () => {
    const dir = await root();
    await put(dir, "data/about.json", JSON.stringify({ "zh-cn": content, en: { ...content, title: "About" } }));
    const store = createAboutStore(dir), first = await store.read();
    const next = { ...content, intro: "**新介绍**", current: ["一", "二"], directions: [{ ...content.directions[0]!, id: "d02" }, content.directions[0]!] };
    const result = await Promise.allSettled([store.save("zh-cn", next, first.revision), store.save("en", content, first.revision)]);
    expect(result.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    const saved = await store.read();
    expect(saved.content.en).toEqual(first.content.en);
    expect(saved.content["zh-cn"]).toEqual(next);
    await expect(store.save("en", content, first.revision)).rejects.toThrow("其他窗口");
  });
  it("拒绝坏字段、重复卡片标识和可执行链接", () => {
    expect(() => aboutContent({ ...content, directions: [content.directions[0], content.directions[0]] })).toThrow("重复");
    expect(() => aboutContent({ ...content, current: "not an array" })).toThrow();
    expect(() => aboutContent({ ...content, links: [{ label: "x", text: "x", url: "javascript:alert(1)" }] })).toThrow("链接");
  });
});

describe("文章切换栏目", () => {
  it("只移动草稿，逐字保留内容，同名不覆盖，不把栏目首页当文章", async () => {
    const repo = await root();
    const config = { repo, site: "site", articles: "site/content/blog", destinations: [] };
    const text = '---\ntitle: Test\ndraft: true\ncustom: keep\n---\n\n# 正文\n';
    await put(repo, "site/content/blog/test.md", text);
    await put(repo, "site/content/projects/_index.en.md", "---\ntitle: Projects\n---");
    await moveArticle(config, "test", "blog", "projects");
    expect(await readFile(path.join(repo, "site/content/projects/test.md"), "utf8")).toBe(text);
    const store = createArticleStore(repo, "site/content/projects", ".trash/projects");
    expect((await store.list()).map(a => a.slug)).toEqual(["test"]);
    await put(repo, "site/content/blog/test.md", "已存在");
    await expect(moveArticle(config, "test", "projects", "blog")).rejects.toThrow();
    expect(await readFile(path.join(repo, "site/content/blog/test.md"), "utf8")).toBe("已存在");
    await put(repo, "site/content/blog/live.md", text.replace("draft: true", "draft: false"));
    await expect(moveArticle(config, "live", "blog", "projects")).rejects.toThrow("下架");
    const trashed = await store.remove("test", Date.now());
    expect(trashed).toMatch(/^\.trash\/projects\//);
    const blog = createArticleStore(repo, config.articles);
    expect(await blog.trash(Date.now())).toEqual([]);
    await store.restore(path.basename(trashed));
    expect((await store.load("test"))?.markdown).toContain("# 正文");
  });
});

describe("构建输出", () => {
  it("文章下架后不遗留旧 HTML，保持源码完整", async () => {
    const { runHugo } = await import("./hugo");
    const { buildArgs } = await import("./build");
    const site = await root();
    await put(site, "hugo.toml", 'baseURL = "https://example.org/"\ntitle = "Test"\n');
    await put(site, "layouts/_default/single.html", "<h1>{{ .Title }}</h1>");
    await put(site, "content/blog/one.md", "---\ntitle: One\ndraft: false\n---\nBody");
    const args = buildArgs(site, { name: "test", host: "test", path: "/site", baseURL: "https://example.org/" });
    await runHugo(args);
    expect(await readFile(path.join(site, "public-test/blog/one/index.html"), "utf8")).toContain("One");
    await put(site, "content/blog/one.md", "---\ntitle: One\ndraft: true\n---\nBody");
    await runHugo(args);
    await expect(access(path.join(site, "public-test/blog/one/index.html"))).rejects.toThrow();
    expect(await readFile(path.join(site, "content/blog/one.md"), "utf8")).toContain("Body");
  });
});

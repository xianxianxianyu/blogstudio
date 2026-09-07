import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBlog } from "./blog";

/** 一个仓库：一篇文章用着 a.png，b.png 没人用。 */
async function ready() {
  const root = await mkdtemp(path.join(tmpdir(), "blog-"));
  await mkdir(path.join(root, "site/content/blog"), { recursive: true });
  await mkdir(path.join(root, "site/static/images"), { recursive: true });
  await writeFile(
    path.join(root, "site/content/blog/x.md"),
    '---\ntitle: "x"\ndraft: false\n---\n\n![](/images/a.png)\n',
    "utf8",
  );
  await writeFile(path.join(root, "site/static/images/a.png"), "a");
  await writeFile(path.join(root, "site/static/images/b.png"), "b");
  const blog = createBlog(
    { repo: root, site: "site", articles: "site/content/blog", destinations: [] },
    path.join(root, "index.db"),
  );
  return { root, blog };
}

describe("没人用的图", () => {
  it("**只报，不删**：列出来的是索引里没人引用的那几张", async () => {
    const { blog } = await ready();
    expect(await blog.orphanImages()).toEqual(["b.png"]);
    expect(await blog.images.list()).toEqual(["a.png", "b.png"]);
    blog.close();
  });

  it("删没人用的可以；**有人用的拒绝**——那是页面上的一张破图", async () => {
    const { blog } = await ready();
    await expect(blog.removeImage("a.png")).rejects.toThrow("还被 x 用着");
    await blog.removeImage("b.png");
    expect(await blog.images.list()).toEqual(["a.png"]);
    blog.close();
  });
});

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createImageStore, imageNameOf, imagesIn } from "./images";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("imageNameOf", () => {
  it("同样的内容 → 同样的名字", () => {
    // 同一张截图粘进两篇文章，不该在磁盘上存两份。
    expect(imageNameOf(bytes("一张图"), "a.png")).toBe(imageNameOf(bytes("一张图"), "b.png"));
  });

  it("不同内容 → 不同名字", () => {
    expect(imageNameOf(bytes("甲"), "x.png")).not.toBe(imageNameOf(bytes("乙"), "x.png"));
  });

  it("扩展名跟着原文件走，而且小写", () => {
    expect(imageNameOf(bytes("x"), "照片.PNG")).toMatch(/\.png$/);
    // 用 .JPG 才测得出「转小写」：.PNG 不转也会退回默认的 png，把这个错盖住了。
    expect(imageNameOf(bytes("x"), "照片.JPG")).toMatch(/\.jpg$/);
    expect(imageNameOf(bytes("x"), "a.jpeg")).toMatch(/\.jpeg$/);
  });

  it("**名字里只留安全字符**", () => {
    // 它会变成文件名，也会变成 URL 的一截。
    expect(imageNameOf(bytes("x"), "../../逃出去.png")).toMatch(/^[a-z0-9]+\.png$/);
    expect(imageNameOf(bytes("x"), "带 空格.png")).toMatch(/^[a-z0-9]+\.png$/);
  });

  it("认不出扩展名就当 png", () => {
    // 从剪贴板粘进来的常常没有文件名。
    expect(imageNameOf(bytes("x"), "")).toMatch(/\.png$/);
    expect(imageNameOf(bytes("x"), "没有点")).toMatch(/\.png$/);
    // 但别把一段随手的后缀当成扩展名。
    expect(imageNameOf(bytes("x"), "a.exe")).toMatch(/\.png$/);
  });
});

describe("imagesIn", () => {
  it("从正文里认出用了哪几张", () => {
    const body = '<img src="/images/a.png"> 和 <img src=/images/b.jpg>';
    expect(imagesIn(body).sort()).toEqual(["a.png", "b.jpg"]);
  });

  it("markdown 写法也认", () => {
    expect(imagesIn("![说明](/images/c.png)")).toEqual(["c.png"]);
  });

  it("同一张用两次只算一次", () => {
    expect(imagesIn('<img src="/images/a.png"><img src="/images/a.png">')).toEqual(["a.png"]);
  });

  it("别的路径不算", () => {
    expect(imagesIn('<img src="/upload/x.png"><img src="https://别处/images/y.png">')).toEqual([]);
  });
});

describe("ImageStore", () => {
  const ready = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "img-"));
    return { root, store: createImageStore(root, "site/static/images") };
  };

  it("存一张，回报它的网址", async () => {
    const it_ = await ready();
    const url = await it_.store.put(bytes("图的字节"), "截图.png");
    expect(url).toMatch(/^\/images\/[a-z0-9]+\.png$/);
    const name = url.replace("/images/", "");
    expect(await readFile(path.join(it_.root, "site/static/images", name), "utf8")).toBe("图的字节");
  });

  it("**同一张存两次，磁盘上只有一份**", async () => {
    const it_ = await ready();
    const a = await it_.store.put(bytes("同一张"), "x.png");
    const b = await it_.store.put(bytes("同一张"), "y.png");
    expect(a).toBe(b);
    expect(await it_.store.list()).toEqual([a.replace("/images/", "")]);
  });

  it("列得出现在有哪些", async () => {
    const it_ = await ready();
    await it_.store.put(bytes("甲"), "a.png");
    await it_.store.put(bytes("乙"), "b.png");
    expect((await it_.store.list()).length).toBe(2);
  });

  it("目录还不存在时也能存", async () => {
    const it_ = await ready();
    await expect(it_.store.put(bytes("x"), "a.png")).resolves.toBeTruthy();
  });

  it("目录不存在时，列出来是空的，不抛", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "img-"));
    await writeFile(path.join(root, "占位"), "", "utf8");
    expect(await createImageStore(root, "site/static/images").list()).toEqual([]);
  });
});

describe("ImageStore.remove", () => {
  it("删一张；名字带路径就拒绝", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "img-"));
    const store = createImageStore(root, "static/images");
    const url = await store.put(bytes("一张图"), "a.png");
    const name = url.slice("/images/".length);
    expect(await store.list()).toEqual([name]);

    await expect(store.remove("../别处.png")).rejects.toThrow("不能当文件名");
    await store.remove(name);
    expect(await store.list()).toEqual([]);
  });

  it("列表只认图片，别的文件不算", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "img-"));
    const store = createImageStore(root, "static/images");
    await store.put(bytes("x"), "a.png");
    await writeFile(path.join(root, "static/images", ".DS_Store"), "");
    expect(await store.list()).toHaveLength(1);
  });
});

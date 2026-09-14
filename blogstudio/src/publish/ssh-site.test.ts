import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalSite, siteOf } from "./ssh-site";

/**
 * 对着**真 rsync** 测，不 mock。
 *
 * mock 出来的只能证明我猜得对——而这一块已经有两处是猜错的：`*deleting` 会打两遍、
 * 中文名会被转义。两条都是真跑一次才看见的。
 *
 * `createSite` 就是 `createSshSite` 内部用的那一个：同一条 rsync 命令、同一份解析。
 * 这里只把目标写成本地路径、`probe` 换成直接读文件系统，于是不需要一台服务器，
 * 就能测到最容易出错的那部分（`-8`、`-c`、`--delete` 少一个都是静悄悄的错）。
 */

/** 本机去处就是生产代码里那一个（`createLocalSite`），这里不另抄一份。 */
const localSite = createLocalSite;
const dirs = async (): Promise<{ from: string; to: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), "site-"));
  const from = path.join(root, "from");
  const to = path.join(root, "to");
  await mkdir(path.join(from, "blog"), { recursive: true });
  await mkdir(path.join(to, "blog"), { recursive: true });
  return { from, to };
};

const put = (dir: string, file: string, text: string) =>
  writeFile(path.join(dir, file), text, "utf8");

describe("站点同步", () => {
  it("干跑说得出新增、改动、删除，而且**一个字都没写**", async () => {
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await put(from, "blog/新增的.html", "新的\n");
    await put(from, "blog/改过的.html", "第二版\n");
    await put(to, "blog/改过的.html", "第一版\n");
    await put(to, "blog/云端多出来的.html", "要被删\n");

    const site = localSite(to);
    const out = await site.plan(from);

    expect(out.added).toContain("blog/新增的.html");
    expect(out.changed).toEqual(["blog/改过的.html"]);
    expect(out.deleted).toEqual(["blog/云端多出来的.html"]);
    // 干跑不写盘：那边还是第一版。
    expect(await readFile(path.join(to, "blog/改过的.html"), "utf8")).toBe("第一版\n");
  });

  it("中文文件名原样出来，不是八进制转义", async () => {
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await put(from, "blog/WSL2搭建cuda-triton开发环境.html", "x\n");

    const out = await localSite(to).plan(from);

    expect(out.added).toContain("blog/WSL2搭建cuda-triton开发环境.html");
  });

  it("**内容没变、只有 mtime 变了，不算改动**", async () => {
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await put(to, "index.html", "首页\n");
    await put(from, "blog/一样的.html", "同一份内容\n");
    await put(to, "blog/一样的.html", "同一份内容\n");
    // Hugo 每次全量重建都会刷新 mtime。算进去的话每次部署都显示「几百个文件改动」。

    const out = await localSite(to).plan(from);

    expect(out.changed).toEqual([]);
    expect(out.added).toEqual([]);
  });

  it("真跑之后，那边就是这边", async () => {
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await put(from, "blog/一篇.html", "正文\n");
    await put(to, "index.html", "旧首页\n");
    await put(to, "blog/该没的.html", "旧的\n");

    await localSite(to).sync(from);

    expect(await readFile(path.join(to, "blog/一篇.html"), "utf8")).toBe("正文\n");
    expect(await readFile(path.join(to, "index.html"), "utf8")).toBe("首页\n");
    await expect(readFile(path.join(to, "blog/该没的.html"), "utf8")).rejects.toThrow();
  });

  it("**排除的路径既不传过去，也不会被 --delete 删掉**", async () => {
    // `.cn` 那台阿里云出网只有 3.3 Mbps，图片不该往那儿传——由服务器一条 301 弹回 OSS。
    // 而「不传」还不够：`--delete` 会把远端多出来的删掉，排除必须两头都管用。
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await mkdir(path.join(from, "images"), { recursive: true });
    await put(from, "images/新图.png", "本地有这张\n");
    await put(to, "index.html", "旧首页\n");
    await mkdir(path.join(to, "images"), { recursive: true });
    await put(to, "images/云端本来就有的.png", "别删我\n");

    const out = await localSite(to, ["images/"]).sync(from);

    expect(out.added.some((one) => one.startsWith("images/"))).toBe(false);
    await expect(readFile(path.join(to, "images/新图.png"), "utf8")).rejects.toThrow();
    // 远端原有的那张也还在。
    expect(await readFile(path.join(to, "images/云端本来就有的.png"), "utf8")).toBe("别删我\n");
  });

  it("干跑与真跑带的是同一份排除", async () => {
    // 两边不一致的话，预览说的和实际做的是两回事——而这里面有 --delete。
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await mkdir(path.join(from, "images"), { recursive: true });
    await put(from, "images/图.png", "x\n");

    await put(to, "index.html", "旧首页\n");

    const site = localSite(to, ["images/"]);
    expect((await site.plan(from)).added.some((one) => one.startsWith("images/"))).toBe(false);
    expect((await site.sync(from)).added.some((one) => one.startsWith("images/"))).toBe(false);
  });

  it("probe：说得出那边存不存在、像不像站点、有哪些文章", async () => {
    const { to } = await dirs();
    await put(to, "index.html", "首页\n");
    await mkdir(path.join(to, "blog/某一篇"), { recursive: true });
    await mkdir(path.join(to, "blog/另一篇"), { recursive: true });

    const out = await localSite(to).probe();

    expect(out.exists).toBe(true);
    expect(out.looksLikeSite).toBe(true);
    expect(out.slugs.sort()).toEqual(["另一篇", "某一篇"]);
  });

  it("**那边没有 index.html 就拒绝同步**——`--delete` 会清空它", async () => {
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    await put(to, "谁的文件.txt", "这看着不像一个站点\n");

    await expect(localSite(to).sync(from)).rejects.toThrow(/index\.html|不像一个站点/);
    // 一个字都没动。
    expect(await readFile(path.join(to, "谁的文件.txt"), "utf8")).toBe("这看着不像一个站点\n");
  });

  it("那边整个目录不存在时，说的是「不存在」，不是「不像站点」", async () => {
    const { from } = await dirs();
    await put(from, "index.html", "首页\n");
    // **目录名要中性**：叫「根本没有这个目录」的话，断言会匹配到路径本身，
    // 于是这条测试拿输入当证据，去掉那道检查它照样绿。
    const gone = path.join(from, "..", "absent");

    await expect(localSite(gone).sync(from)).rejects.toThrow("上没有这个目录");
    // 两种失败的修法不一样：一个是路径写错了，一个是同步到了别人的目录。
    await expect(localSite(gone).sync(from)).rejects.not.toThrow("不像一个站点");
  });

  it("路径里带反引号也只是路径，不是一段命令", async () => {
    const { from, to } = await dirs();
    await put(from, "index.html", "首页\n");
    // 那边得先像个站点，否则会被那道保护挡下来（上一条测的就是它）。
    await put(to, "index.html", "旧首页\n");
    await put(from, "blog/a`touch pwned`b.html", "x\n");

    await localSite(to).sync(from);

    expect(await readFile(path.join(to, "blog/a`touch pwned`b.html"), "utf8")).toBe("x\n");
    await expect(readFile(path.join(to, "pwned"), "utf8")).rejects.toThrow();
  });

  it("`host: \"local\"` 选本机适配器，别的选 ssh", async () => {
    const { to } = await dirs();
    const local = siteOf({ name: "com", host: "local", path: to, baseURL: "https://x/" });
    // 本机的 probe 直接读文件系统——不走 ssh，所以这里不用一台服务器就能问到。
    // 空目录**不像站点**（没有 index.html），放一个进去才像：`--delete` 指错目录会清空它。
    expect(await local.probe()).toEqual({ exists: true, looksLikeSite: false, slugs: [] });
    await put(to, "index.html", "<h1>hi</h1>");
    await mkdir(path.join(to, "blog", "一篇"), { recursive: true });
    expect(await local.probe()).toEqual({ exists: true, looksLikeSite: true, slugs: ["一篇"] });
  });
});

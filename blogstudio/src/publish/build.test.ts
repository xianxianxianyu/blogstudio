import { describe, expect, it } from "vitest";
import { buildArgs, outDirOf, staleOutDirs } from "./build";

const CN = {
  name: "moyutianzun.cn",
  host: "myblog-preview",
  path: "/opt/1panel/www/sites/moyutianzun.cn/index",
  baseURL: "https://moyutianzun.cn/",
};

describe("outDirOf", () => {
  it("一个去处一个产物目录", () => {
    // 共用 public/ 的话，后同步的那个会带着前一个的绝对链接——而页面看着完全正常。
    expect(outDirOf("/repo/site", CN)).toBe("/repo/site/public-moyutianzun.cn");
  });

  it("名字里的路径记号不许变成路径", () => {
    // 去处的名字是人手写的。`../` 落进 -d，配上 --cleanDestinationDir 就是删别处的东西。
    expect(outDirOf("/repo/site", { ...CN, name: "../../etc" })).toBe("/repo/site/public-etc");
    expect(outDirOf("/repo/site", { ...CN, name: "a/b" })).toBe("/repo/site/public-a-b");
  });

  it("名字整个没法用时也不许拿到空后缀", () => {
    // `public-` 这种目录名会让两个坏名字的去处撞在一起。
    expect(() => outDirOf("/repo/site", { ...CN, name: "..." })).toThrow();
  });
});

describe("buildArgs", () => {
  it("baseURL 跟着去处走，而且**跟在那个 flag 后面**", () => {
    // 只断言「URL 在参数里」是不够的：flag 掉了的话它就变成一个位置参数，
    // hugo 会把它当成别的东西，而构建照样成功。
    const args = buildArgs("/repo/site", CN);
    expect(args[args.indexOf("--baseURL") + 1]).toBe("https://moyutianzun.cn/");
  });

  it("源和产物都是绝对路径", () => {
    // 相对路径换个工作目录照样跑得通，只是干在别处——而 --cleanDestinationDir 会删东西。
    const args = buildArgs("/repo/site", CN);
    expect(args[args.indexOf("-s") + 1]).toBe("/repo/site");
    expect(args[args.indexOf("-d") + 1]).toBe("/repo/site/public-moyutianzun.cn");
  });

  it("带上 --minify 与 --cleanDestinationDir", () => {
    const args = buildArgs("/repo/site", CN);
    expect(args).toContain("--minify");
    // 不清的话，删掉的文章会在产物里留着，然后被同步上去——rsync 只对齐两边，
    // 而那时「本地」本身就是脏的。
    expect(args).toContain("--cleanDestinationDir");
  });

  it("不带 -D/-E：草稿和过期文章不该上线", () => {
    const args = buildArgs("/repo/site", CN);
    expect(args).not.toContain("-D");
    expect(args).not.toContain("-E");
    expect(args).not.toContain("--buildDrafts");
  });
});

describe("staleOutDirs", () => {
  it("不在去处表里的 public-* 是孤儿；别的目录不归这里管", () => {
    // 去处改过名，旧名字的产物目录（实际留下过一个 public-cn）没有任何东西会再碰它。
    const entries = ["public", "public-cn", "public-moyutianzun.cn", "content", "public-old"];
    expect(staleOutDirs(entries, [CN])).toEqual(["public-cn", "public-old"]);
  });

  it("去处表是空的，一个都不清——那多半是配置没读出来，不是真的没有去处", () => {
    // 这一条其实由调用方守（配置读不出来就不会走到构建），这里钉住的是纯函数本身
    // 不会因为空表就把所有 public-* 当孤儿……它会。所以调用方必须先确认配置在。
    expect(staleOutDirs(["public-a"], [])).toEqual(["public-a"]);
  });
});

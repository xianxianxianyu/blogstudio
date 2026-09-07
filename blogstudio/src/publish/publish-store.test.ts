import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublishStore, parseConfig } from "./publish-store";

const root = () => mkdtemp(path.join(tmpdir(), "publish-store-"));

const CONFIG = {
  repo: "/Users/devlin/Desktop/project/my-blog",
  site: "site",
  articles: "site/content/blog",
  destinations: [
    {
      name: "moyutianzun.com",
      host: "vps",
      path: "/srv/blog",
      baseURL: "https://moyutianzun.com/",
    },
    {
      name: "moyutianzun.cn",
      host: "myblog-preview",
      path: "/opt/1panel/www/sites/moyutianzun.cn/index",
      baseURL: "https://moyutianzun.cn/",
    },
  ],
};

describe("parseConfig", () => {
  it("读一份正常的", () => {
    const out = parseConfig(JSON.stringify(CONFIG));
    expect(out.config).toEqual(CONFIG);
    expect(out.problems).toEqual([]);
  });

  it("**坏的那条要说出是哪一条、缺什么**，不是悄悄跳过", () => {
    const bad = { ...CONFIG, destinations: [CONFIG.destinations[0]!, { name: "缺东西" }] };
    const out = parseConfig(JSON.stringify(bad));
    expect(out.config?.destinations).toHaveLength(1);
    expect(out.problems[0]).toContain("第 2 个去处");
    expect(out.problems[0]).toContain("host");
  });

  it("**认出上一版 git 那套的形状，并说清楚怎么改**", () => {
    // 旧的是一个数组，每条带 repo/branch/articles。因为字段对不上就显示成
    // 「还没有去处」的话，人会以为配置丢了，然后重写一份——而旧的那份还在。
    const old = JSON.stringify([
      { name: "博客", repo: "/x", branch: "main", articles: "site/content/blog" },
    ]);
    const out = parseConfig(old);
    expect(out.config).toBeNull();
    expect(out.problems.join()).toContain("上一版");
  });

  it("不是 JSON、缺 repo、去处是空的，都得说人话", () => {
    expect(parseConfig("{").problems[0]).toContain("JSON");
    const noRepo = JSON.stringify({ ...CONFIG, repo: undefined });
    expect(parseConfig(noRepo).problems.join()).toContain("repo");
    const none = JSON.stringify({ ...CONFIG, destinations: [] });
    expect(parseConfig(none).problems.join()).toContain("一个去处都没有");
  });

  it("**说了图片传 OSS 却没排掉 images/ —— 要报**", () => {
    // 不报的话那 62 MB 会往细带宽那台机器上传一遍，而且传完没人用。
    const half = {
      ...CONFIG,
      destinations: [{ ...CONFIG.destinations[1]!, images: "oss://桶/images/" }],
    };
    expect(parseConfig(JSON.stringify(half)).problems.join()).toContain("exclude");

    const whole = {
      ...CONFIG,
      destinations: [{ ...CONFIG.destinations[1]!, images: "oss://桶/images/", exclude: ["images/"] }],
    };
    expect(parseConfig(JSON.stringify(whole)).problems).toEqual([]);
  });

  it("不声明 images 就是跟着 rsync 走，不该报什么", () => {
    expect(parseConfig(JSON.stringify(CONFIG)).problems).toEqual([]);
  });

  it("重名的去处只留一个，并且报出来", () => {
    const dup = { ...CONFIG, destinations: [CONFIG.destinations[0]!, CONFIG.destinations[0]!] };
    const out = parseConfig(JSON.stringify(dup));
    expect(out.config?.destinations).toHaveLength(1);
    expect(out.problems.join()).toContain("moyutianzun.com");
  });

  it("外层缺字段时**不返回半份配置**", () => {
    // 返回一份缺 repo 的配置，后面每一步都会拿 undefined 去拼路径，
    // 错会推迟到某个看不出所以然的地方才炸。
    const out = parseConfig(JSON.stringify({ ...CONFIG, repo: undefined }));
    expect(out.config).toBeNull();
  });

  it("baseURL 必须是 http(s) 且以斜杠结尾", () => {
    // 少了尾斜杠，Hugo 生成的链接会少一层路径；写成别的协议则整站链接全废。
    const bad = { ...CONFIG, destinations: [{ ...CONFIG.destinations[0]!, baseURL: "moyutianzun.com" }] };
    expect(parseConfig(JSON.stringify(bad)).problems.join()).toContain("baseURL");
    const noSlash = { ...CONFIG, destinations: [{ ...CONFIG.destinations[0]!, baseURL: "https://a.com" }] };
    expect(parseConfig(JSON.stringify(noSlash)).problems.join()).toContain("斜杠");
    // **协议和尾斜杠是两条独立的检查**：这一条尾斜杠是对的，只有协议不对，
    // 少了协议那道检查它就会被放行。
    const ftp = { ...CONFIG, destinations: [{ ...CONFIG.destinations[0]!, baseURL: "ftp://a.com/" }] };
    expect(parseConfig(JSON.stringify(ftp)).problems.join()).toContain("http");
  });
});

describe("PublishStore", () => {
  it("还没配过不是错误", async () => {
    const out = await createPublishStore(await root()).config();
    expect(out.config).toBeNull();
    expect(out.problems).toEqual([]);
  });

  it("记一笔同步，再读回来", async () => {
    const dir = await root();
    const store = createPublishStore(dir);
    await store.recordSync("moyutianzun.cn", { at: 7, added: 18, changed: 6, deleted: 0 });
    expect(await store.syncs()).toEqual({
      "moyutianzun.cn": { at: 7, added: 18, changed: 6, deleted: 0 },
    });
  });

  it("**记另一个去处，前一个还在**", async () => {
    const dir = await root();
    const store = createPublishStore(dir);
    await store.recordSync("a", { at: 1, added: 1, changed: 0, deleted: 0 });
    await store.recordSync("b", { at: 2, added: 2, changed: 0, deleted: 0 });
    expect(Object.keys(await store.syncs())).toEqual(["a", "b"]);
  });

  it("账本坏了就当没同步过——不该让送出去这件事整个瘫掉", async () => {
    const dir = await root();
    await writeFile(path.join(dir, "published.json"), "{坏的", "utf8");
    expect(await createPublishStore(dir).syncs()).toEqual({});
  });

  it("**我们从不回写 destinations.json**", async () => {
    const dir = await root();
    const mine = `{\n  "repo": "/x"\n}`;
    await writeFile(path.join(dir, "destinations.json"), mine, "utf8");
    await createPublishStore(dir).recordSync("a", { at: 1, added: 0, changed: 0, deleted: 0 });
    expect(await readFile(path.join(dir, "destinations.json"), "utf8")).toBe(mine);
  });
});

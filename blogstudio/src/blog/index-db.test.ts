import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArticleStore } from "./article-store";
import { citationsOf, openIndex } from "./index-db";

async function ready() {
  const root = await mkdtemp(path.join(tmpdir(), "idx-"));
  const store = createArticleStore(root, "site/content/blog");
  const db = path.join(root, "index.db");
  return { root, store, db, index: () => openIndex(db) };
}

describe("citationsOf", () => {
  it("认得正文里的 [ctx:xxx]", () => {
    expect(citationsOf("一段[ctx:a1]。另一段[ctx:b2]。")).toEqual(["a1", "b2"]);
  });

  it("**也认得上架之后藏在脚注里的那种**", () => {
    // 上架时 [ctx:] 就地变成脚注，id 藏进 HTML 注释——渲染时被吃掉，但留在 md 里。
    expect(citationsOf("[^1]: 《某本书》 第 3 页 <!-- ctx:a1 -->")).toEqual(["a1"]);
  });

  it("同一条引两次只算一次", () => {
    expect(citationsOf("甲[ctx:a1]乙[ctx:a1]")).toEqual(["a1"]);
  });

  it("没有引用就是空", () => {
    expect(citationsOf("干净的一段。")).toEqual([]);
  });
});

describe("索引", () => {
  it("扫一遍，列得出文章", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲文", markdown: "", draft: false, tags: ["a"], date: "2026-01-01" });
    await it_.store.save({ slug: "乙", title: "乙文", markdown: "", draft: true, date: "2025-01-01" });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.articles().map((one) => [one.slug, one.draft])).toEqual([
      ["甲", false],
      ["乙", true],
    ]);
    db.close();
  });

  it("**标签空间把 tags 和 categories 合在一起**", async () => {
    // 那 92 篇里 `inference`、`vllm` 在 categories，`agent`、`算子` 在 tags——
    // 找文章的人不关心这个区别，只筛 tags 会整个漏掉一半词。
    const it_ = await ready();
    await it_.store.save({
      slug: "甲", title: "甲", markdown: "", draft: false,
      tags: ["vllm源码"], categories: ["inference", "LLM"],
    });
    await it_.store.save({ slug: "乙", title: "乙", markdown: "", draft: false, tags: ["agent"] });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.labels().map(([name]) => name).sort()).toEqual(["LLM", "agent", "inference", "vllm源码"]);
    expect(db.labels().find(([name]) => name === "inference")?.[1]).toBe(1);
    db.close();
  });

  it("标签按**用得多的**排前面", async () => {
    // 一天点好几次的那几个不该藏在后面。
    const it_ = await ready();
    await it_.store.save({ slug: "1", title: "1", markdown: "", draft: false, tags: ["常用", "少见"] });
    await it_.store.save({ slug: "2", title: "2", markdown: "", draft: false, tags: ["常用"] });
    await it_.store.save({ slug: "3", title: "3", markdown: "", draft: false, tags: ["常用"] });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.labels()).toEqual([["常用", 3], ["少见", 1]]);
    db.close();
  });

  it("**同一篇里 tags 和 categories 撞了同一个词，只算一次**", async () => {
    // `cuda/Triton` 在那 92 篇里就是两边都有的。算两次会让计数说谎。
    const it_ = await ready();
    await it_.store.save({
      slug: "两边都有", title: "两边都有", markdown: "", draft: false,
      tags: ["cuda/Triton"], categories: ["cuda/Triton"],
    });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.labels()).toEqual([["cuda/Triton", 1]]);
    db.close();
  });

  it("**搜正文、标题、标签都算**", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "标题里有", title: "谈谈 SGLang", markdown: "正文没提", draft: false });
    await it_.store.save({ slug: "正文里有", title: "别的", markdown: "我们用 sglang 跑了一遍", draft: false });
    await it_.store.save({ slug: "标签里有", title: "又别的", markdown: "无关", draft: false, tags: ["SGLang"] });
    await it_.store.save({ slug: "没有的", title: "无关", markdown: "无关", draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    // 大小写不该影响：写文章的人一会儿 SGLang 一会儿 sglang。
    expect(db.search("sglang").sort()).toEqual(["标签里有", "标题里有", "正文里有"]);
    expect(db.search("SGLANG").length).toBe(3);
    expect(db.search("从来没有过")).toEqual([]);
    db.close();
  });

  it("**英文按词匹配**：搜 rl 不该命中 url", async () => {
    // 实测：那 92 篇里独立的 rl 一篇都没有，而子串匹配会命中 26 篇 —— 全是
    // url / curl / world。短词是最需要搜的，也最容易被子串毁掉。
    const it_ = await ready();
    await it_.store.save({ slug: "有url", title: "配置", markdown: "打开这个 url 看看", draft: false });
    await it_.store.save({ slug: "真的rl", title: "谈谈 RL", markdown: "强化学习", draft: false });
    await it_.store.save({ slug: "标签是rl", title: "别的", markdown: "无关", draft: false, tags: ["rl"] });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("rl").sort()).toEqual(["标签是rl", "真的rl"]);
    db.close();
  });

  it("中文子串照常", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "通信算子优化", markdown: "正文", draft: false });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("算子")).toEqual(["甲"]);
    db.close();
  });

  it("**中文紧挨着英文时也要搜得到**", async () => {
    // 「cuda算子」里的「算子」：按词匹配的话，前一个字符是 a（英数字），会漏掉。
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "cuda算子优化", markdown: "", draft: false });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("算子")).toEqual(["甲"]);
    db.close();
  });

  it("**查询里带正则元字符要转义**", async () => {
    // `min(a` 两头是英数字，走按词匹配那条路（结尾是标点的走子串，碰不到正则）。
    // 不转义的话那个括号不配对，`new RegExp` **当场抛**——而这只是打了一半的函数名。
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "调用 min(a, b) 的时候", markdown: "", draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("min(a")).toEqual(["甲"]);
    db.close();
  });

  it("`c++` 这种以标点结尾的不会炸", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "写 c++ 的时候", markdown: "", draft: false, tags: ["c++"] });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("c++")).toEqual(["甲"]);
    db.close();
  });

  it("以标点结尾的查询走子串", async () => {
    // 两头都是英数字才按词匹配；`v1.` 结尾是点，就该按子串找。
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "升级到 v1.2 了", markdown: "", draft: false });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("v1.")).toEqual(["甲"]);
    db.close();
  });

  it("带标点的词也当整体找", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: "", draft: false, tags: ["cuda/Triton"] });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("cuda/Triton")).toEqual(["甲"]);
    db.close();
  });

  it("**搜的时候不该搜到 HTML 标签本身**", async () => {
    // 那 87 篇正文里全是 `<p style="">`。不剥标签的话，搜 "style" 会命中所有文章。
    const it_ = await ready();
    await it_.store.save({ slug: "老的", title: "老的", markdown: '<p style="">真正的正文</p>', draft: false });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.search("style")).toEqual([]);
    expect(db.search("真正的正文")).toEqual(["老的"]);
    db.close();
  });

  it("**标出正文是原始 HTML 的那些**", async () => {
    // 它们在 markdown 编辑器里改不得（往返会改坏），所以列表得一眼看得出来。
    const it_ = await ready();
    await it_.store.save({ slug: "老的", title: "老的", markdown: '<p style="">正文</p>', draft: false });
    await it_.store.save({ slug: "新的", title: "新的", markdown: "# 新的\n\n正文", draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    const by = Object.fromEntries(db.articles().map((one) => [one.slug, one.html]));
    expect(by["老的"]).toBe(true);
    expect(by["新的"]).toBe(false);
    db.close();
  });

  it("**「没有 tags 字段」不等于「tags 是空的」**", async () => {
    // 混同的后果在写回时才出现：那 45 篇从没写过 tags 的文章会凭空多一行 `tags: []`。
    const it_ = await ready();
    await it_.store.save({ slug: "没标签", title: "没标签", markdown: "", draft: false });
    await it_.store.save({ slug: "空标签", title: "空标签", markdown: "", draft: false, tags: [] });

    const db = it_.index();
    await db.reindex(it_.store);
    const by = Object.fromEntries(db.articles().map((one) => [one.slug, one.tags]));
    expect(by["没标签"]).toBeUndefined();
    expect(by["空标签"]).toEqual([]);
    db.close();
  });

  it("**版本对得上就别重建**——打开一次不该把库清空", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: "", draft: false });
    const first = it_.index();
    await first.reindex(it_.store);
    first.close();

    // 再打开，不 reindex：内容该还在。
    const again = it_.index();
    expect(again.articles().map((one) => one.slug)).toEqual(["甲"]);
    again.close();
  });

  it("**老 schema 的库：推倒重建，不报错**", async () => {
    // `create table if not exists` 不会给已有的表补列，老库会一直用着老 schema，
    // 直到某个查询报「no column named html」。实际就是这么撞上的。
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: "正文", draft: false });
    const first = it_.index();
    await first.reindex(it_.store);
    first.close();

    // 假装它是上一版建的：把版本号改回去，并且拆掉一列。
    const raw = new (await import("node:sqlite")).DatabaseSync(it_.db);
    raw.exec("alter table articles drop column html");
    raw.exec("pragma user_version = 1");
    raw.close();

    const again = it_.index();
    await again.reindex(it_.store);
    expect(again.articles().map((one) => one.slug)).toEqual(["甲"]);
    expect(again.search("正文")).toEqual(["甲"]);
    again.close();
  });

  it("**删掉 .db，重扫出来一模一样**", async () => {
    // 这是索引的定义：它不是真相，所以扔了不该丢任何东西。
    const it_ = await ready();
    await it_.store.save({
      slug: "甲", title: "甲文", markdown: '正文[ctx:x1] <img src="/images/i.png">', draft: false, tags: ["a", "b"],
    });
    await it_.store.save({ slug: "乙", title: "乙文", markdown: "", draft: true });

    const first = it_.index();
    await first.reindex(it_.store);
    const before = { articles: first.articles(), citing: first.citing("x1"), using: first.using("i.png") };
    first.close();

    await rm(it_.db);

    const again = it_.index();
    await again.reindex(it_.store);
    expect({ articles: again.articles(), citing: again.citing("x1"), using: again.using("i.png") }).toEqual(before);
    again.close();
  });

  it("**反向问：这条 context 被哪几篇引用过**", async () => {
    // 这是索引唯一能给、扫文件给不了的东西。
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: "用了[ctx:x1]", draft: false });
    await it_.store.save({ slug: "乙", title: "乙", markdown: "也用了[ctx:x1]，还有[ctx:y2]", draft: false });
    await it_.store.save({ slug: "丙", title: "丙", markdown: "没用", draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.citing("x1").sort()).toEqual(["乙", "甲"]);
    expect(db.citing("y2")).toEqual(["乙"]);
    expect(db.citing("从来没有过")).toEqual([]);
    db.close();
  });

  it("**反向问：这张图被哪几篇用着**", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: '<img src="/images/a.png">', draft: false });
    await it_.store.save({ slug: "乙", title: "乙", markdown: "![](/images/a.png) ![](/images/b.png)", draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.using("a.png").sort()).toEqual(["乙", "甲"]);
    expect(db.using("b.png")).toEqual(["乙"]);
    expect(db.using("没人用.png")).toEqual([]);
    db.close();
  });

  it("**这几篇用了哪些图**——「这次要传哪些」就是从这儿算的", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: '<img src="/images/a.png">', draft: false });
    await it_.store.save({ slug: "乙", title: "乙", markdown: '<img src="/images/b.png">', draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.imagesOf(["甲"])).toEqual(["a.png"]);
    expect(db.imagesOf(["甲", "乙"]).sort()).toEqual(["a.png", "b.png"]);
    // 两篇共用同一张时只回一次——不然「这次要传 12 张」里有一半是重复的。
    await it_.store.save({ slug: "丙", title: "丙", markdown: '<img src="/images/a.png">', draft: false });
    await db.reindex(it_.store);
    expect(db.imagesOf(["甲", "丙"])).toEqual(["a.png"]);
    // 一篇都不给就是一张都不要，**不是「全都要」**——空集合最容易被写成通配。
    expect(db.imagesOf([])).toEqual([]);
    db.close();
  });

  it("孤儿：磁盘上有、没人引用的那些", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: '<img src="/images/用着的.png">', draft: false });

    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.orphans(["用着的.png", "没人要的.png"])).toEqual(["没人要的.png"]);
    db.close();
  });

  it("下架的文章也算「在用」——它只是没上线，不是不存在", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "下架的", title: "下架的", markdown: '<img src="/images/x.png">', draft: true });
    const db = it_.index();
    await db.reindex(it_.store);
    expect(db.orphans(["x.png"])).toEqual([]);
    db.close();
  });

  it("文件改了，行跟着更新", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "旧标题", markdown: "", draft: false });
    const db = it_.index();
    await db.reindex(it_.store);

    await it_.store.save({ slug: "甲", title: "新标题", markdown: "", draft: true });
    await db.reindex(it_.store);

    expect(db.articles()).toHaveLength(1);
    expect(db.articles()[0]!.title).toBe("新标题");
    expect(db.articles()[0]!.draft).toBe(true);
    db.close();
  });

  it("**文件没了，行也要没**", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: '用了[ctx:x1] <img src="/images/i.png">', draft: false });
    const db = it_.index();
    await db.reindex(it_.store);

    await it_.store.remove("甲", 1787900000000);
    await db.reindex(it_.store);

    expect(db.articles()).toEqual([]);
    // 引用也要跟着走，否则「这条 context 被谁引用过」会一直报一篇不存在的文章。
    expect(db.citing("x1")).toEqual([]);
    expect(db.using("i.png")).toEqual([]);
    db.close();
  });

  it("扫两遍不会插两行", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "甲", title: "甲", markdown: "用了[ctx:x1]", draft: false });
    const db = it_.index();
    await db.reindex(it_.store);
    await db.reindex(it_.store);
    expect(db.articles()).toHaveLength(1);
    expect(db.citing("x1")).toEqual(["甲"]);
    db.close();
  });

  it("目录里有坏文件也不该让整次扫描失败", async () => {
    const it_ = await ready();
    await it_.store.save({ slug: "好的", title: "好的", markdown: "", draft: false });
    await writeFile(path.join(it_.root, "site/content/blog/坏的.md"), "---\n没收尾的 frontmatter", "utf8");

    const db = it_.index();
    await db.reindex(it_.store);
    // 坏的那份当成「整个文件都是正文」收下（ADR-0011 的形状），好的那份不受影响。
    expect(db.articles().map((one) => one.slug).sort()).toEqual(["坏的", "好的"]);
    db.close();
  });
});

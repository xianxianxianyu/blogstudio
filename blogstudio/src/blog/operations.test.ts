import { describe, expect, it } from "vitest";
import type { Context } from "../../../contextstudio/src/context";
import type { Article } from "./article-store";
import { promote, retag, withdraw } from "./operations";

const ONE: Article = {
  slug: "kv-cache",
  title: "KV cache 笔记",
  date: "2026-03-05T17:06:39+08:00",
  draft: true,
  tags: ["旧标签"],
  markdown: "复用能省算力[ctx:a1]。这是我的看法。[authored]",
};

const ctx = (id: string): Context => ({
  id,
  sourceClipId: `c-${id}`,
  source: { docId: "book-1", title: "某本书", locator: "第 3 页" },
  claim: null,
  evidence: "原文",
  stance: "support",
  status: "approved",
  sourceClipDeleted: false,
  topics: [],
});

const WHEN = Date.UTC(2026, 7, 27, 10, 20, 0);

describe("retag", () => {
  it("换掉标签，别的一个字不动", () => {
    const out = retag(ONE, ["新的", "另一个"]);
    expect(out.tags).toEqual(["新的", "另一个"]);
    expect(out.markdown).toBe(ONE.markdown);
    expect(out.draft).toBe(true);
    expect(out.date).toBe(ONE.date);
  });

  it("清空标签是空数组，不是把字段拿掉", () => {
    expect(retag(ONE, []).tags).toEqual([]);
  });
});

describe("withdraw / 上下架", () => {
  it("下架就是 draft: true，正文一个字不动", () => {
    const on = { ...ONE, draft: false };
    const out = withdraw(on, true);
    expect(out.draft).toBe(true);
    expect(out.markdown).toBe(on.markdown);
  });

  it("**幂等**：已经下架的再下架，什么都不该变", () => {
    expect(withdraw(ONE, true)).toEqual(ONE);
  });
});

describe("promote —— 上架", () => {
  it("**正文开头与标题相同的 `# ` 去掉**——Hugo 自己渲染 title，留着就是两个大标题", () => {
    const out = promote({ ...ONE, title: "题", markdown: "# 题\n\n正文。" }, [], WHEN, 480);
    expect(out.markdown).toBe("正文。");
  });

  it("开头的 `# ` 跟标题不一样就不动：那是正文里的一个标题", () => {
    const out = promote({ ...ONE, title: "题", markdown: "# 别的\n\n正文。" }, [], WHEN, 480);
    expect(out.markdown).toBe("# 别的\n\n正文。");
  });

  it("draft 变 false", () => {
    expect(promote(ONE, [ctx("a1")], WHEN, 480).draft).toBe(false);
  });

  it("**[ctx:] 就地变成脚注，id 藏进注释**", () => {
    const out = promote(ONE, [ctx("a1")], WHEN, 480);
    expect(out.markdown).toContain("复用能省算力[^1]。");
    expect(out.markdown).toContain("[^1]: 《某本书》 第 3 页 <!-- ctx:a1 -->");
    // 藏起来是为了**读者看不见、索引读得到**：渲染时那个注释会被吃掉。
    expect(out.markdown).not.toContain("[ctx:a1]");
  });

  it("[authored] 抹掉", () => {
    expect(promote(ONE, [ctx("a1")], WHEN, 480).markdown).not.toContain("[authored]");
  });

  it("没有 date 就补上当下，**带时区偏移**", () => {
    const fresh = { ...ONE, date: undefined };
    // 用 toISOString 的话是 Z 结尾的 UTC，Hugo 会照 UTC 排日期，晚上发的显示成中午。
    expect(promote(fresh, [], WHEN, 480).date).toBe("2026-08-27T18:20:00+08:00");
  });

  it("**已经有 date 就不动**——那是文章面世的日子，不是这次改动的时间", () => {
    expect(promote(ONE, [ctx("a1")], WHEN, 480).date).toBe(ONE.date);
  });

  it("**库里没有的 id：原样留着，并且报上来**", () => {
    // 悄悄删掉等于把一句没出处的话送上公网；悄悄渲染等于编一条参考。
    const out = promote({ ...ONE, markdown: "一段[ctx:没这条]。" }, [], WHEN, 480);
    expect(out.missing).toEqual(["没这条"]);
    expect(out.markdown).toContain("[ctx:没这条]");
  });

  it("**再上架一次，脚注不会被重复处理**", () => {
    // 下架、改、再上架是常事。第二次时正文里已经是脚注了，不该再动它。
    const once = promote(ONE, [ctx("a1")], WHEN, 480);
    const twice = promote({ ...once, draft: true }, [ctx("a1")], WHEN, 480);
    expect(twice.markdown).toBe(once.markdown);
  });

  it("同一条引两次，是同一个脚注号", () => {
    const twice = { ...ONE, markdown: "甲[ctx:a1]。乙[ctx:a1]。" };
    const out = promote(twice, [ctx("a1")], WHEN, 480);
    expect(out.markdown).toContain("甲[^1]。乙[^1]。");
    expect(out.markdown.match(/^\[\^1\]:/gm)).toHaveLength(1);
  });

  it("**第二次上架时，新引用接着上次的号往下发**", () => {
    // 从 1 重来的话会跟上次留下的 [^1] 撞上——Hugo 不报错，只是两处指向同一条参考。
    const once = promote(ONE, [ctx("a1")], WHEN, 480);
    const more = { ...once, draft: true, markdown: `${once.markdown}\n\n新一段[ctx:b2]。` };
    const out = promote(more, [ctx("a1"), ctx("b2")], WHEN, 480);
    expect(out.markdown).toContain("新一段[^2]。");
    expect(out.markdown).toContain("[^2]: 《某本书》 第 3 页 <!-- ctx:b2 -->");
  });

  it("[authored] 前面那个空格跟着一起走", () => {
    const spaced = { ...ONE, markdown: "这是我的看法。 [authored] 后面还有。" };
    expect(promote(spaced, [], WHEN, 480).markdown).toBe("这是我的看法。 后面还有。");
  });

  it("代码块里的记号一个都不许动", () => {
    const code = { ...ONE, markdown: '```ts\nconst m = "[ctx:a1]";\n```\n\n正文[ctx:a1]。' };
    const out = promote(code, [ctx("a1")], WHEN, 480);
    expect(out.markdown).toContain('const m = "[ctx:a1]";');
    expect(out.markdown).toContain("正文[^1]。");
  });
});

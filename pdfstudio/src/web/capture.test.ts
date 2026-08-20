import { describe, expect, it } from "vitest";
import { MAX_SNAPSHOT, recordOf } from "./capture";

const base = {
  visitedUrl: "https://example.com/a?utm_source=x#intro",
  finalUrl: "https://example.com/a?utm_source=x#intro",
  title: "某篇文章",
  viewportWidth: 1280,
  at: 1_700_000_000_000,
  text: "正文".repeat(100),
};

describe("网页摘录的证据记录", () => {
  it("身份用归一化的，回跳用逐字的——**两个都要存**", () => {
    const one = recordOf(base);

    expect(one.pageId).toBe("https://example.com/a");
    // 真正访问过的那个地址一字不改：归一化的用来判定身份，不能拿来回跳。
    expect(one.url).toBe(base.visitedUrl);
  });

  it("**存的是跟完重定向之后的地址**——短链接原样存下来等于没存", () => {
    const one = recordOf({ ...base, visitedUrl: "https://t.co/abc", finalUrl: "https://example.com/a" });

    expect(one.url).toBe("https://example.com/a");
    expect(one.pageId).toBe("https://example.com/a");
  });

  it("记下抓取时的视口宽度——响应式重排之后，矩形只有配上它才有意义", () => {
    expect(recordOf(base).viewportWidth).toBe(1280);
  });

  it("记下时间：规范给「文档会变」开的药方就是「记下当时是哪一版」", () => {
    expect(recordOf(base).at).toBe(base.at);
  });

  it("正文快照存下来——**orphan 之后唯一能「在当时的页面里重新搜」的东西**", () => {
    expect(recordOf(base).snapshot).toContain("正文");
  });

  it("快照有上限，超了就截断并标出来", () => {
    const huge = { ...base, text: "字".repeat(MAX_SNAPSHOT + 5000) };
    const one = recordOf(huge);

    expect(one.snapshot).toHaveLength(MAX_SNAPSHOT);
    expect(one.snapshotTruncated).toBe(true);
  });

  it("没截断时要明说没截断，**不能靠长度去猜**", () => {
    expect(recordOf(base).snapshotTruncated).toBe(false);
  });

  it("标题空着不给 undefined，给空串——下游不必到处判两种空", () => {
    expect(recordOf({ ...base, title: "   " }).title).toBe("");
  });

  it("视口宽度不合法时记 0 而不是编一个——0 的意思是「不知道」", () => {
    expect(recordOf({ ...base, viewportWidth: -1 }).viewportWidth).toBe(0);
    expect(recordOf({ ...base, viewportWidth: Number.NaN }).viewportWidth).toBe(0);
  });
});

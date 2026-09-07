import { describe, expect, it } from "vitest";
import { excerptOf, newDraft, summarize, titleOf, UNTITLED } from "./draft";

describe("稿子的名字", () => {
  it("第一个标题行就是名字", () => {
    expect(titleOf("# 一条 context 是一个断言\n\n正文")).toBe("一条 context 是一个断言");
  });

  it("标题不在第一行也认", () => {
    expect(titleOf("\n\n## 小标题\n正文")).toBe("小标题");
  });

  it("**还没写标题时退回第一行有字的**——那一行已经够认出这篇是什么了", () => {
    expect(titleOf("先随手记一句\n\n后面再补标题")).toBe("先随手记一句");
  });

  it("整篇空的才是未命名", () => {
    expect(titleOf("")).toBe(UNTITLED);
    expect(titleOf("\n \n")).toBe(UNTITLED);
  });

  it("太长的截断——列表一行放不下，且长标题会把时间挤掉", () => {
    expect(titleOf(`# ${"长".repeat(80)}`)).toHaveLength(61);
  });
});

describe("摘要", () => {
  it("是标题之后的第一句", () => {
    expect(excerptOf("# 标题\n\n- 第一条\n第二条")).toBe("第一条");
  });

  it("没有正文就是空串", () => {
    expect(excerptOf("# 标题")).toBe("");
  });

  it("没有标题时，第一行既当名字也当摘要的开头——不重复取同一行", () => {
    // 没有标题行时 `from` 是 -1，摘要从第 0 行起算，于是第一行会被取两次。
    expect(excerptOf("只有一行")).toBe("只有一行");
  });
});

describe("新起一篇", () => {
  it("是空的——预填一行假标题会让列表里一排「未命名」", () => {
    const draft = newDraft("d1", 1000);

    expect(draft.markdown).toBe("");
    expect(summarize(draft)).toEqual({ id: "d1", title: UNTITLED, excerpt: "", updatedAt: 1000 });
  });
});

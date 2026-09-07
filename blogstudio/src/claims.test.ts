import { describe, expect, it } from "vitest";
import { AUTHORED, citedIds, claimsOf, markAuthored } from "./claims";

const kinds = (markdown: string) => claimsOf(markdown).map((one) => one.provenance.kind);

describe("断言与出处", () => {
  it("一段就是一条断言，空行分开", () => {
    const claims = claimsOf("第一段\n还是第一段\n\n第二段");

    expect(claims.map((one) => one.text)).toEqual(["第一段\n还是第一段", "第二段"]);
    expect(claims[1].line).toBe(4);
  });

  it("**标题不是断言**——它是结构，不是主张", () => {
    expect(claimsOf("# 标题\n\n## 小标题\n\n正文")).toHaveLength(1);
  });

  it("代码块、表格、分隔线里的东西都不算", () => {
    const markdown = ["```js", "const 这不是断言 = 1;", "```", "", "| 表 | 格 |", "", "---", "", "正文"].join("\n");

    expect(claimsOf(markdown).map((one) => one.text)).toEqual(["正文"]);
  });

  it("**列表项各算一条**——整个列表算一条的话，一条带了出处剩下的就免检了", () => {
    const claims = claimsOf("- 第一条 [authored]\n- 第二条\n- 第三条 [ctx:c1]");

    expect(claims).toHaveLength(3);
    expect(claims.map((one) => one.provenance.kind)).toEqual(["authored", "none", "cited"]);
  });

  it("引文跟着它的解释走，不单独要出处", () => {
    expect(claimsOf("> 别人说的一句话\n\n我的解读 [authored]").map((one) => one.text)).toEqual([
      "我的解读 [authored]",
    ]);
  });

  it("**空段落不是断言**——编辑器把它序列化成 `<br />`，那是排版不是话", () => {
    // 两个标题中间空着的一篇：此前这里会报出几条指着 `<br />` 的「没有出处」，
    // 而那种问题人是消不掉的。
    expect(claimsOf("# 你好\n\n<br />\n\n# 晚上好\n\n<br />")).toEqual([]);
  });

  it("认出引了哪几条", () => {
    const claims = claimsOf("这一点见 [ctx:c1] 和 [ctx:c2]。");

    expect(claims[0].provenance).toEqual({ kind: "cited", ids: ["c1", "c2"] });
  });

  it("**两个记号都在不算冲突**：一段话既引材料又下判断是常态，按有出处算", () => {
    expect(kinds("引了 [ctx:c1] 也是我的判断 [authored]")).toEqual(["cited"]);
  });

  it("什么都没标的就是 none——**这是唯一要被拦下来的一种**", () => {
    expect(kinds("一句没有出处的话")).toEqual(["none"]);
  });

  it("正文里引到的 id 去重列出", () => {
    expect(citedIds("[ctx:c1] 又见 [ctx:c1]，还有 [ctx:c2]")).toEqual(["c1", "c2"]);
  });
});

describe("标成我的观点", () => {
  it("添在这一段最后一行的末尾", () => {
    expect(markAuthored("第一段\n第二行\n\n另一段", 1)).toBe(`第一段\n第二行 ${AUTHORED}\n\n另一段`);
  });

  it("**能重复点而不叠加**——已经标过的原样返回", () => {
    const once = markAuthored("一句话", 1);

    expect(markAuthored(once, 1)).toBe(once);
  });

  it("已经有出处的不动它", () => {
    const cited = "有出处的一句 [ctx:c1]";

    expect(markAuthored(cited, 1)).toBe(cited);
  });

  it("指到一个没有断言的行，什么都不做", () => {
    expect(markAuthored("# 标题\n\n正文", 1)).toBe("# 标题\n\n正文");
  });
});

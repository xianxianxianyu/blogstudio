import { describe, expect, it } from "vitest";
import { check } from "./checks";
import type { Context } from "../../contextstudio/src/context";

function context(id: string, patch: Partial<Context> = {}): Context {
  return {
    id,
    sourceClipId: `clip_${id}`,
    source: { docId: "doc_1", title: "某本书", locator: "p.3" },
    claim: `断言 ${id}`,
    evidence: `证据 ${id}`,
    stance: null,
    status: "approved",
    sourceClipDeleted: false,
    topics: [],
    ...patch,
  };
}

const rules = (report: ReturnType<typeof check>) => report.findings.map((one) => one.rule);

describe("确定性检查", () => {
  it("干净的稿子什么都不报", () => {
    const markdown = "# 标题\n\n有出处的一段 [ctx:c1]\n\n我自己的判断 [authored]";

    expect(check(markdown, [context("c1")])).toEqual({ findings: [], verdict: "ok" });
  });

  it("**既无出处又没标 authored 的段落被拦下来**（§1.5）", () => {
    const report = check("# 标题\n\n一句没有出处的话", [context("c1")]);

    expect(rules(report)).toEqual(["no-provenance"]);
    expect(report.verdict).toBe("blocked");
  });

  it("引了库里没有的那条，拦下来", () => {
    const report = check("# 标题\n\n见 [ctx:早就删了]", [context("c1")]);

    expect(rules(report)).toEqual(["missing-context"]);
    expect(report.findings[0].what).toContain("早就删了");
    expect(report.verdict).toBe("blocked");
  });

  it("引了有争议或已否决的材料，只标记不拦——**要发的人自己判断**", () => {
    const pool = [context("c1", { status: "disputed" }), context("c2", { status: "rejected" })];
    const report = check("# 标题\n\n甲 [ctx:c1]\n\n乙 [ctx:c2]", pool);

    expect(rules(report)).toEqual(["shaky-context", "shaky-context"]);
    expect(report.verdict).toBe("marked");
  });

  it("**库读不出来时不查引用**——否则满屏「找不到」，而真正的问题是库没读出来", () => {
    expect(check("# 标题\n\n见 [ctx:c1]", null).findings).toEqual([]);
  });

  it("空章节拦下来（§5.1 的 TOC 覆盖度）", () => {
    const report = check("# 有内容的\n\n一句话 [authored]\n\n# 还空着的\n", []);

    expect(rules(report)).toEqual(["empty-section"]);
    expect(report.findings[0].excerpt).toBe("还空着的");
  });

  it("**有子节的章不算空**——内容在子节里", () => {
    const markdown = "# 大标题\n\n## 小标题\n\n正文 [authored]";

    expect(check(markdown, []).findings).toEqual([]);
  });

  it("两段在说同一件事，标出来", () => {
    const same = "纯 tag 匹配在库大了以后召回率会掉，而且主题体系还会漂 [authored]";
    const report = check(`# 标题\n\n${same}\n\n${same}`, []);

    expect(rules(report)).toEqual(["duplicate"]);
    expect(report.findings[0].what).toContain("第 3 行");
  });

  it("太短的段落不比重复——「所以呢？」和「是这样。」在字面上能像得离谱", () => {
    expect(check("# 标题\n\n所以呢 [authored]\n\n是这样 [authored]", []).findings).toEqual([]);
  });

  it("长到读不动的段落标出来，但不拦", () => {
    const report = check(`# 标题\n\n${"很".repeat(420)} [authored]`, []);

    expect(rules(report)).toEqual(["too-long"]);
    expect(report.verdict).toBe("marked");
  });

  it("报告按行号排，人是顺着稿子往下看的", () => {
    const markdown = "# 空的\n\n# 有的\n\n没出处的一段\n\n又一段没出处的话";
    const report = check(markdown, []);

    expect(report.findings.map((one) => one.line)).toEqual([1, 5, 7]);
  });
});

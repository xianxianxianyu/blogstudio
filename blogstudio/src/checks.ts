import type { Context } from "../../contextstudio/src/context";
import { claimsOf, type Claim } from "./claims";
import { outlineOf } from "./outline";
import { bigrams, similarity } from "./text";

/**
 * 确定性检查（`docs/workflow.md` §5.1）——**一行模型调用都没有**。
 *
 * 这是有意的，也是这一层的全部价值：能用代码算出来的事交给模型判断，等于把一件确定的
 * 事变成一件概率的事，还要为它付钱和等待。模型该判的是「论点成立吗、有没有自己的观点」，
 * 那是 §5.2，另一件事。
 *
 * 所以这个文件是**纯函数**：正文 + 库，进去；一份报告，出来。没有 IO、没有端点、
 * 不需要配置。
 */

export type Level = "blocked" | "marked";

export type Rule =
  /** 既没有出处也没标成自己的观点（§1.5）。 */
  | "no-provenance"
  /** 引的那条 context 在库里找不到。 */
  | "missing-context"
  /** 引了一条被判为存疑或已否决的材料。 */
  | "shaky-context"
  /** 某个标题底下一个段落都没有（§5.1 的「TOC 覆盖度」在这里的形态）。 */
  | "empty-section"
  /** 两段在说同一件事。 */
  | "duplicate"
  /** 一段长得离谱。 */
  | "too-long";

export interface Finding {
  rule: Rule;
  level: Level;
  /** 正文第几行，1 起。报告要能指到地方。 */
  line: number;
  /** 那一段的头一句，够人认出是哪里。 */
  excerpt: string;
  /** 人读的一句话，说清是什么问题。 */
  what: string;
}

export interface Report {
  findings: Finding[];
  /**
   * `blocked` = 这篇现在不能发；`marked` = 有几处值得看一眼；`ok` = 干净。
   *
   * **它不拦着保存**，只说明「能不能发」——写到一半的稿子当然是红的，那是正常状态，
   * 不是错误。把它做成保存的前置条件，人就只会学会绕过它。
   */
  verdict: "ok" | "marked" | "blocked";
}

/** 一段有多长算长。这是个手感值，不是量出来的——超了只标记，不阻断。 */
const TOO_LONG = 400;

/** 两段像到什么程度算重复。同样是手感值。 */
const SAME_ENOUGH = 0.72;

const head = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

/** 空章节：一个标题管辖的范围里，一条断言都没有。范围由大纲算（`outline.ts`）。 */
function emptySections(markdown: string, claims: Claim[]): Finding[] {
  return outlineOf(markdown)
    .filter((heading) => !claims.some((claim) => claim.line > heading.line && claim.line < heading.until))
    .map((heading) => ({
      rule: "empty-section" as const,
      level: "blocked" as const,
      line: heading.line,
      excerpt: heading.title,
      what: "这一节还是空的",
    }));
}

/** 重复：两两比。稿子的段落数是几十，平方也无所谓。 */
function duplicates(claims: Claim[]): Finding[] {
  const grams = claims.map((claim) => bigrams(claim.text));
  const found: Finding[] = [];

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      // 太短的段落别比：「所以呢？」和「是这样。」在二元组上能像得离谱。
      if (claims[i].text.length < 20 || claims[j].text.length < 20) continue;
      const score = similarity(grams[i], grams[j]);
      if (score < SAME_ENOUGH) continue;
      found.push({
        rule: "duplicate",
        level: "marked",
        line: claims[j].line,
        excerpt: head(claims[j].text),
        what: `和第 ${claims[i].line} 行那一段在说同一件事`,
      });
    }
  }
  return found;
}

/**
 * 查一遍。
 *
 * `pool` 是知识库现在有哪些 context——**取不到就别查那两条**（传空数组会让每一条引用
 * 都变成「库里找不到」，满屏红字，而真正的问题只是库没读出来）。调用方要把「库读失败」
 * 与「库是空的」分开，所以这里收的是 `null` 而不是空数组。
 */
export function check(
  markdown: string,
  pool: Context[] | null,
  options: {
    /**
     * 要不要查「每一段都得有出处或标成自己的观点」（§1.5）。
     *
     * 那条纪律是**接着知识库写**时的纪律：材料在库里，引了就标。没有知识库的地方
     * （`/write` 上就没有），每一段都要手打 `[authored]` 只是仪式——一个永远红、
     * 又不拦任何事的灯，人会学会无视它。默认查；没库的入口显式关掉。
     */
    provenance?: boolean;
  } = {},
): Report {
  const claims = claimsOf(markdown);
  const byId = new Map((pool ?? []).map((one) => [one.id, one]));
  const findings: Finding[] = [];
  const provenance = options.provenance ?? true;

  for (const claim of claims) {
    if (provenance && claim.provenance.kind === "none") {
      findings.push({
        rule: "no-provenance",
        level: "blocked",
        line: claim.line,
        excerpt: head(claim.text),
        what: "这一段既没有出处，也没标成你自己的观点",
      });
    }

    if (claim.provenance.kind === "cited" && pool !== null) {
      for (const id of claim.provenance.ids) {
        const context = byId.get(id);
        if (!context) {
          findings.push({
            rule: "missing-context",
            level: "blocked",
            line: claim.line,
            excerpt: head(claim.text),
            what: `引的 [ctx:${id}] 在库里找不到`,
          });
          continue;
        }
        // disputed 是「有人不同意」，rejected 是「已经判定不成立」——两条都该在发出去
        // 之前被看见。§5.1 只写了 disputed，但引一条已被否决的材料显然更糟。
        if (context.status === "disputed" || context.status === "rejected") {
          findings.push({
            rule: "shaky-context",
            level: "marked",
            line: claim.line,
            excerpt: head(claim.text),
            what: `引的 [ctx:${id}] 现在是「${context.status === "disputed" ? "有争议" : "已否决"}」`,
          });
        }
      }
    }

    if (claim.text.length > TOO_LONG) {
      findings.push({
        rule: "too-long",
        level: "marked",
        line: claim.line,
        excerpt: head(claim.text),
        what: `这一段 ${claim.text.length} 字，长到读不动了`,
      });
    }
  }

  findings.push(...emptySections(markdown, claims), ...duplicates(claims));
  findings.sort((a, b) => a.line - b.line);

  return {
    findings,
    verdict: findings.some((one) => one.level === "blocked")
      ? "blocked"
      : findings.length > 0
        ? "marked"
        : "ok",
  };
}

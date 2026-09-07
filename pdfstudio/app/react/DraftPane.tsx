import { useState } from "react";
import type { Report } from "../../../blogstudio/src/checks";
import type { Heading } from "../../../blogstudio/src/outline";

/**
 * 右栏的「稿子」那一栏：**主体是大纲**。
 *
 * 第一版把检查结果整片铺在这里，实际写起来是这样的：一篇刚起头的稿子，屏幕右边是十几条
 * 一模一样的「这一段既没有出处」，而左边只有两行标题。**该显眼的东西被自己的完整性淹了**
 * ——人在写的时候要看的是「这篇现在长什么样」，不是「还欠多少笔账」。
 *
 * 所以现在：大纲占主体，每节后面缀一个小数字说明那一节有几处问题；明细收起来，
 * 点结论那一行才展开。与 Reader 那侧的摘录栏是同一个道理——那边也是目录当骨架，
 * 摘录挂在下面。
 */
export function DraftPane({
  outline,
  report,
  onJump,
  onMarkAuthored,
}: {
  outline: Heading[];
  /** 还没查过（正文刚打开、库还没读回来）就是 null。 */
  report: Report | null;
  /** 跳到第几个标题（`Heading.index`）。 */
  onJump: (headingIndex: number) => void;
  onMarkAuthored: (line: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const findings = report?.findings ?? [];

  /**
   * 这一节**自己身上**有几处问题：到下一个标题为止，不含子节的。
   *
   * 不用 `heading.until`（那个管到下一个同级标题，**包含子节**）：一章有三个小节各一处
   * 问题，章那一行就会显示 3，三个小节各显示 1——同一处问题在屏幕上出现两遍，而且没有
   * 折叠可以解释这种包含关系。各算各的，加起来正好是总数。
   */
  const countIn = (heading: Heading, at: number): number => {
    const until = outline[at + 1]?.line ?? heading.until;
    return findings.filter((one) => one.line >= heading.line && one.line < until).length;
  };

  return (
    <div className="pane">
      {outline.length === 0 ? (
        <p className="faint">
          这篇还没有标题。第一行写 <code># 标题</code>，大纲就长在这儿了——它也是这篇稿子的名字。
        </p>
      ) : (
        <ul className="draft-toc">
          {outline.map((heading, at) => {
            const many = countIn(heading, at);
            return (
              <li key={heading.index} data-depth={heading.level - 1}>
                <button className="grow" onClick={() => onJump(heading.index)}>
                  <span className="line">{heading.title}</span>
                  {/* 一节有几处问题只用一个数字说。**不用颜色也不写字**——这一栏是拿来
                      看结构的，每一节挂一句红字就又变回一面账单墙了。 */}
                  {many > 0 && <span className="count">{many}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="verdict-row">
        {/* 结论一行，点开才看明细。写到一半的稿子本来就是红的，那是正常状态，
            不该一直摊在眼前。 */}
        <button
          className={`verdict grow ${report?.verdict ?? "ok"}`}
          disabled={findings.length === 0}
          onClick={() => setOpen((was) => !was)}
        >
          {report === null ? "正在查…" : SAY[report.verdict]}
          {findings.length > 0 && <span className="faint"> {open ? "收起" : "看看"}</span>}
        </button>
      </div>

      {open && findings.length > 0 && (
        <ul className="findings">
          {findings.map((finding, index) => (
            <li key={`${finding.rule}:${finding.line}:${index}`} className={`finding ${finding.level}`}>
              <div className="row">
                <span className="at">第 {finding.line} 行</span>
                <span className="grow what">{finding.what}</span>
              </div>
              <p className="excerpt">{finding.excerpt}</p>
              {/* 只有「没表态」这一条能一键解决：其余几条要么要改正文、要么要回知识库
                  处理，给个按钮反而是假装它能被一键消掉。 */}
              {finding.rule === "no-provenance" && (
                <button className="btn" onClick={() => onMarkAuthored(finding.line)}>
                  这是我自己的观点
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

    </div>
  );
}

const SAY: Record<Report["verdict"], string> = {
  ok: "查过了，没有问题",
  marked: "有几处值得看一眼",
  blocked: "这篇现在还不能发",
};

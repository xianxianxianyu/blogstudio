import { useEffect, useState } from "react";
import type { LoopReader } from "../http-loops";
import type { RunRecord } from "../../../blogstudio/src/loop/loop-store";
import { agoOf, tallyOf } from "../../src/app/loop-view";

/**
 * Loop 那一列：有哪些项目。
 *
 * **先看名字，点开才看细节**——一个项目跑了几十轮，把每一轮都摊在这一层，人第一眼
 * 看到的就是一片跟「我有哪些项目」无关的噪音。
 */
export function LoopsPage({ reader, onOpen }: { reader: LoopReader; onOpen: (project: string) => void }) {
  const [rows, setRows] = useState<{ project: string; runs: RunRecord[] }[] | null>(null);
  /**
   * 读到数据的那一刻。**不在渲染里调 `Date.now()`**——渲染必须是纯的，而且那样每次
   * 重渲染「几分钟前」都会悄悄变一个数，看着像在跳，其实数据一点没动。
   */
  const [readAt, setReadAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const projects = await reader.projects();
      const rows = await Promise.all(
        projects.map(async (project) => ({ project, runs: await reader.runs(project) })),
      );
      if (cancelled) return;
      setRows(rows);
      setReadAt(Date.now());
    })();
    return () => {
      cancelled = true;
    };
  }, [reader]);

  if (rows === null) return <div className="pane"><p className="muted">正在看…</p></div>;

  return (
    <div className="pane">
      <h2 className="section">Loop</h2>
      {rows.length === 0 ? (
        /* **不给「新建」按钮。** 一个项目就是一个目录加一份 `loop.md`，而那份文件的
           主体是两段 prompt——那种东西该在编辑器里写，不该在一个小输入框里敲。 */
        <p className="muted">
          还没有项目。在 <code>loops/</code> 下建一个目录，放一份 <code>loop.md</code> 进去
          （里面写「## 排任务」和「## 收口」两段）。
        </p>
      ) : (
        rows.map(({ project, runs }) => {
          const last = runs[0];
          return (
            <button key={project} className="loop-row" onClick={() => onOpen(project)}>
              <span className="grow">
                <strong>{project}</strong>
                <span className="faint"> · 跑过 {runs.length} 轮</span>
              </span>
              {/* 最近一轮的成绩摆在名字旁边：**这一列要回答的是「它还好吗」**，
                  而不只是「它叫什么」。 */}
              {last ? (
                <span className="faint">
                  {agoOf(last.startedAt, readAt)} · {tallyOf(last)}
                </span>
              ) : (
                <span className="faint">还没跑过</span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

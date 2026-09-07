import { useEffect, useState } from "react";
import type { LoopReader } from "../http-loops";
import type { RunDetail, RunRecord } from "../../../blogstudio/src/loop/loop-store";
import type { LoopSettings } from "../../../blogstudio/src/loop/loop-config";
import { agoOf, tallyOf } from "../../src/app/loop-view";

/**
 * 一个 loop 项目：**一行一轮，最新在最上面**。
 *
 * 不画执行图。三个阶段是固定的（plan → work → wrap），没有分支也没有边——一张永远
 * 长得一样的图，画出来只是占地方。等真出现第四种形状再说，那时图能从磁盘上这些文件
 * 推出来，不用改数据（`.scratch/loop/spec.md` §0、§3）。
 */
export function LoopPage({ project, reader }: { project: string; reader: LoopReader }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  /**
   * 读到数据的那一刻。**不在渲染里调 `Date.now()`**——渲染必须是纯的，而且那样每次
   * 重渲染「几分钟前」都会悄悄变一个数，看着像在跳，其实数据一点没动。
   */
  const [readAt, setReadAt] = useState(0);
  const [settings, setSettings] = useState<LoopSettings | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ n: number; detail: RunDetail } | null>(null);
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      reader.runs(project),
      reader.settings(project),
      reader.enabled(project),
    ]).then(([runs, settings, on]) => {
      if (cancelled) return;
      setRuns(runs);
      setReadAt(Date.now());
      setSettings(settings);
      setOn(on);
      // 回来时该看到的是**最新那一轮**，不是上次离开时停在的地方——这是一条一直
      // 往前走的流水，不是一本书。
      setOpen(runs[0]?.n ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [project, reader]);

  useEffect(() => {
    if (open === null) return;
    let cancelled = false;
    void reader.runDetail(project, open).then((detail) => {
      if (!cancelled) setDetail({ n: open, detail });
    });
    return () => {
      cancelled = true;
    };
  }, [project, open, reader]);

  if (runs === null) return <div className="pane"><p className="muted">正在看…</p></div>;

  return (
    <div className="pane">
      <div className="row">
        <h2 className="section grow">{project}</h2>
        {/**
          * 一个开关，不是「开关 + 现在跑一轮」两个按钮。
          *
          * **打开的那一刻它就会跑第一轮**——`due` 里「从没跑过就跑」那条规则管着这件事
          * （`blogstudio/src/loop/schedule.ts`）。所以开关自己就是那个「现在跑一轮」，
          * 不必再摆一个。
          *
          * 配置读不出来时不给开：开了也不会跑，而一个拨得动、却什么都不发生的开关
          * 只会让人以为是坏了。
          */}
        <button
          className={`btn${on === true ? " primary" : ""}`}
          disabled={on === null || settings === null}
          onClick={() => {
            const next = !on;
            setOn(next);
            void reader.setEnabled(project, next);
          }}
        >
          {on === null ? "…" : on ? "跑着（点一下停）" : "开始跑"}
        </button>
      </div>

      {settings === null ? (
        /* **说清楚是配置的问题，不是「没跑过」。** 两者在界面上长得一样（都是空的），
           而处置完全不同：一个要去改文件，一个只要等。 */
        <p className="err">
          <code>loop.md</code> 读不出来，所以这个项目一轮都不会跑。
          它要有 <code>everyHours</code>、<code>runCapUsd</code>，
          正文里要有「## 排任务」和「## 收口」两段，缺一样都不认。
        </p>
      ) : (
        <p className="faint">
          每 {settings.everyMs / 3600_000} 小时一轮 · 每轮最多 ${settings.runCapUsd}
        </p>
      )}

      {runs.length === 0 && settings !== null && (
        <p className="muted">
          {on ? "开着，第一轮马上就跑。" : "还没跑过，也没开着——按上面那个按钮它才会动。"}
        </p>
      )}

      {runs.map((run) => (
        <div key={run.n} className={`run${open === run.n ? " open" : ""}`}>
          <button className="run-head" onClick={() => setOpen(open === run.n ? null : run.n)}>
            <strong>第 {run.n} 轮</strong>
            <span className="faint">{agoOf(run.startedAt, readAt)}</span>
            <span className="grow">{tallyOf(run)}</span>
            {/* **写的是「最多」，不是「花了」。** 模型端口不交出用量，实际花费在这一层
                取不到；摆一个编出来的数字，人会拿它当账看（spec §9）。 */}
            <span className="faint">最多 ${run.capUsd}</span>
          </button>

          {open === run.n && (
            <div className="run-body">
              {detail?.n !== run.n ? (
                <p className="muted">正在读…</p>
              ) : (
                <>
                  {detail.detail.report === null ? (
                    <p className="muted">这一轮还没有最终报告。</p>
                  ) : (
                    <pre className="report">{detail.detail.report}</pre>
                  )}

                  <h3 className="section">各件</h3>
                  {detail.detail.tasks.map((task) => (
                    <details key={task.id}>
                      <summary>
                        {task.id} {task.title}
                        {/* 没做成的**在这里也要看得见**：报告里写着「02 没做成」，
                            读者顺着翻过来必须找得到 02，而不是扑空。 */}
                        {task.report === null && <span className="faint"> · 没有产出</span>}
                      </summary>
                      {task.report !== null && <pre className="report">{task.report}</pre>}
                      {/* 发出去的原文。**report 读着不对劲时，能对回来的只有它**——
                          到底是任务写得不好，还是干活的没干好。 */}
                      <details>
                        <summary className="faint">当时发出去的任务原文</summary>
                        <pre className="report">{task.source}</pre>
                      </details>
                    </details>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

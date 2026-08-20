import { useCallback, useEffect, useMemo, useState } from "react";
import type { StudioView } from "../../../contextstudio/src/api";
import type { Focus } from "../../../contextstudio/src/focus";
import type { Cluster } from "../../../contextstudio/src/cluster";

/**
 * Context Studio 页——与书架页并列的第二个顶层页面。
 *
 * **不画全局图。** 那是量出来的，不是省事：断言级粒度下 320 条就有 7 千条边、密度 27.8%
 * 且不随 N 衰减，2000 条时 29 万条边（`contextstudio/docs/adr/0002`）。画出来是一团毛线。
 *
 * 所以是三层下钻：**簇总览 →（点一簇）簇内的 context →（点一条）它的一跳邻居**。
 * 每一层屏幕上的东西都是有限的，而且每一层都能说出「为什么这几条在一起」。
 */
export function ContextStudioPage({
  studio,
  onBack,
}: {
  studio: {
    view: () => Promise<StudioView>;
    focus: (id: string) => Promise<Focus | null>;
    update: (id: string, patch: { topics: string[] }) => Promise<void>;
    sweep: () => Promise<number>;
  };
  onBack: () => void;
}) {
  const [view, setView] = useState<StudioView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openCluster, setOpenCluster] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setView(await studio.view());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [studio]);

  useEffect(() => {
    // `alive` 而不是直接 setState：切走再切回来会发出第二次请求，先回来的那次若在
    // 组件已卸载后落地就是一次无主的写。顺带这也是 react-hooks 那条规则要的形状。
    let alive = true;
    studio.view().then(
      (fresh) => {
        if (alive) setView(fresh);
      },
      (cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [studio]);

  async function sweep() {
    setBusy(true);
    try {
      await studio.sweep();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const byId = useMemo(
    () => new Map((view?.contexts ?? []).map((one) => [one.id, one])),
    [view],
  );
  const cluster = view?.clustering.clusters.find((one) => one.id === openCluster) ?? null;

  return (
    <div className="studio">
      <header className="studio-bar">
        <button className="btn" onClick={onBack}>
          ← 书架
        </button>
        <h1>Context Studio</h1>
        <span className="grow" />
        {view && (
          <span className="muted">
            {view.contexts.length} 条 · {view.graph.edges.length} 条边 ·{" "}
            {view.clustering.clusters.length} 簇 · 模块度{" "}
            {view.clustering.modularity.toFixed(2)}
          </span>
        )}
        <button className="btn" disabled={busy} onClick={() => void sweep()}>
          {busy ? "扫描中…" : "从书架收取"}
        </button>
      </header>

      {error && <p className="notice">{error}</p>}

      {view && view.contexts.length === 0 && (
        <p className="empty">
          知识库还是空的。点「从书架收取」，把已入库的摘录收成 context——
          <b>那是临时通道</b>，PDF Studio 那侧真正的导出层还没落地。
        </p>
      )}

      {view && view.contexts.length > 0 && (
        <div className="studio-body">
          <aside className="studio-side">
            <ClusterMap
              clusters={view.clustering.clusters}
              open={openCluster}
              onOpen={(id) => {
                setOpenCluster(id);
                setFocus(null);
              }}
            />
            {view.clustering.orphans.length > 0 && (
              <p className="muted orphans">
                {view.clustering.orphans.length} 条落单——没有主题，或者和谁都不像一伙的。
                <b>不是脏数据</b>，是新主题的种子。
              </p>
            )}
            {view.clustering.modularity < 0.2 && (
              <p className="notice">
                模块度只有 {view.clustering.modularity.toFixed(2)}：这批 context 本来就分不太开，
                下面这些簇不必太当真。
              </p>
            )}
          </aside>

          <main className="studio-main">
            {focus ? (
              <FocusView
                focus={focus}
                claimOf={(id) => byId.get(id)?.claim ?? null}
                onPick={(id) => void studio.focus(id).then(setFocus)}
                onClose={() => setFocus(null)}
              />
            ) : cluster ? (
              <ClusterView
                cluster={cluster}
                claimOf={(id) => byId.get(id)?.claim ?? null}
                evidenceOf={(id) => byId.get(id)?.evidence ?? ""}
                onPick={(id) => void studio.focus(id).then(setFocus)}
              />
            ) : (
              <p className="empty">左边点一簇看看它讲什么。</p>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/** 簇总览：一簇一行，宽度即大小，标签是簇内最常出现的主题。 */
function ClusterMap({
  clusters,
  open,
  onOpen,
}: {
  clusters: Cluster[];
  open: string | null;
  onOpen: (id: string) => void;
}) {
  const widest = clusters[0]?.contexts.length || 1;
  return (
    <ol className="clusters">
      {clusters.map((one) => (
        <li key={one.id}>
          <button
            className={one.id === open ? "cluster on" : "cluster"}
            onClick={() => onOpen(one.id)}
          >
            <span
              className="bar"
              style={{ width: `${Math.max(6, (100 * one.contexts.length) / widest)}%` }}
            />
            <span className="label">
              {/* 簇没有名字，只有「它内部最常出现的几个主题」——那是它唯一诚实的标签。 */}
              {one.topics.slice(0, 3).map((stat) => stat.display).join(" · ") || "（无主题）"}
            </span>
            <span className="count">{one.contexts.length}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function ClusterView({
  cluster,
  claimOf,
  evidenceOf,
  onPick,
}: {
  cluster: Cluster;
  claimOf: (id: string) => string | null;
  evidenceOf: (id: string) => string;
  onPick: (id: string) => void;
}) {
  return (
    <>
      <h2>{cluster.topics.slice(0, 3).map((stat) => stat.display).join(" · ")}</h2>
      <p className="muted">
        {cluster.contexts.length} 条。主题：
        {cluster.topics.map((stat) => `${stat.display}(${stat.size})`).join("、")}
      </p>
      <ul className="context-list">
        {cluster.contexts.map((id) => (
          <li key={id}>
            <button className="context-card" onClick={() => onPick(id)}>
              <b>{claimOf(id) ?? "（还没有断言）"}</b>
              <span className="evidence">{evidenceOf(id).slice(0, 160)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * 聚焦视图：一条 context 和它的一跳邻居。
 *
 * 邻居按稀有度排序——不是「冷门更有意思」的直觉，是 94% 的边只共享 1 个主题，
 * 「共享几个」压根排不出名次（`contextstudio/src/focus.ts`）。
 */
function FocusView({
  focus,
  claimOf,
  onPick,
  onClose,
}: {
  focus: Focus;
  claimOf: (id: string) => string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <button className="btn" onClick={onClose}>
        ← 回到这一簇
      </button>
      <h2>{focus.center.claim ?? "（还没有断言）"}</h2>
      <p className="muted">主题：{focus.center.topics.join("、") || "（无）"}</p>

      <h3>邻居</h3>
      {focus.neighbors.length === 0 && <p className="muted">没有邻居。孤儿是合法的。</p>}
      <ul className="context-list">
        {focus.neighbors.map((neighbor) => (
          <li key={neighbor.context.id}>
            <button className="context-card" onClick={() => onPick(neighbor.context.id)}>
              <b>{claimOf(neighbor.context.id) ?? "（还没有断言）"}</b>
              {/* 点开一条边要能说出它为什么连。 */}
              <span className="why">因为都讲 {neighbor.topics.join("、")}</span>
            </button>
          </li>
        ))}
      </ul>
      {focus.hidden > 0 && (
        // 截掉的必须显式说出来，否则读者会以为这个节点就这么点邻居。
        <p className="muted">另有 {focus.hidden} 个邻居没显示。</p>
      )}
    </>
  );
}

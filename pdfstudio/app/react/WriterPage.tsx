import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Writer } from "../../../blogstudio/src/writing";

/**
 * 稿子架——Writer 这一侧的根，与书架、Context Studio 并列（ADR-0004）。
 *
 * 和书架是同一个层级关系：这一页是「有哪些稿子」，点开一篇才进「写这一篇」。
 */
export function WriterPage({ writer, onOpen }: { writer: Writer; onOpen: (id: string) => void }) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => writer.subscribe(listener), [writer]),
    () => writer.state,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 进这一页就重读一次：稿子可能是在别的编辑器里加进去的（目录里就是一堆 .md）。
    writer.refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [writer]);

  async function start() {
    try {
      onOpen(await writer.create());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`删掉《${title}》？不可撤销。`)) return;
    try {
      await writer.remove(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="shelf-page">
      <header>
        <h1 className="grow">稿子</h1>
        <button className="btn primary" onClick={() => void start()}>
          新起一篇
        </button>
      </header>

      {error !== null && <pre className="err">{error}</pre>}

      <div className="books">
        {state.drafts.map((draft) => (
          <div key={draft.id} className="book">
            <button className="open grow" onClick={() => onOpen(draft.id)}>
              <span className="spine paper" />
              <span className="grow">
                <span className="title">{draft.title}</span>
                <span className="meta">
                  {draft.excerpt === "" ? "还没有正文" : draft.excerpt}
                  {" · "}
                  {when(draft.updatedAt)}
                </span>
              </span>
            </button>
            <button className="btn" onClick={() => void remove(draft.id, draft.title)}>
              删除
            </button>
          </div>
        ))}
      </div>

      {state.drafts.length === 0 && (
        <p className="empty">
          还没有稿子。新起一篇，或者把写好的 <code>.md</code> 直接放进书库旁边的{" "}
          <code>drafts/</code> 目录——那里的文件不用导入就能打开。
        </p>
      )}
    </div>
  );
}

/** 「几分钟前」这种。写东西的人一天里回来好几趟，绝对时间对他没有意义。 */
function when(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN");
}

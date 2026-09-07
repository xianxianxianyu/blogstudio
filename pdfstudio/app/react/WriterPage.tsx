import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Writer } from "../../../blogstudio/src/writing";
import type { BlogClient, BlogView, Trashed } from "../http-blog";

/**
 * 稿子架——Writer 这一侧的根，与书架、Context Studio 并列（ADR-0004）。
 *
 * 列表**从索引来**，不从 `writer.state`：索引里有标签、在架/下架、以及「正文是不是
 * 原始 HTML」，而那三样正是在 94 篇里找到想改的那一篇所需要的。`writer` 仍然管动作
 * （新起一篇、删掉一篇），因为那些要走它的落盘那条路。
 */
export function WriterPage({
  writer,
  blog,
  onOpen,
}: {
  writer: Writer;
  blog: BlogClient;
  onOpen: (id: string) => void;
}) {
  useSyncExternalStore(
    useCallback((listener: () => void) => writer.subscribe(listener), [writer]),
    () => writer.state,
  );
  const [view, setView] = useState<BlogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 选中的标签。`null` = 不筛。 */
  const [tag, setTag] = useState<string | null>(null);
  /** 输入框里的字。搜索走服务端（要搜正文），所以**防抖一下**，别每敲一个字发一次。 */
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  /** 回收站。`null` = 还没看过（不主动读——**读一次就会顺手清掉过期的**）。 */
  const [trash, setTrash] = useState<Trashed[] | null>(null);
  /** 没人用的图。`null` = 收着。**只报不删**，删是下面每一行上人按的那一下。 */
  const [orphans, setOrphans] = useState<string[] | null>(null);

  const said = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), 200);
    return () => clearTimeout(timer);
  }, [typed]);

  const reload = useCallback(() => blog.list(query).then(setView), [blog, query]);

  useEffect(() => {
    // 进这一页、或者换了搜索词就重读：文章可能是在别的编辑器里改的
    // （目录里就是一堆 .md）。在回调里落地，effect 本身不同步改 state。
    void blog.list(query).then(setView, said);
  }, [blog, query]);

  const act = async (what: () => Promise<void>) => {
    try {
      await what();
      await reload();
      // 回收站开着的时候，丢掉/放回都要让它跟着变。
      if (trash !== null) setTrash(await blog.trash());
      // 图那一栏同理：丢掉一篇，它引用的图可能就没人用了。
      if (orphans !== null) setOrphans(await blog.orphanImages());
    } catch (cause) {
      said(cause);
    }
  };

  if (view === null) return <div className="shelf-page"><p className="muted">读文章…</p></div>;

  /**
   * 标签空间由索引给（`tags` 与 `categories` 合在一起）。
   *
   * **搜索缩小之后，标签栏跟着缩**——留着一堆点下去是空的标签，比不给标签更糟。
   */
  const shown = view.articles.filter((one) =>
    tag === null ? true : [...(one.tags ?? []), ...(one.categories ?? [])].includes(tag),
  );
  const present = new Set(view.articles.flatMap((one) => [...(one.tags ?? []), ...(one.categories ?? [])]));
  const labels = view.labels.filter(([name]) => present.has(name));

  return (
    <div className="shelf-page">
      <header>
        <h1 className="grow">文章 · {shown.length}</h1>
        <button
          className="btn primary"
          onClick={() => void act(async () => onOpen(await writer.create()))}
        >
          新起一篇
        </button>
      </header>

      {error !== null && <pre className="err">{error}</pre>}

      {/* 搜索：标题、标签、正文都算。**正文在服务端搜**——那 87 篇正文加起来两兆多，
          搬到前端只为搜一次不划算，而且正文本来就不在列表里。 */}
      <input
        className="writer-search"
        value={typed}
        placeholder="搜标题、标签、正文…"
        onChange={(event) => setTyped(event.target.value)}
      />

      {/* 标签筛选。**再点一次同一个就是取消**——不用另外放一个「清除」按钮。 */}
      {labels.length > 0 && (
        <div className="writer-tags">
          <button className={tag === null ? "on" : undefined} onClick={() => setTag(null)}>
            全部标签
          </button>
          {labels.map(([name, count]) => (
            <button
              key={name}
              className={tag === name ? "on" : undefined}
              onClick={() => setTag(tag === name ? null : name)}
            >
              {name} <span className="faint">{count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="books">
        {shown.map((one) => (
          <div key={one.slug} className="book">
            <button
              className="open grow"
              /* HTML 正文的那些点开也改不了（存回去会被改坏），**在点之前就说清楚**。 */
              title={one.html ? "这篇的正文是原始 HTML，在这儿改不了" : undefined}
              onClick={() => onOpen(one.slug)}
            >
              <span className="spine paper" />
              <span className="grow">
                <span className="title">
                  {one.title}
                  {one.draft && <span className="writer-off">下架</span>}
                  {one.html && <span className="writer-html">HTML</span>}
                </span>
                <span className="meta">
                  {(one.tags ?? []).join(" · ") || "没有标签"}
                  {one.updatedAt !== undefined && ` · ${when(one.updatedAt)}`}
                </span>
              </span>
            </button>
            <button
              className="btn"
              onClick={() => {
                if (!window.confirm(`把《${one.title}》丢进回收站？`)) return;
                void act(() => writer.remove(one.slug));
              }}
            >
              丢掉
            </button>
          </div>
        ))}
      </div>

      <div className="writer-trash">
        <button
          className="btn"
          onClick={() => void (trash === null ? blog.trash().then(setTrash, said) : setTrash(null))}
        >
          {trash === null ? "回收站" : `收起回收站（${trash.length}）`}
        </button>
        {trash !== null && (
          <>
            <p className="muted">
              丢掉的文章在 <code>.trash/</code> 里躺着，**超过一个月自动清掉**。
              没有后台定时器——扫这一下就发生在你打开这里、或者刚丢掉什么的时候。
            </p>
            {trash.length === 0 && <p className="empty">回收站是空的。</p>}
            {trash.map((one) => (
              <div key={one.name} className="publish-row">
                <span className="grow" title={one.name}>
                  {one.title}
                </span>
                <span className="faint">
                  {/* 认不出时间的**永远不自动清**，所以那一行要说出来，
                      免得人以为它跟别的一样有期限。 */}
                  {one.at === null ? "手放进来的 · 不会自动清" : `${when(one.at)}丢的`}
                </span>
                <button
                  className="btn"
                  onClick={() => void act(async () => void (await blog.restore(one.name)))}
                >
                  放回去
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="writer-trash">
        <button
          className="btn"
          onClick={() => void (orphans === null ? blog.orphanImages().then(setOrphans, said) : setOrphans(null))}
        >
          {orphans === null ? "没人用的图" : `收起（${orphans.length}）`}
        </button>
        {orphans !== null && (
          <>
            <p className="muted">
              正文里没有任何一篇引用的图。<b>不自动删</b>——一张图今天没人用，可能是某篇还在下架，
              也可能是你刚删错了一段。确定不要了再按。
            </p>
            {orphans.length === 0 && <p className="empty">每一张都有人用。</p>}
            {orphans.map((name) => (
              <div key={name} className="publish-row">
                <span className="grow" title={name}>
                  <code>{name}</code>
                </span>
                <button
                  className="btn"
                  onClick={() => {
                    if (!window.confirm(`删掉 ${name}？这一下不进回收站。`)) return;
                    void act(() => blog.removeImage(name));
                  }}
                >
                  删掉
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {shown.length === 0 && (
        <p className="empty">
          {view.articles.length === 0 && query === "" ? (
            <>
              还没有文章。新起一篇，或者把写好的 <code>.md</code> 直接放进{" "}
              <code>site/content/blog/</code>——那里的文件不用导入就能打开。
            </>
          ) : (
            `没找到${query === "" ? "" : `「${query}」`}${tag === null ? "" : `（标签 ${tag}）`}。`
          )}
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

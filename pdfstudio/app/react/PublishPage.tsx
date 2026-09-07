import { useEffect, useState } from "react";
import type { ArticleSummary, BlogClient } from "../http-blog";
import type { Changes } from "../../../blogstudio/src/publish/rsync-plan";
import type { Publishing, PublishView } from "../http-publish";

/**
 * 发布页：**左边是统一目录里的全部文章，右边是一个云端站点**。
 *
 * 改 tag、上下架、删除**都只改本地文件**；云端只在按下「同步」那一下才变。
 * 这不是设计上的克制，是静态站的事实：加一篇会改首页、分类页、标签页、RSS、sitemap，
 * 所以**没有「只上传一篇」这回事**。
 */
export function PublishPage({ blog, publishing }: { blog: BlogClient; publishing: Publishing }) {
  const [all, setAll] = useState<ArticleSummary[] | null>(null);
  const [view, setView] = useState<PublishView | null>(null);
  const [where, setWhere] = useState<string | null>(null);
  const [only, setOnly] = useState<"全部" | "在架" | "下架">("全部");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 干跑的结果。**要先看见删除清单，才允许真跑。** */
  const [dry, setDry] = useState<(Changes & { images: string[] }) | null>(null);

  const reload = async () => setAll((await blog.list()).articles);

  useEffect(() => {
    // 两样都在回调里落地，effect 本身不同步改 state——那会触发级联渲染。
    void blog.list().then((view) => setAll(view.articles));
    void publishing.view().then((next) => {
      setView(next);
      // 只有一个去处就替他选上——「选择」在只有一项时不是选择，是一道多余的手续。
      if (next.destinations.length > 0) setWhere(next.destinations[0]!.name);
    });
  }, [blog, publishing]);

  /** 一个本地操作跑完就重读列表。**任何一步失败都要说出来**，不能默默什么都没发生。 */
  const run = async (slug: string, what: string, act: () => Promise<string | null>) => {
    setBusy(`${slug}:${what}`);
    setNote(null);
    try {
      const said = await act();
      await reload();
      // 本地改完了，云端还是旧的——这一句必须在，否则人会以为已经生效了。
      setNote(said ?? "改好了。**云端还没变**，要按下面的「同步」才生效。");
      setDry(null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    if (where === null) return;
    setBusy("同步");
    setNote(null);
    try {
      setDry(await publishing.previewSync(where));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (where === null) return;
    setBusy("同步");
    try {
      const out = await publishing.sync(where);
      setDry(null);
      const img = out.images.length > 0 ? ` · 传了 ${out.images.length} 张图` : "";
      setNote(
        `已同步到 ${where}：新增 ${out.changes.added.length} · 改动 ${out.changes.changed.length} · 删除 ${out.changes.deleted.length}${img}`,
      );
      setView(await publishing.view());
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  if (all === null || view === null) return <div className="publish"><p className="muted">读文章…</p></div>;
  if (view.destinations.length === 0) return <div className="publish"><Empty problems={view.problems} /></div>;

  const shown = all.filter((one) =>
    only === "全部" ? true : only === "在架" ? !one.draft : one.draft,
  );

  return (
    <div className="publish">
      <div className="publish-list">
        <div className="seg">
          {(["全部", "在架", "下架"] as const).map((one) => (
            <button key={one} className={only === one ? "on" : undefined} onClick={() => setOnly(one)}>
              {one}
              <span className="faint">
                {" "}
                {one === "全部" ? all.length : all.filter((x) => (one === "在架" ? !x.draft : x.draft)).length}
              </span>
            </button>
          ))}
        </div>
        {shown.map((one) => (
          <Row
            key={one.slug}
            one={one}
            busy={busy}
            onRetag={(tags) =>
              void run(one.slug, "tag", async () => {
                await blog.retag(one.slug, tags);
                return null;
              })
            }
            onToggle={() =>
              void run(one.slug, "架", async () => {
                if (one.draft) {
                  const { missing } = await blog.promote(one.slug);
                  // **库里认不出的 id 要说出来**：它们原样留在正文里，会出现在公网上。
                  return missing.length === 0
                    ? null
                    : `上架了，但有 ${missing.length} 条引用在库里找不到，记号原样留着：${missing.join("、")}`;
                }
                await blog.withdraw(one.slug, true);
                return null;
              })
            }
            onRename={(slug) => {
              const to = window.prompt("换成什么地址？（只影响下架的文章）", slug);
              if (to !== null && to !== slug) {
                void run(slug, "地址", async () => {
                  await blog.rename(slug, to);
                  return `地址换成 /${to} 了。**云端还没变。**`;
                });
              }
            }}
            onRemove={() =>
              void run(one.slug, "删", async () => {
                const { trashed } = await blog.remove(one.slug);
                return `移进回收站了：${trashed}`;
              })
            }
          />
        ))}
      </div>

      <div className="publish-main">
        {view.problems.map((one) => (
          <div className="publish-warn" key={one}>
            <p>去处配置：{one}</p>
          </div>
        ))}

        <div className="seg">
          {view.destinations.map((one) => (
            <button
              key={one.name}
              className={where === one.name ? "on" : undefined}
              onClick={() => {
                setWhere(one.name);
                setDry(null);
              }}
            >
              {one.name}
            </button>
          ))}
        </div>

        {note !== null && <p className="publish-done">{note}</p>}

        <div className="publish-plan">
          <p className="muted">
            上面那些操作**只改了本地文件**。按下面这个才会动云端——而且
            <strong>一篇文章进出会牵动几十个页面</strong>（首页、分类页、标签页、RSS、
            sitemap 全要重算），所以「新增 18 个文件」不是出错。
          </p>

          {dry === null ? (
            <button className="btn" disabled={busy !== null} onClick={() => void preview()}>
              {busy === "同步" ? "算一遍…" : `看看同步到 ${where} 会变什么`}
            </button>
          ) : (
            <>
              <p>
                新增 {dry.added.length} · 改动 {dry.changed.length} ·{" "}
                {dry.images.length > 0 && <>要传 {dry.images.length} 张图 · </>}
                <strong className={dry.deleted.length > 0 ? "publish-gone" : undefined}>
                  删除 {dry.deleted.length}
                </strong>
              </p>
              {/* **删除单独列出来**：那是唯一不可逆的一段。 */}
              {/* 图片走的是另一条路（OSS），所以单独列——不然「同步」会悄悄多做一件事。 */}
              {dry.images.length > 0 && (
                <details className="publish-text">
                  <summary>这几张图会传到图床</summary>
                  <pre>{dry.images.join("\n")}</pre>
                </details>
              )}
              {dry.deleted.length > 0 && (
                <details className="publish-text" open>
                  <summary>会从云端删掉这些</summary>
                  <pre>{dry.deleted.join("\n")}</pre>
                </details>
              )}
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={busy !== null} onClick={() => void sync()}>
                  {busy === "同步" ? "同步中…" : `同步到 ${where}`}
                </button>
                <button className="btn" onClick={() => setDry(null)}>
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  one,
  busy,
  onRetag,
  onToggle,
  onRemove,
  onRename,
}: {
  one: ArticleSummary;
  busy: string | null;
  onRetag: (tags: string[]) => void;
  onToggle: () => void;
  onRemove: () => void;
  onRename: (slug: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState((one.tags ?? []).join(", "));

  return (
    <div className={`publish-row${one.draft ? " off" : ""}`}>
      <span className={`publish-kind ${one.draft ? "update" : "new"}`}>{one.draft ? "下架" : "在架"}</span>
      <span className="grow" title={one.slug}>
        {one.title}
      </span>
      {/* 地址只在下架时能改：**在架的换地址等于公网上换 URL，旧链接全断**。 */}
      {one.draft ? (
        <button className="publish-tagline" title="换地址" onClick={() => onRename(one.slug)}>
          /{one.slug}
        </button>
      ) : (
        <span className="publish-tagline" title="在架的不能换地址——先下架">
          /{one.slug}
        </span>
      )}
      {editing ? (
        <input
          className="publish-tags"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            onRetag(draft.split(",").map((x) => x.trim()).filter((x) => x !== ""));
          }}
        />
      ) : (
        <button className="publish-tagline" onClick={() => setEditing(true)}>
          {(one.tags ?? []).join(" · ") || "加标签"}
        </button>
      )}
      <button className="btn" disabled={busy !== null} onClick={onToggle}>
        {one.draft ? "上架" : "下架"}
      </button>
      {/* 删除是移进回收站，不是消失——所以不需要一个吓人的确认框，但字要说清楚。 */}
      <button className="btn" disabled={busy !== null} title="移进 .trash/，不是删掉" onClick={onRemove}>
        丢掉
      </button>
    </div>
  );
}

function Empty({ problems }: { problems: string[] }) {
  const sample = JSON.stringify(
    {
      repo: "/Users/你/Desktop/project/my-blog",
      site: "site",
      articles: "site/content/blog",
      destinations: [
        { name: "moyutianzun.com", host: "vps", path: "/srv/blog", baseURL: "https://moyutianzun.com/" },
      ],
    },
    null,
    2,
  );
  return (
    <div className="publish-empty">
      <h2>还没有去处</h2>
      <p className="muted">
        去处是一个<strong>云端站点</strong>：一台机器、一个目录、一个域名。在数据目录里放一份
        <code>destinations.json</code>：
      </p>
      <pre>{sample}</pre>
      <p className="muted">
        <code>host</code> 写的是 <code>~/.ssh/config</code> 里的别名——不写 IP、端口、用户名、
        密钥路径，那些已经在 ssh config 里了，抄一份就会漂，而且这样<strong>我们不存任何凭证</strong>。
      </p>
      {problems.map((one) => (
        <p key={one} className="err">
          {one}
        </p>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { createHttpBlog, type Article, type ArticleSummary, type BlogClient, type Trashed } from "../http-blog";
import { apiUrl } from "../api-base";
import type { Changes } from "../../../blogstudio/src/publish/rsync-plan";
import type { ArticleSection } from "../../../blogstudio/src/publish/scope";
import type { Publishing, PublishView } from "../http-publish";
import { AboutEditor } from "./AboutEditor";

/** Export 管 Blog、Project 和 About；推荐的页面与资源由同步层保护。 */
export function PublishPage({ blog, publishing }: { blog: BlogClient; publishing: Publishing }) {
  const project = useMemo(() => createHttpBlog(apiUrl("/__blog"), "projects"), []);
  const [tab, setTab] = useState<ArticleSection | "about">("blog");
  const client = tab === "projects" ? project : blog;
  const [all, setAll] = useState<ArticleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<PublishView | null>(null);
  const [where, setWhere] = useState<string | null>(null);
  const [only, setOnly] = useState<"全部" | "在架" | "下架">("全部");
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState<Trashed[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [aboutDirty, setAboutDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dry, setDry] = useState<(Changes & { images: string[] }) | null>(null);

  useEffect(() => {
    let active = true;
    void publishing.view().then(next => {
      if (!active) return;
      setView(next);
      setWhere(next.destinations[0]?.name ?? null);
    }, error => { if (active) setNote(String(error)); });
    return () => { active = false; };
  }, [publishing]);
  useEffect(() => {
    let active = true;
    void client.list().then(next => { if (active) { setAll(next.articles); setLoading(false); } }, error => { if (active) { setNote(String(error)); setLoading(false); } });
    return () => { active = false; };
  }, [client]);

  const run = async (act: () => Promise<string | void>) => {
    setBusy(true); setNote(null); setDry(null);
    try {
      const said = await act();
      setAll((await client.list()).articles);
      setNote(said || "已保存到本地，预览同步后发布到所选去处。");
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    if (!where) return;
    setBusy(true); setNote(null); setDry(null);
    try { setDry(await publishing.previewSync(where)); }
    catch (e) { setNote(String(e)); }
    finally { setBusy(false); }
  };
  const sync = async () => {
    if (!where) return;
    setBusy(true); setNote(null);
    try {
      const out = await publishing.sync(where);
      setDry(null);
      setNote(`已同步到 ${where}：新增 ${out.changes.added.length} · 改动 ${out.changes.changed.length} · 删除 ${out.changes.deleted.length}`);
      setView(await publishing.view());
    } catch (e) { setNote(String(e)); setDry(null); }
    finally { setBusy(false); }
  };
  const tabs = [["blog", "Blog"], ["projects", "Project"], ["about", "About"]] as const;
  const shown = all.filter(a => (only === "全部" || (only === "下架") === a.draft) && `${a.title} ${a.slug} ${(a.tags ?? []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (view?.destinations.length === 0) return <div className="publish"><Empty problems={view.problems} /></div>;
  return <div className="export-page">
    <header className="export-heading"><div><h2>Export</h2><p className="muted">管理 Blog、Project 和 About，发布到你的博客。</p></div><div className="seg">{tabs.map(([key, label]) => <button key={key} disabled={busy || aboutDirty} className={tab === key ? "on" : undefined} onClick={() => { if ((tab === "projects") !== (key === "projects")) setLoading(true); setTab(key); setNote(null); setQuery(""); setTrash(null); }}>{label}</button>)}</div></header>
    <div className="publish">
      <div className="publish-list">
        {tab === "about" ? <AboutEditor publishing={publishing} disabled={busy} onDirty={setAboutDirty} onSaved={() => { setDry(null); setAboutDirty(false); }} /> : <>
          <div className="row export-list-head"><strong>{tab === "blog" ? "Blog" : "Project"} · {all.length}</strong><input type="search" aria-label="搜索文章" placeholder="搜索标题、标签、地址" value={query} onChange={e => setQuery(e.target.value)} /></div>
          <div className="seg">{(["全部", "在架", "下架"] as const).map(state => <button key={state} className={only === state ? "on" : undefined} onClick={() => setOnly(state)}>{state}</button>)}</div>
          <p className="muted">在 Writer 撰写新文章，下架时可调整所属栏目。修改保存到本地，同步后上线。</p>
          <button className="btn" disabled={busy} onClick={() => void run(async () => { setTrash(trash === null ? await client.trash() : null); })}>{trash === null ? "查看回收站" : "收起回收站"}</button>
          {trash !== null && <div className="about-card"><h3>回收站</h3>{trash.length === 0 ? <p className="muted">回收站为空。</p> : trash.map(t => <div className="row about-actions" key={t.name}><span className="grow">{t.title}</span><button className="btn" disabled={busy} onClick={() => void run(async () => { await client.restore(t.name); setTrash(await client.trash()); })}>恢复</button></div>)}</div>}
          {loading ? <p className="muted">读取文章…</p> : shown.length === 0 ? <p className="muted">没有符合条件的文章。</p> : shown.map(one => <Row key={`${tab}:${one.slug}`} one={one} section={tab} client={client} busy={busy} run={run} />)}
        </>}
      </div>
      <aside className="publish-main">
        <h3>发布到</h3>
        {view?.problems.map(p => <p className="publish-warn" key={p}>{p}</p>)}
        <div className="seg">{view?.destinations.map(d => <button key={d.name} disabled={busy} className={where === d.name ? "on" : undefined} onClick={() => { setWhere(d.name); setDry(null); }}>{d.name}</button>)}</div>
        <p className="muted">同步 Blog、Project、About 及首页、标签和订阅等关联页面。Recommend 由独立流程更新。</p>
        {where && view?.syncs[where] && <p className="muted">上次同步：{new Date(view.syncs[where]!.at).toLocaleString()}</p>}
        {note && <p className="publish-done" role="status">{note}</p>}
        {aboutDirty && <p className="publish-warn">请先保存或撤销 About 的修改，再切换栏目或同步。</p>}
        {!dry ? <button className="btn primary" disabled={busy || aboutDirty || !where} onClick={() => void preview()}>{busy ? "处理中…" : "预览同步"}</button> : <div className="publish-plan">
          <p>新增 {dry.added.length} · 改动 {dry.changed.length} · <strong>删除 {dry.deleted.length}</strong></p>
          {([["新增", dry.added], ["改动", dry.changed], ["删除", dry.deleted], ["上传图片", dry.images]] as const).map(([label, files]) => files.length > 0 && <details className="publish-text" key={label} open={label === "删除"}><summary>{label} · {files.length}</summary><pre>{files.join("\n")}</pre></details>)}
          <div className="row about-actions"><button className="btn primary" disabled={busy || aboutDirty} onClick={() => void sync()}>{busy ? "同步中…" : `同步到 ${where}`}</button><button className="btn" disabled={busy} onClick={() => setDry(null)}>取消</button></div>
        </div>}
      </aside>
    </div>
  </div>;
}

function Row({ one, section, client, busy, run }: { one: ArticleSummary; section: ArticleSection; client: BlogClient; busy: boolean; run: (act: () => Promise<string | void>) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState((one.tags ?? []).join(", "));
  const [content, setContent] = useState<Article | null>(null);
  const [saved, setSaved] = useState<Article | null>(null);
  const other = section === "blog" ? "projects" : "blog";
  const label = other === "blog" ? "Blog" : "Project";
  return <article className={`export-article${one.draft ? " off" : ""}`}>
    <div className="row"><span className={`publish-kind ${one.draft ? "update" : "new"}`}>{one.draft ? "下架" : "在架"}</span><strong className="grow">{one.title}</strong></div>
    <p className="publish-tagline">/{section}/{one.slug.replace(/\.(en|zh-cn)$/, "")}/ {one.slug.endsWith(".en") ? "· English" : ""}</p>
    {editing ? <div className="row about-actions"><input aria-label="文章标签" className="publish-tags" value={tags} disabled={busy} onChange={e => setTags(e.target.value)} /><button className="btn" disabled={busy} onClick={() => void run(async () => { await client.retag(one.slug, tags.split(/[,，]/).map(t => t.trim()).filter(Boolean)); setEditing(false); })}>保存标签</button><button className="btn" disabled={busy} onClick={() => setEditing(false)}>取消</button></div> : <button className="publish-tagline" disabled={busy} onClick={() => { setTags((one.tags ?? []).join(", ")); setEditing(true); }}>{(one.tags ?? []).join(" · ") || "添加标签"}</button>}
    <div className="row about-actions">
      {!one.html && <button className="btn" disabled={busy} onClick={() => void run(async () => { const loaded = await client.load(one.slug); setContent(loaded); setSaved(loaded); return "编辑后按保存正文。"; })}>编辑正文</button>}
      {one.draft && <button className="btn" disabled={busy} onClick={() => { const next = window.prompt("文章的新地址（保留 .en / .zh-cn 语言后缀）", one.slug); if (next && next !== one.slug) void run(() => client.rename(one.slug, next)); }}>修改地址</button>}
      <button className="btn" disabled={busy} onClick={() => void run(async () => { if (one.draft) { const out = await client.promote(one.slug); if (out.missing.length) return `已在本地上架，有 ${out.missing.length} 条引用待核对：${out.missing.join("、")}`; } else await client.withdraw(one.slug, true); })}>{one.draft ? "上架" : "下架"}</button>
      {one.draft && <button className="btn" disabled={busy} onClick={() => void run(() => client.move(one.slug, other))}>移至 {label}</button>}
      <button className="btn" disabled={busy} onClick={() => void run(async () => { const { trashed } = await client.remove(one.slug); return `已移进回收站：${trashed}。同步后从线上移除。`; })}>移至回收站</button>
    </div>
    {content && <fieldset className="export-content-editor" disabled={busy}>
      <label className="about-field"><span>标题</span><input value={content.title} onChange={e => setContent({ ...content, title: e.target.value })} /></label>
      <label className="about-field"><span>正文 · Markdown</span><textarea rows={14} value={content.markdown} onChange={e => setContent({ ...content, markdown: e.target.value })} /></label>
      <div className="row about-actions"><button className="btn primary" onClick={() => void run(async () => {
        const latest = await client.load(one.slug);
        if (latest.markdown !== saved?.markdown || latest.title !== saved?.title) throw new Error("文章已在其他地方修改，请重新打开编辑");
        await client.save(one.slug, { title: content.title, markdown: content.markdown }); setContent(null);
      })}>保存正文</button><button className="btn" onClick={() => setContent(null)}>取消编辑</button></div>
    </fieldset>}
  </article>;
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

import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import type { AboutContent, AboutLanguage, AboutView, Direction } from "../../../blogstudio/src/publish/about";
import type { Publishing } from "../http-publish";

export function AboutEditor({ publishing, onDirty, onSaved, disabled }: {
  publishing: Publishing; onDirty: (dirty: boolean) => void; onSaved: () => void; disabled: boolean;
}) {
  const [view, setView] = useState<AboutView | null>(null);
  const [language, setLanguage] = useState<AboutLanguage>("zh-cn");
  const [draft, setDraft] = useState<AboutContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const dirty = draft !== null && view !== null && JSON.stringify(draft) !== JSON.stringify(view.content[language]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    let active = true;
    void publishing.about().then(v => { if (active) { setView(v); setDraft(v.content["zh-cn"]); } }, e => { if (active) setNote(String(e)); });
    return () => { active = false; };
  }, [publishing]);
  const load = async () => {
    setBusy(true);
    try { const v = await publishing.about(); setView(v); setDraft(v.content[language]); setNote("已重新载入"); }
    catch (e) { setNote(String(e)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft || !view) return;
    setBusy(true);
    try {
      const next = await publishing.saveAbout(language, draft, view.revision);
      setView(next); setDraft(next.content[language]); onSaved();
      setNote("已保存到本地，选择右侧去处并同步后上线。");
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (!draft || !view) return <div className="about-editor"><p>{note || "读取 About…"}</p><button className="btn" onClick={() => void load()}>重新载入</button></div>;
  const patch = (next: Partial<AboutContent>) => setDraft({ ...draft, ...next });
  const changeDirection = (i: number, next: Partial<Direction>) => patch({ directions: draft.directions.map((d, at) => at === i ? { ...d, ...next } : d) });
  const move = (i: number, delta: number) => {
    const directions = [...draft.directions];
    [directions[i], directions[i + delta]] = [directions[i + delta]!, directions[i]!];
    patch({ directions });
  };
  return <div className="about-editor">
    <div className="row about-toolbar">
      <div className="seg">{(["zh-cn", "en"] as const).map(lang => <button key={lang} disabled={busy || disabled || dirty} className={language === lang ? "on" : undefined} onClick={() => { setLanguage(lang); setDraft(view.content[lang]); setNote(""); }}>{lang === "en" ? "English" : "中文"}</button>)}</div>
      <button className="btn" onClick={() => setPreview(!preview)}>{preview ? "继续编辑" : "预览内容"}</button>
    </div>
    <p className="muted">分别编辑中英文内容。介绍和方向条目支持 Markdown；多条内容每行一项。</p>
    {note && <p role="status" className="publish-done">{note}</p>}
    {preview ? <div className="about-preview">
      <h2>{draft.title}</h2><Streamdown>{draft.intro}</Streamdown>
      <h3>{draft.currentTitle}</h3><div className="about-chips">{draft.current.map((c, i) => <span key={i}>{c}</span>)}</div>
      <h3>{draft.directionsTitle}</h3>{draft.directions.map(d => <article className="about-card" key={d.id}><h3>{d.title}</h3>{(["goal", "done", "problem"] as const).map(k => <div key={k}><h4>{k === "goal" ? "Goal" : k === "done" ? "Done" : "Problem"}</h4>{d[k].map((text, i) => <Streamdown key={i}>{text}</Streamdown>)}</div>)}<Streamdown>{d.note}</Streamdown></article>)}
      <h3>{draft.contactTitle}</h3>{draft.links.map((link, i) => <p key={i}>{link.label}: {link.text} <span className="muted">{link.url}</span></p>)}
    </div> : <fieldset disabled={busy || disabled}>
      <Text label="个人介绍" value={draft.intro} onChange={intro => patch({ intro })} rows={5} />
      <Text label="当前在做 · 标题" value={draft.currentTitle} onChange={currentTitle => patch({ currentTitle })} />
      <Lines label="当前在做 · 标签" value={draft.current} onChange={current => patch({ current })} />
      <Text label="方向 · 标题" value={draft.directionsTitle} onChange={directionsTitle => patch({ directionsTitle })} />
      {draft.directions.map((d, i) => <div className="about-card" key={d.id}>
        <div className="row about-toolbar"><strong className="grow">方向 {i + 1}</strong><button className="btn" disabled={i === 0} onClick={() => move(i, -1)}>上移</button><button className="btn" disabled={i === draft.directions.length - 1} onClick={() => move(i, 1)}>下移</button><button className="btn" onClick={() => patch({ directions: draft.directions.filter((_, at) => at !== i) })}>移除</button></div>
        <Text label="方向名称" value={d.title} onChange={title => changeDirection(i, { title })} />
        <Lines label="Goal · 想达成什么" value={d.goal} onChange={goal => changeDirection(i, { goal })} />
        <Lines label="Done · 已完成什么" value={d.done} onChange={done => changeDirection(i, { done })} />
        <Lines label="Problem · 当前问题" value={d.problem} onChange={problem => changeDirection(i, { problem })} />
        <Text label="补充说明" value={d.note} onChange={note => changeDirection(i, { note })} rows={2} />
      </div>)}
      <button className="btn" onClick={() => patch({ directions: [...draft.directions, { id: `d-${crypto.randomUUID()}`, title: "新方向", goal: [], done: [], problem: [], note: "" }] })}>＋ 添加方向</button>
      <Text label="联系方式 · 标题" value={draft.contactTitle} onChange={contactTitle => patch({ contactTitle })} />
      {draft.links.map((link, i) => <div className="about-card" key={i}>
        <Text label="平台名称" value={link.label} onChange={label => patch({ links: draft.links.map((l, at) => at === i ? { ...l, label } : l) })} />
        <Text label="显示文字" value={link.text} onChange={text => patch({ links: draft.links.map((l, at) => at === i ? { ...l, text } : l) })} />
        <Text label="链接地址" value={link.url} onChange={url => patch({ links: draft.links.map((l, at) => at === i ? { ...l, url } : l) })} />
        <button className="btn" onClick={() => patch({ links: draft.links.filter((_, at) => at !== i) })}>移除链接</button>
      </div>)}
      <button className="btn" onClick={() => patch({ links: [...draft.links, { label: "", text: "", url: "https://" }] })}>＋ 添加链接</button>
    </fieldset>}
    <div className="row about-actions"><button className="btn primary" disabled={!dirty || busy || disabled} onClick={() => void save()}>{busy ? "保存中…" : "保存 About"}</button><button className="btn" disabled={busy || disabled} onClick={() => { setDraft(view.content[language]); setNote(""); }}>撤销未保存修改</button><button className="btn" disabled={dirty || busy || disabled} onClick={() => void load()}>重新载入</button>{dirty && <span className="muted">有未保存修改</span>}</div>
  </div>;
}
function Text({ label, value, onChange, rows }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  return <label className="about-field"><span>{label}</span>{rows ? <textarea rows={rows} value={value} onChange={e => onChange(e.target.value)} /> : <input value={value} onChange={e => onChange(e.target.value)} />}</label>;
}
function Lines({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <Text label={label} value={value.join("\n")} rows={3} onChange={text => onChange(text === "" ? [] : text.split("\n"))} />;
}

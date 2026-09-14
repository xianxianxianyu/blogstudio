import { useCallback, useState, useSyncExternalStore } from "react";
import type { Writer } from "../../../blogstudio/src/writing";
import type { WritingTalk } from "../../../blogstudio/src/conversation";
import type { Context } from "../../../contextstudio/src/context";
import type { Settings } from "../../src/app/settings";
import type { Progress } from "../../src/app/progress";
import { closeOnDesk, isWriting, openDraftOnDesk, openSettings, type Active, type DeskItem } from "../../src/app/desk";
import type { BlogClient } from "../http-blog";
import type { Publishing } from "../http-publish";
import { Shell } from "./Shell";
import { WriterPage } from "./WriterPage";
import { DraftPage } from "./DraftPage";
import { PublishPage } from "./PublishPage";
import { Endpoints } from "./SettingsPage";
import { PanelBar } from "./PanelBar";

/**
 * `/write` 的外壳：**只有写和发**。
 *
 * 与 `App.tsx` 是同一个外壳（`Shell`）、同几张页面（`WriterPage` / `DraftPage` /
 * `PublishPage`），少的是 Book、Context、Loop 三根和它们的状态——那些在
 * `research.moyutianzun.com/write` 上不存在：没有书、没有 pdf.js、没有本地引擎。
 *
 * 不复用 `App` 再把三根藏起来：`App` 起手就要 `Workspace` 和 `PdfHost`，那意味着
 * 网页版也得加载 pdf.js 和整个阅读侧的状态机，只为了不用它。
 *
 * 顶上多一条 Panel 的栏（`PanelBar`），配色跟 Panel 走深色（`write.css`）：它挂在
 * `research.moyutianzun.com/write/`，与 Robot、Projects 是同一个应用的三个入口——
 * 用起来该是一个东西，那是壳和颜色的事，不是把页面搬进另一个仓库的事。
 */
export function WriteApp({
  settings,
  progress,
  publishing,
  blog,
  writer,
  talk,
  contexts,
}: {
  settings: Settings;
  progress: Progress;
  publishing: Publishing;
  blog: BlogClient;
  writer: Writer;
  talk: WritingTalk;
  contexts: () => Promise<Context[]>;
}) {
  const writing = useSyncExternalStore(
    useCallback((listener: () => void) => writer.subscribe(listener), [writer]),
    () => writer.state,
  );
  const config = useSyncExternalStore(
    useCallback((listener: () => void) => settings.subscribe(listener), [settings]),
    () => settings.config,
  );

  const [active, setActive] = useState<Active>({ kind: "writer" });
  const [desk, setDesk] = useState<DeskItem[]>([]);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 走开之前先把稿子存住——丢的是刚写的字，不能靠「多半来得及」。 */
  const leave = () => {
    if (active.kind === "draft") void writer.flush();
  };

  const openDraft = async (id: string) => {
    try {
      await writer.open(id);
      // 一篇文章一场对话：换篇就换场（`conversation.ts` 的 attach）。不接的话
      // `send` 会因为不知道在写哪篇而静默返回——字打了、什么都没发生。
      talk.attach(id);
      setActive({ kind: "draft", id });
      setDesk((was) => openDraftOnDesk(was, id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void writer.refresh();
    }
  };

  const save = (run: () => Promise<{ ok: boolean; reason?: string }>) => {
    void run().then((result) => {
      setNote(result.ok ? { text: "已保存", bad: false } : { text: result.reason ?? "保存失败", bad: true });
    });
  };

  return (
    <div className="write-frame">
      <PanelBar />
      <Shell
        active={active}
        roots={["writer", "export"]}
        onRoot={(kind) => {
          leave();
          setActive({ kind });
        }}
        desk={desk}
        titleOf={(item) =>
          (writing.openId === item.id ? writing.title : writing.drafts.find((one) => one.id === item.id)?.title) ??
          "（这篇文章没了）"
        }
        onPick={(item) => {
          if (item.id === writing.openId) {
            setActive({ kind: "draft", id: item.id });
            return;
          }
          leave();
          void openDraft(item.id);
        }}
        onClose={(item) => {
          leave();
          const next = closeOnDesk(desk, item.kind, item.id, active);
          setDesk(next.desk);
          setActive(next.active);
          if (next.active.kind === "draft" && next.active.id !== writing.openId) void openDraft(next.active.id);
        }}
        onSettings={() => {
          leave();
          setActive(openSettings(active));
        }}
      >
        {error !== null && <pre className="err">{error}</pre>}
        {active.kind === "settings" ? (
          <div className="settings">
            <header className="settings-bar">
              <h1>设置</h1>
              <p className="muted grow">
                改动立刻保存，下次打开还在。
                {note && <b className={note.bad ? "err" : undefined}> {note.text}</b>}
              </p>
            </header>
            {/* 只有一栏：没有子页可切，左边那列不画（`.settings-body.solo`）。 */}
            <div className="settings-body solo">
              <main className="settings-main">
                <Endpoints config={config} settings={settings} save={save} capabilities={["writing"]} localEngine={false} />
              </main>
            </div>
          </div>
        ) : active.kind === "export" ? (
          <PublishPage blog={blog} publishing={publishing} />
        ) : isWriting(active, writing.openId) ? (
          <DraftPage
            writer={writer}
            talk={talk}
            progress={progress}
            contexts={contexts}
            onUploadImage={(file) => blog.uploadImage(file)}
            // 这里没有知识库，每段要出处的纪律不成立（`checks.ts`）。
            provenance={false}
            onBack={() => {
              leave();
              setActive({ kind: "writer" });
            }}
          />
        ) : (
          <WriterPage writer={writer} blog={blog} onOpen={(id) => void openDraft(id)} />
        )}
      </Shell>
    </div>
  );
}

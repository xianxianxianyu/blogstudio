import { newDraft, summarize, titleOf, type Draft, type DraftStore, type DraftSummary } from "./draft";
import { markAuthored } from "./claims";
import { slugOf, slugProblem } from "./publish/slug";

/**
 * 写这一屏的应用层（同 ADR-0013：规则、顺序、落盘都不在视图里）。
 *
 * 视图只是它的投影，外加一个**非受控**的编辑器——ProseMirror 那一类编辑器自己就是
 * 文本的持有者，再让 React 每次按键把值灌回去，光标会当场跳走。所以这里的约定是反的：
 * 编辑器把文本报上来（`edit`），这一层负责什么时候写盘。
 */

export interface WritingState {
  drafts: DraftSummary[];
  /** 正在写哪一篇。正文**不在这里**，见 `text()`。 */
  openId: string | null;
  /** 当前这篇的名字（正文第一行派生）。案头和顶栏都用它。 */
  title: string;
  status: "saved" | "dirty" | "saving";
  /**
   * 正文被**从外面**整个换掉了几次（取回旧版、打出处记号）。
   *
   * 编辑器是非受控的，只在挂载时读一次正文，所以外面换文本必须让它整段重建——视图把
   * 这个数字编进 `key` 里。**日常打字不动它**：那条路上文本是编辑器自己在改，重建会把
   * 光标和输入法一起打断。
   */
  epoch: number;
  /** 上一次落盘失败的原因。写字的人必须看得见——以为存了其实没存是最坏的一种。 */
  error: string | null;
}

export interface Writer {
  readonly state: WritingState;
  subscribe(listener: () => void): () => void;
  /** 当前正文。**每次现取**——它按键就变，不该走 state 那条路（见下面的注释）。 */
  text(): string;
  refresh(): Promise<void>;
  /** 新起一篇，返回它的 id。 */
  /**
   * 新起一篇。给了标题就按标题起地址（`slugOf`），文章从此就叫这个名；不给就是 uuid
   * ——那是桌面版早先的形态，留着只为兼容，**网页上一律要标题**。
   *
   * 地址撞了就拒绝：文件名就是 id，覆盖等于把另一篇悄悄抹掉。
   */
  create(title?: string): Promise<string>;
  open(id: string): Promise<void>;
  /** 编辑器报上来的新正文。落盘防抖，不是每一键都写。 */
  edit(markdown: string): void;
  /** 立刻落盘。切走、关窗、删除之前都要先来这一下。 */
  flush(): Promise<void>;
  remove(id: string): Promise<void>;
  /** 把某一段标成「我自己的观点」（§1.5 的那个逃生口）。 */
  markAuthored(line: number): void;
}

/** 停手多久算「写完一段了」。太短就是每个字都写盘，太长则一次崩溃丢掉的东西太多。 */
const SETTLE = 800;

export function createWriter(deps: {
  store: DraftStore;
  newId: () => string;
  now: () => number;
  /** 防抖间隔，测试里调成 0。 */
  settle?: number;
}): Writer {
  const settle = deps.settle ?? SETTLE;

  let drafts: DraftSummary[] = [];
  let open: Draft | null = null;
  /**
   * 当前正文。**它不进 state**：按一个键就变一次，而 state 每变一次所有订阅者都要重渲染
   * ——右边那栏跟着一起重渲染是白费的。人看得见的东西（名字、存没存住）才进 state。
   */
  let text = "";
  let status: WritingState["status"] = "saved";
  let epoch = 0;
  let error: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 正在写盘的那一次。`flush` 要等它，否则会有两次写同时落在同一个文件上。 */
  let writing: Promise<void> = Promise.resolve();

  let published: WritingState = { drafts, openId: null, title: "", status, epoch, error };
  const listeners = new Set<() => void>();

  function publish(): void {
    // 引用要稳：useSyncExternalStore 拿它做相等性判断（同 Workspace / Conversation）。
    published = {
      drafts,
      openId: open?.id ?? null,
      title: open ? titleOf(text) : "",
      status,
      epoch,
      error,
    };
    for (const listener of listeners) listener();
  }

  async function write(): Promise<void> {
    if (!open || status === "saved") return;
    const draft: Draft = { ...open, markdown: text, updatedAt: deps.now() };
    status = "saving";
    publish();
    try {
      await deps.store.save(draft);
      open = draft;
      // 列表里那一行跟着更新：改完标题回到稿子架，看到的还是旧名字会让人以为没存住。
      const one = summarize(draft);
      drafts = [one, ...drafts.filter((other) => other.id !== draft.id)];
      // 写盘期间又打了字的话，`text` 已经跑在前面了——那就还是脏的，等下一拍。
      status = text === draft.markdown ? "saved" : "dirty";
      error = null;
    } catch (cause) {
      status = "dirty";
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      publish();
    }
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writing = write();
    }, settle);
  }

  /**
   * 从外面整个换掉正文（打记号）。
   *
   * **bump `epoch`**：编辑器是非受控的，不重建就看不到新文本，而且不会有任何报错——
   * 人会看到自己点了「这是我自己的观点」而屏幕纹丝不动。日常打字走的是 `edit`，不走这里。
   */
  function rewrite(markdown: string): void {
    if (!open) return;
    text = markdown;
    epoch += 1;
    if (status !== "saving") status = "dirty";
    schedule();
    publish();
  }

  /**
   * 立刻落盘。**独立的函数而不是 `this.flush()`**：这个对象会被解构着用（视图里到处是
   * `const { flush } = writer` 这种写法），绑在 `this` 上的方法一解构就散架，而且要到
   * 运行时才炸。
   */
  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await writing;
    await write();
  }

  return {
    get state() {
      return published;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    text: () => text,

    async refresh(): Promise<void> {
      drafts = await deps.store.list();
      publish();
    },

    async create(title?: string): Promise<string> {
      const named = title?.trim() || undefined;
      const id = named === undefined ? deps.newId() : slugOf(named);
      if (named !== undefined) {
        const bad = slugProblem(id);
        if (bad !== null) throw new Error(`「${named}」起不出地址：${bad}`);
        if (drafts.some((one) => one.id === id)) throw new Error(`已经有一篇在 /${id} 了，换个标题`);
      }
      // 新的一篇先落盘再打开：不落的话它只活在内存里，人以为「新建了一篇」，
      // 关掉窗口就没了，而且不会有任何报错。
      await flush();
      const draft = newDraft(id, deps.now(), named);
      await deps.store.save(draft);
      drafts = [summarize(draft), ...drafts];
      open = draft;
      text = draft.markdown;
      status = "saved";
      error = null;
      publish();
      return draft.id;
    },

    async open(id: string): Promise<void> {
      if (open?.id === id) return;
      // 换一篇之前先把手上这篇存住。丢的是别人刚写的字，不能靠「多半来得及」。
      await flush();
      const draft = await deps.store.load(id);
      if (!draft) throw new Error("这篇稿子不在了");
      open = draft;
      text = draft.markdown;
      status = "saved";
      error = null;
      publish();
    },

    edit(markdown: string): void {
      if (!open || markdown === text) return;
      const was = published.title;
      text = markdown;
      if (status !== "saving") status = "dirty";
      schedule();
      // 名字变了或刚变脏才通知：每个字都通知一遍，右边那栏会跟着白重渲染一遍。
      if (was !== titleOf(markdown) || published.status !== status) publish();
    },

    flush,

    markAuthored(line: number): void {
      if (!open) return;
      const next = markAuthored(text, line);
      // 没变化就别重建编辑器：这个按钮是可以重复点的（同一条报告点两下很常见）。
      if (next !== text) rewrite(next);
    },

    async remove(id: string): Promise<void> {
      if (open?.id === id) {
        // 正开着的那篇被删了：先把防抖里那一拍取消掉，否则它会把刚删掉的文件写回来。
        if (timer !== null) clearTimeout(timer);
        timer = null;
        await writing;
        open = null;
        text = "";
        status = "saved";
      }
      await deps.store.remove(id);
      drafts = drafts.filter((one) => one.id !== id);
      publish();
    },
  };
}

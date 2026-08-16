import { captureClip } from "../clip/capture-clip";
import { collect } from "../clip/retention";
import { can, reduce } from "../clip/clip";
import type { Action, Clip, ClipsState } from "../clip/clip";
import type { Bookshelf, Doc } from "../bookshelf/bookshelf";
import type { ClipStore } from "../clip/clip-store";
import type { Recognizer, Region } from "../recognizer/recognizer";
import type { Chat } from "../chat/chat";
import type { RetentionConfig } from "../config/config";

/**
 * 应用层：拥有「当前是哪本书、它有哪些摘录、什么时候落盘」，视图只调它（ADR-0013）。
 *
 * 它不碰 DOM，也不认识 pdf.js——渲染句柄归视图，`openDocument` 回调把接好依赖的
 * `Recognizer` 交回来。所以这一层能在 Node 里测，而这正是它存在的理由：这条竖切
 * 暴露的 7 个 bug 有 6 个出在这类接线上，而接线错误**对单元测试免疫**
 * （单元测试测的是「给了依赖会不会用」，不是「有没有给」）。
 */
export interface WorkspaceDeps {
  shelf: Bookshelf;
  store: ClipStore;
  /**
   * 视图在这里建 pdf.js 文档，交回依赖都接好了的 `Recognizer` 与 `Chat`。
   *
   * `clips` 是这本书的摘录访问器，由 Workspace 传进来：Chat 要把摘录放进检索池，
   * 而摘录是 Workspace 的状态。传函数不是数组——传数组会把建索引那一刻的快照钉死，
   * 新框的摘录永远检索不到，且不报错。
   */
  openDocument(
    bytes: Uint8Array,
    doc: Doc,
    clips: () => Clip[],
  ): Promise<{ recognizer: Recognizer; chat: Chat }>;
  newId(): string;
  now(): number;
  /**
   * 回收策略（ADR-0012）。省略表示不回收——**默认不删东西**，要删得显式说。
   *
   * 是函数不是对象：读者随时可能在设置里改天数或确认告知，传对象会把启动那一刻的
   * 快照钉死，改完不生效且不报错。
   */
  retention?: () => RetentionConfig;
}

export interface WorkspaceState {
  docs: Doc[];
  docId: string | null;
  clips: Clip[];
}

/** 统一的返回形状：拒绝有理由（给读者看），失败有错误（给排查看）。 */
export interface Result {
  ok: boolean;
  reason?: string;
  error?: unknown;
  /** `capture` 回报它建出或合并进的那条。重试同一区域是合并，取「最后一条」会指错人。 */
  clipId?: string;
}

const OK: Result = { ok: true };

export interface Workspace {
  /**
   * 当前文档的问答。换书就换一个，没开文档时是 null——`CONTEXT.md` 说 chat
   * 「绝不跨 PDF」，而共用一个实例正是跨过去的方式。
   */
  readonly chat: Chat | null;
  /**
   * 当前快照。**没变化时是同一个引用**——React 的 `useSyncExternalStore` 拿它做
   * 相等性判断，每次新建对象会被当成「状态一直在变」，直接无限重渲染。
   */
  readonly state: WorkspaceState;
  /** 订阅变化，返回退订函数。 */
  subscribe(listener: () => void): () => void;
  /** 只刷新书架列表，不打开任何一本——开机时先让读者看见有哪些书。 */
  refresh(): Promise<void>;
  importDoc(file: { filename: string; bytes: Uint8Array }): Promise<Doc>;
  openDoc(docId: string): Promise<void>;
  removeDoc(docId: string): Promise<void>;
  capture(region: Region): Promise<Result>;
  viewClip(clipId: string): Promise<Result>;
  markImportant(clipId: string): Promise<Result>;
  editNote(clipId: string, text: string): Promise<Result>;
  fixSource(clipId: string, text: string): Promise<Result>;
  editTranslation(clipId: string, text: string): Promise<Result>;
  removeClip(clipId: string): Promise<Result>;
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  let docs: Doc[] = [];
  let docId: string | null = null;
  let recognizer: Recognizer | null = null;
  let chat: Chat | null = null;
  let clips: ClipsState = { clips: [], contexts: [] };

  let snapshot: WorkspaceState = { docs, docId, clips: clips.clips };
  const listeners = new Set<() => void>();

  /** 每个改状态的地方都要调它——漏掉一处，界面就会停在旧数据上而不报错。 */
  function publish(): void {
    snapshot = { docs, docId, clips: clips.clips };
    for (const listener of listeners) listener();
  }

  const requireDoc = (): string => {
    if (docId === null) throw new Error("还没有打开任何文档。");
    return docId;
  };

  /**
   * 先落盘、再改内存。**顺序不能反**（ADR-0011：文件是唯一真相）——反过来的话写盘
   * 失败就成了「界面说改了、磁盘上没改」，刷新一次改动凭空消失，而读者已经走了。
   */
  async function commit(action: Action, clipId: string): Promise<Result> {
    const verdict = can(clips, action);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const next = reduce(clips, action);
    const clip = next.clips.find((candidate) => candidate.id === clipId);
    try {
      if (clip) await deps.store.save(requireDoc(), clip);
    } catch (error) {
      return { ok: false, reason: "保存失败", error };
    }
    clips = next;
    publish();
    return OK;
  }

  return {
    get state(): WorkspaceState {
      return snapshot;
    },

    get chat(): Chat | null {
      return chat;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async refresh(): Promise<void> {
      docs = await deps.shelf.list();
      publish();
    },

    async importDoc({ filename, bytes }): Promise<Doc> {
      const doc = await deps.shelf.import({ filename, bytes, at: deps.now() });
      // 导入完直接打开。同一篇论文再导入一次会拿回同一个 id（内容哈希），于是已有的
      // 摘录原样接上，而不是变成一本空白的新书。
      await this.openDoc(doc.id);
      return doc;
    },

    async openDoc(id: string): Promise<void> {
      const bytes = await deps.shelf.read(id);
      docs = await deps.shelf.list();
      const doc = docs.find((candidate) => candidate.id === id);
      if (!doc) throw new Error("书架上没有这本书。");

      ({ recognizer, chat } = await deps.openDocument(bytes, doc, () => clips.clips));
      docId = id;

      // 打开这本书时顺手回收它到期的摘录（ADR-0012）。
      //
      // **只扫这一本，不在启动时全库扫**：`listByDoc` 会把每条摘录的截图字节全读出来，
      // 为了决定要不要删而先把要删的东西全读一遍，在启动时做就是让应用一开就卡住。
      // 代价写明：**再也没打开过的书永远不会被回收**。
      //
      // 没确认过告知就一条都不动——ADR-0012 代价 1 说首次运行必须显式告知，
      // 而删完再说不叫告知，那时读者的东西已经没了。
      const retention = deps.retention?.();
      if (retention?.acknowledged) {
        await collect({ store: deps.store }, id, deps.now(), retention.ttlDays);
      }

      // **摘录必须跟着换。** 共用一份状态的话，上一本的标签会画到这一本的页面上
      // ——锚点是「页码 + 矩形」，换本书它照样「有效」，只是指着完全不相干的地方，
      // 而且不报任何错。
      // 回收之后才读：先读的话拿到的是内存里还带着内容的旧样子，标签会画成「实的」，
      // 而磁盘上已经是墓碑了。
      clips = { clips: await deps.store.listByDoc(id), contexts: [] };
      publish();
    },

    async removeDoc(id: string): Promise<void> {
      // 删一本书连它的全部摘录一起删——它们就住在同一个文件夹里（ADR-0011 的形状）。
      await deps.shelf.remove(id);
      docs = await deps.shelf.list();
      if (docId !== id) {
        publish();
        return;
      }
      // 当前这本被删了就得清干净，否则视图会拿着一个指向空气的 docId 继续画标签。
      docId = null;
      recognizer = null;
      chat = null;
      clips = { clips: [], contexts: [] };
      publish();
    },

    async capture(region: Region): Promise<Result> {
      if (!recognizer) return { ok: false, reason: "还没有打开任何文档。" };

      const outcome = await captureClip(
        { recognizer, store: deps.store, newId: deps.newId, now: deps.now },
        clips,
        requireDoc(),
        region,
      );
      // 失败时也要收下 state：里面那条摘录已经退回可重试，丢掉它读者就得重新框。
      clips = outcome.state;
      publish();
      return outcome.ok
        ? { ok: true, clipId: outcome.clipId }
        : { ok: false, reason: "识别失败", error: outcome.error, clipId: outcome.clipId };
    },

    viewClip(clipId: string): Promise<Result> {
      // 看过一次就重新计时（ADR-0012）。代价是读操作也要写盘，ADR 里记了这笔账。
      return commit({ type: "view", id: clipId, at: deps.now() }, clipId);
    },

    markImportant(clipId: string): Promise<Result> {
      return commit({ type: "toggle-important", id: clipId }, clipId);
    },

    editNote(clipId: string, text: string): Promise<Result> {
      return commit({ type: "add-note", id: clipId, text }, clipId);
    },

    fixSource(clipId: string, text: string): Promise<Result> {
      return commit({ type: "fix-source", id: clipId, text }, clipId);
    },

    editTranslation(clipId: string, text: string): Promise<Result> {
      return commit({ type: "edit-translation", id: clipId, text }, clipId);
    },

    async removeClip(clipId: string): Promise<Result> {
      // 同样先落盘再改内存：反过来的话删盘失败，界面上标签没了、文件还在，
      // 刷新一次它又冒出来——而读者以为已经删掉了。
      try {
        await deps.store.delete(requireDoc(), clipId);
      } catch (error) {
        return { ok: false, reason: "删除失败", error };
      }
      clips = reduce(clips, { type: "delete", id: clipId });
      publish();
      return OK;
    },
  };
}

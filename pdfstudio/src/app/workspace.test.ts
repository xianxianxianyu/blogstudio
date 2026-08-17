import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspace } from "./workspace";
import { createBookshelf } from "../bookshelf/bookshelf";
import { createClipStore } from "../clip/clip-store";
import { createTagStore } from "../tag/tag-store";
import { RecognizeError } from "../recognizer/recognizer";
import type { ClipStore } from "../clip/clip-store";
import type { Chat } from "../chat/chat";
import type { ClipContent, Recognizer, Region, Screenshot } from "../recognizer/recognizer";

const PAPER_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01]);
const PAPER_B = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x02]);

const PIXELS: Screenshot = { mime: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 30, height: 40 };

const region = (page = 1, x = 140): Region => ({
  page,
  rect: { x, y: 303, width: 332, height: 78 },
  pixels: PIXELS,
});

const CONTENT: ClipContent = {
  route: "text",
  anchor: { page: 1, rect: region().rect },
  sourceText: "The dominant sequence transduction models",
  translation: "主流的序列转导模型",
  images: [],
  screenshot: PIXELS,
};

const NOW = 1_700_000_000_000;

const fakeChat = (): Chat => ({
  ask: async () => ({ text: "", citations: [], grounding: "none" as const }),
  reindex: async () => undefined,
});

const recognizerReturning = (content: ClipContent): Recognizer => ({ recognize: async () => content });
const recognizerThrowing = (error: unknown): Recognizer => ({
  recognize: async () => {
    throw error;
  },
});

/** 真书架 + 真 ClipStore 跑在临时目录上：这一层要验的正是落盘顺序，fake 掉就没意义了。 */
async function workspace(recognizer: Recognizer = recognizerReturning(CONTENT), store?: ClipStore) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-"));
  let n = 0;
  return {
    root,
    ws: createWorkspace({
      shelf: createBookshelf(root),
      store: store ?? createClipStore(root),
      tags: createTagStore(root),
      // 视图那侧在这里建 pdf.js 文档并接好 Recognizer 的依赖；Workspace 不认识 pdf.js。
      openDocument: async () => ({ recognizer, chat: fakeChat() }),
      newId: () => `c${++n}`,
      now: () => NOW,
    }),
  };
}

describe("Workspace — 标签（颜色即分类）", () => {
  it("设了标签之后，下一条新摘录默认带同一个颜色", async () => {
    // 连续划同一类时一次都不用点——主路径仍是零点击。
    const { ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    const first = await ws.capture(region());

    await ws.setTag(first.clipId!, "pink");
    await ws.capture(region(1, 10));

    expect(ws.state.clips.map((clip) => clip.tagId)).toEqual(["pink", "pink"]);
  });

  it("清掉标签不会把「上次用的颜色」也清掉", async () => {
    // 清掉是「这条不属于任何一类」，不是「我不想再用这个颜色了」。
    const { ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    const first = await ws.capture(region());
    await ws.setTag(first.clipId!, "blue");

    await ws.setTag(first.clipId!, null);
    await ws.capture(region(1, 10));

    expect(ws.state.clips.find((clip) => clip.id !== first.clipId)!.tagId).toBe("blue");
  });

  it("改名落盘，重开还在，而摘录文件没被动过", async () => {
    const { root, ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    const captured = await ws.capture(region());
    await ws.setTag(captured.clipId!, "green");
    const clipFile = path.join(root, ws.state.docId!, "clips", captured.clipId!, "index.md");
    const before = await readFile(clipFile, "utf8");

    await ws.renameTag("green", "读懂了没");

    // 摘录只存 id，所以改名不该重写它——这正是那个存储决定要换来的东西。
    expect(await readFile(clipFile, "utf8")).toBe(before);
    const reopened = createWorkspace({
      shelf: createBookshelf(root),
      store: createClipStore(root),
      tags: createTagStore(root),
      openDocument: async () => ({ recognizer: recognizerReturning(CONTENT), chat: fakeChat() }),
      newId: () => "fresh",
      now: () => NOW,
    });
    await reopened.refresh();
    expect(reopened.state.tags.find((tag) => tag.id === "green")!.name).toBe("读懂了没");
  });

  it("没接标签存储时也能跑，只是改名不落盘", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-"));
    const bare = createWorkspace({
      shelf: createBookshelf(root),
      store: createClipStore(root),
      openDocument: async () => ({ recognizer: recognizerReturning(CONTENT), chat: fakeChat() }),
      newId: () => "c1",
      now: () => NOW,
    });

    await bare.refresh();

    expect(bare.state.tags).toHaveLength(5);
  });
});

describe("Workspace — 书架", () => {
  it("导入后自动打开，书架列表跟着更新", async () => {
    const { ws } = await workspace();

    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });

    expect(ws.state.docs.map((doc) => doc.title)).toEqual(["a"]);
    expect(ws.state.docId).toBe(ws.state.docs[0].id);
  });

  it("refresh 只上架、不打开", async () => {
    // 开机时先让读者看见有哪些书，但别替他决定看哪本。
    const { root, ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });

    const fresh = createSecond(root);
    await fresh.refresh();

    expect(fresh.state.docs).toHaveLength(1);
    expect(fresh.state.docId).toBeNull();
  });

  it("换书时摘录跟着换", async () => {
    // **不换的话不会报任何错，只会看到一堆位置诡异的标签。** 锚点是「页码 + 矩形」，
    // 换本书它照样「有效」，只是指着完全不相干的地方。
    const { ws } = await workspace();
    const a = await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    await ws.capture(region());
    expect(ws.state.clips).toHaveLength(1);

    const b = await ws.importDoc({ filename: "b.pdf", bytes: PAPER_B });
    expect(ws.state.clips).toEqual([]);

    await ws.openDoc(a.id);
    expect(ws.state.clips).toHaveLength(1);
    expect(b.id).not.toBe(a.id);
  });

  it("打开一本书就把它的摘录从磁盘读回来", async () => {
    // 不读的话：id 计数器从头开始会覆盖旧文件，按区域合并也查不到已有摘录
    // ——两个后果都真实发生过。文件是唯一真相（ADR-0011），那就得真的把它当真相读。
    const { root, ws } = await workspace();
    const doc = await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    await ws.capture(region());

    const { ws: reopened } = { ws: createSecond(root) };
    await reopened.openDoc(doc.id);

    expect(reopened.state.clips.map((clip) => clip.sourceText)).toEqual([CONTENT.sourceText]);
  });

  function createSecond(root: string) {
    return createWorkspace({
      shelf: createBookshelf(root),
      store: createClipStore(root),
      openDocument: async () => ({ recognizer: recognizerReturning(CONTENT), chat: fakeChat() }),
      newId: () => "fresh",
      now: () => NOW,
    });
  }

  it("同一篇论文再导入一次，已有摘录原样接上", async () => {
    const { ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    await ws.capture(region());

    await ws.importDoc({ filename: "改了个名.pdf", bytes: PAPER_A });

    expect(ws.state.docs).toHaveLength(1);
    expect(ws.state.clips).toHaveLength(1);
  });

  it("删掉当前这本书，界面上不留悬空的当前文档", async () => {
    const { ws } = await workspace();
    const doc = await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });

    await ws.removeDoc(doc.id);

    expect(ws.state.docId).toBeNull();
    expect(ws.state.clips).toEqual([]);
    expect(ws.state.docs).toEqual([]);
  });
});

describe("Workspace — 摘录", () => {
  it("识别失败：状态可重试，磁盘上不留半条", async () => {
    const { root, ws } = await workspace(
      recognizerThrowing(new RecognizeError("model-unavailable", "模型调用失败")),
    );
    const doc = await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });

    const result = await ws.capture(region());

    expect(result.ok).toBe(false);
    expect(ws.state.clips[0].state).toBe("capturing");
    expect(await readdir(path.join(root, doc.id, "clips")).catch(() => [])).toEqual([]);
  });

  it("被守卫拒绝时把理由带出来", async () => {
    // 默默什么都没发生是最坏的结果：读者以为保存失败，实际是规则不允许。
    // 「原文只准修错字，不得改写措辞」这句话本身就是规则。
    const { ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    await ws.capture(region());
    const id = ws.state.clips[0].id;

    const result = await ws.fixSource(id, "完全换一段话，这不是修错字");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("改写");
  });

  it("删除先落盘再改内存", async () => {
    // 反过来的话删盘失败，界面上标签没了、文件还在，刷新一次它又冒出来
    // ——而读者以为已经删掉了。
    const { ws } = await workspace(recognizerReturning(CONTENT), {
      ...createClipStore(await mkdtemp(path.join(tmpdir(), "unused-"))),
      delete: async () => {
        throw new Error("磁盘满了");
      },
    });
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    await ws.capture(region());
    const id = ws.state.clips[0].id;

    const result = await ws.removeClip(id);

    expect(result.ok).toBe(false);
    expect(ws.state.clips.map((clip) => clip.id)).toEqual([id]);
  });

  it("改动落盘后再读回来还在", async () => {
    const { root, ws } = await workspace();
    const doc = await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    await ws.capture(region());
    const id = ws.state.clips[0].id;

    await ws.editNote(id, "这段是全文的论点起点");
    await ws.markImportant(id);

    const back = await createClipStore(root).listByDoc(doc.id);
    expect(back[0].note).toBe("这段是全文的论点起点");
    expect(back[0].important).toBe(true);
  });
});

describe("Workspace — 订阅", () => {
  it("没变化时 state 是同一个引用", async () => {
    // React 的 useSyncExternalStore 拿 getSnapshot 的返回值做相等性判断。
    // 每次都新建对象的话，它会认为「状态一直在变」而无限重渲染。
    const { ws } = await workspace();
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });

    expect(ws.state).toBe(ws.state);
  });

  it("变化后换一个新引用，并通知订阅者", async () => {
    const { ws } = await workspace();
    const seen: number[] = [];
    ws.subscribe(() => seen.push(ws.state.clips.length));

    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    const before = ws.state;
    await ws.capture(region());

    expect(ws.state).not.toBe(before);
    expect(seen.at(-1)).toBe(1);
  });

  it("退订之后不再收到通知", async () => {
    const { ws } = await workspace();
    let count = 0;
    const off = ws.subscribe(() => count++);
    await ws.importDoc({ filename: "a.pdf", bytes: PAPER_A });
    const afterImport = count;

    off();
    await ws.capture(region());

    expect(count).toBe(afterImport);
  });
});

describe("Workspace — 打开一本书时回收（ADR-0012）", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** 一条到期很久、没标重要、没写笔记的摘录——正是该被回收的那种。 */
  async function withExpiredClip(retention: { ttlDays: number; acknowledged: boolean }) {
    const root = await mkdtemp(path.join(tmpdir(), "gc-"));
    const store = createClipStore(root);
    const ws = createWorkspace({
      shelf: createBookshelf(root),
      store,
      openDocument: async () => ({ recognizer: recognizerReturning(CONTENT), chat: fakeChat() }),
      newId: () => "c1",
      // 时钟停在 30 天后：默认 7 天保留期早就过了。
      now: () => NOW + 30 * DAY,
      retention: () => retention,
    });
    const shelf = createBookshelf(root);
    const doc = await shelf.import({ filename: "a.pdf", bytes: PAPER_A, at: NOW });
    await store.save(doc.id, {
      id: "old",
      state: "ready",
      region: region(),
      content: CONTENT,
      sourceText: CONTENT.sourceText,
      translation: null,
      note: null,
      label: "dot",
      important: false,
    tagId: null,
    title: null,
      lastViewedAt: NOW,
    });
    return { ws, store, docId: doc.id };
  }

  it("到期的摘录在打开这本书时衰减成墓碑，锚点还在", async () => {
    const { ws, docId } = await withExpiredClip({ ttlDays: 7, acknowledged: true });

    await ws.openDoc(docId);

    const [clip] = ws.state.clips;
    expect(clip.content).toBeNull();
    // 痕迹是永久的：标签还画得出来，点一下可以按锚点重新识别。
    expect(clip.region.rect).toEqual(region().rect);
  });

  it("**没确认过告知就一条都不回收**，哪怕早就到期", async () => {
    // ADR-0012 代价 1：自动删除不可逆，首次运行必须显式告知。删完再说不叫告知
    // ——那时读者的东西已经没了。
    const { ws, docId } = await withExpiredClip({ ttlDays: 7, acknowledged: false });

    await ws.openDoc(docId);

    expect(ws.state.clips[0].content).not.toBeNull();
  });

  it("保留期调长了就不该回收", async () => {
    const { ws, docId } = await withExpiredClip({ ttlDays: 90, acknowledged: true });

    await ws.openDoc(docId);

    expect(ws.state.clips[0].content).not.toBeNull();
  });

  it("回收后读回来的是磁盘上的样子，不是内存里改过的", async () => {
    // 内存说衰减了、磁盘上还留着字节，等于没省下任何东西——而省存储正是这件事的
    // 全部目的。
    const { ws, store, docId } = await withExpiredClip({ ttlDays: 7, acknowledged: true });

    await ws.openDoc(docId);

    expect((await store.listByDoc(docId))[0].content).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect, isCollectable } from "./retention";
import { createClipStore } from "./clip-store";
import { reduce } from "./clip";
import type { Clip, ClipsState } from "./clip";
import type { ClipContent, Region, Screenshot } from "../recognizer/recognizer";

const PIXELS: Screenshot = { mime: "image/png", bytes: new Uint8Array([1]), width: 10, height: 10 };
const REGION: Region = { page: 1, rect: { x: 1, y: 2, width: 30, height: 40 }, pixels: PIXELS };
const EMPTY: ClipsState = { clips: [], contexts: [] };

const DAY = 24 * 60 * 60 * 1000;
const CAPTURED_AT = 1_700_000_000_000;
const TTL_DAYS = 7;

const content = (sourceText: string | null): ClipContent => ({
  route: sourceText === null ? "vision" : "text",
  anchor: { page: REGION.page, rect: REGION.rect },
  sourceText,
  images: [],
  screenshot: PIXELS,
});

/** 走到 ready 的摘录。sourceText 为 null 就是纯图。 */
function ready(sourceText: string | null = "Attention is all you need"): Clip {
  return [
    { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT } as const,
    { type: "recognize", id: "c1" } as const,
    { type: "recognized", id: "c1", content: content(sourceText) } as const,
  ].reduce(reduce, EMPTY).clips[0];
}

const later = (days: number) => CAPTURED_AT + days * DAY;

describe("回收判定（ADR-0012）", () => {
  it("过了保留期的随手摘录可以回收", () => {
    expect(isCollectable(ready(), later(8), TTL_DAYS)).toBe(true);
  });

  it("还没到期的不回收", () => {
    expect(isCollectable(ready(), later(6), TTL_DAYS)).toBe(false);
  });

  it("标记为重要的永不回收", () => {
    const clip = { ...ready(), important: true };

    expect(isCollectable(clip, later(9999), TTL_DAYS)).toBe(false);
  });

  it("已入库的永不回收，哪怕没标重要", () => {
    // 它的 Context 已经发布进共享知识库（docs/adr/0001），删掉 evidence 会让
    // Blog Studio 那侧挂空。这是跨产品的硬约束，不是可调的本地策略。
    // **注意这与读者主动删除不同**：主动删会把 context 标记成 sourceClipDeleted，
    // 那是读者的选择；回收器没有替读者做这个选择的资格。
    const promoted = reduce({ clips: [ready()], contexts: [] }, {
      type: "promote",
      id: "c1",
      contextId: "ctx-1",
    }).clips[0];

    expect(promoted.state).toBe("promoted");
    expect(promoted.important).toBe(false);
    expect(isCollectable(promoted, later(9999), TTL_DAYS)).toBe(false);
  });

  it("写过笔记的永不回收", () => {
    // 原文、译文、截图到期后都能按锚点重新识别一次拿回来，**笔记不能**——它是读者
    // 自己写的，删了就永远没了。不自动删除无法再生的用户内容。
    const noted = reduce({ clips: [ready()], contexts: [] }, {
      type: "add-note",
      id: "c1",
      text: "这段是全文的论点起点",
    }).clips[0];

    expect(isCollectable(noted, later(9999), TTL_DAYS)).toBe(false);
  });

  it("已经是墓碑的不再回收", () => {
    // 否则每跑一次回收器都要重写一遍同样的文件——白白搅动磁盘，
    // 还会把 mtime 刷新成「刚动过」，让人误以为摘录还活着。
    const tombstone = reduce({ clips: [ready()], contexts: [] }, {
      type: "decay",
      id: "c1",
    }).clips[0];

    expect(isCollectable(tombstone, later(9999), TTL_DAYS)).toBe(false);
  });

  it("看过一次就重新计时", () => {
    // 第 30 天点开了它，说明它还活着，钟该重置（ADR-0012）。
    const viewed = reduce({ clips: [ready()], contexts: [] }, {
      type: "view",
      id: "c1",
      at: later(30),
    }).clips[0];

    expect(isCollectable(viewed, later(35), TTL_DAYS)).toBe(false);
    expect(isCollectable(viewed, later(38), TTL_DAYS)).toBe(true);
  });

  it("还没识别完的不回收", () => {
    // 正在识别的摘录 content 本来就是 null，长得和墓碑一样。按到期与否判会把
    // 读者刚框下的东西当垃圾清掉。
    const capturing = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });

    expect(isCollectable(capturing.clips[0], later(9999), TTL_DAYS)).toBe(false);
  });
});

describe("衰减成墓碑", () => {
  it("内容没了，锚点还在", () => {
    // 痕迹是永久的，内容是会过期的。锚点没了标签就画不出来，而标签的独特价值
    // 恰恰全在这些随手划过的摘录上——「这儿我来过」。
    const tombstone = reduce({ clips: [ready()], contexts: [] }, { type: "decay", id: "c1" }).clips[0];

    expect(tombstone.region.page).toBe(REGION.page);
    expect(tombstone.region.rect).toEqual(REGION.rect);
    expect(tombstone.content).toBeNull();
    expect(tombstone.sourceText).toBeNull();
    expect(tombstone.translation).toBeNull();
  });

  it("重要的、已入库的、写过笔记的都衰减不动", () => {
    // 判定归 isCollectable，但 reducer 自己也得拦住——回收器之外还有别的调用方，
    // 守卫漏在编排层就等于没有。
    for (const clip of [
      { ...ready(), important: true },
      reduce({ clips: [ready()], contexts: [] }, { type: "promote", id: "c1", contextId: "x" }).clips[0],
      reduce({ clips: [ready()], contexts: [] }, { type: "add-note", id: "c1", text: "笔记" }).clips[0],
    ]) {
      const after = reduce({ clips: [clip], contexts: [] }, { type: "decay", id: "c1" }).clips[0];
      expect(after.content).not.toBeNull();
    }
  });
});

describe("回收器：跑一遍磁盘", () => {
  const store = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "retention-"));
    return { root, store: createClipStore(root) };
  };

  it("到期的衰减成墓碑，该留的原样不动", async () => {
    const { root, store: target } = await store();
    const expired = { ...ready(), id: "expired" };
    await target.save("d1", expired);
    await target.save("d1", { ...expired, id: "kept", important: true });

    const collected = await collect({ store: target }, "d1", later(8));

    expect(collected).toEqual(["expired"]);
    const back = await target.listByDoc("d1");
    expect(back.find((clip) => clip.id === "expired")!.content).toBeNull();
    expect(back.find((clip) => clip.id === "kept")!.content).not.toBeNull();
    // 墓碑的字节真的没了，锚点还在——省下的 99% 就在这儿。
    expect(await readdir(path.join(root, "d1", "clips", "expired", ".asset"))).toEqual([]);
    expect(back.find((clip) => clip.id === "expired")!.region.rect).toEqual(REGION.rect);
  });

  it("不删文件夹，只清内容", async () => {
    // 删掉文件夹标签就没了，而标签正是「这儿我来过」——回收要省的是截图，不是痕迹。
    // 主动删除才删文件夹，那是 store.delete，是另一条路。
    const { root, store: target } = await store();
    await target.save("d1", ready());

    await collect({ store: target }, "d1", later(8));

    expect(await readdir(path.join(root, "d1", "clips"))).toEqual(["c1"]);
  });
});

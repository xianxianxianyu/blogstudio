import { describe, expect, it } from "vitest";
import { can, reduce } from "./clip";
import type { ClipsState } from "./clip";
import type { ClipContent, Region, Screenshot } from "../recognizer/recognizer";

const PIXELS: Screenshot = {
  mime: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  width: 100,
  height: 40,
};

const REGION: Region = {
  page: 1,
  rect: { x: 140, y: 303, width: 332, height: 78 },
  pixels: PIXELS,
};

const EMPTY: ClipsState = { clips: [], contexts: [] };

const textContent = (sourceText: string | null): ClipContent => ({
  route: sourceText === null ? "vision" : "text",
  anchor: { page: REGION.page, rect: REGION.rect },
  sourceText,
  images: [],
  screenshot: PIXELS,
});

/** 走到 ready 的摘录。sourceText 为 null 就是纯图。 */
function readyClip(sourceText: string | null): ClipsState {
  return [
    { type: "capture", id: "c1", region: REGION } as const,
    { type: "recognize", id: "c1" } as const,
    { type: "recognized", id: "c1", content: textContent(sourceText) } as const,
  ].reduce(reduce, EMPTY);
}

describe("Clip reducer — 截图后开始识别", () => {
  it("capture 建出 capturing 的摘录，recognize 让它进 recognizing", () => {
    const captured = reduce(EMPTY, { type: "capture", id: "c1", region: REGION });

    expect(captured.clips).toHaveLength(1);
    expect(captured.clips[0].state).toBe("capturing");

    const recognizing = reduce(captured, { type: "recognize", id: "c1" });

    expect(recognizing.clips[0].state).toBe("recognizing");
  });

  it("recognized 进 ready，原文取自 Recognizer 的 ClipContent", () => {
    const state = readyClip("The dominant sequence transduction models");

    expect(state.clips[0].state).toBe("ready");
    expect(state.clips[0].sourceText).toBe("The dominant sequence transduction models");
    expect(state.clips[0].content?.route).toBe("text");
  });
});

describe("Clip reducer — 原文只准修错字", () => {
  const OCR_TYPO = "The dominant sequence transductlon models";
  const FIXED = "The dominant sequence transduction models";

  it("改一两个字符是修 OCR 错字，放行", () => {
    const state = reduce(readyClip(OCR_TYPO), { type: "fix-source", id: "c1", text: FIXED });

    expect(state.clips[0].sourceText).toBe(FIXED);
  });

  it("改写措辞不是修错字，拒绝", () => {
    const ready = readyClip(FIXED);
    const rewritten = "主流的序列转导模型";

    expect(can(ready, { type: "fix-source", id: "c1", text: rewritten }).ok).toBe(false);
    expect(reduce(ready, { type: "fix-source", id: "c1", text: rewritten }).clips[0].sourceText).toBe(
      FIXED,
    );
  });

  it("入库后原文冻结——它已经是 context 的 evidence", () => {
    const promoted = reduce(readyClip(FIXED), { type: "promote", id: "c1", contextId: "ctx1" });

    expect(can(promoted, { type: "fix-source", id: "c1", text: OCR_TYPO }).ok).toBe(false);
    expect(
      reduce(promoted, { type: "fix-source", id: "c1", text: OCR_TYPO }).clips[0].sourceText,
    ).toBe(FIXED);
  });
});

describe("Clip reducer — 译文与标签", () => {
  it("译文自由编辑，入库后也照样能改——冻结的只有原文", () => {
    const promoted = reduce(readyClip("The dominant sequence transduction models"), {
      type: "promote",
      id: "c1",
      contextId: "ctx1",
    });

    const state = reduce(promoted, { type: "edit-translation", id: "c1", text: "主流的序列转导模型" });

    expect(state.clips[0].translation).toBe("主流的序列转导模型");
    // evidence 是入库那一刻的原文副本，改译文碰不到它。
    expect(state.contexts[0].evidence).toBe("The dominant sequence transduction models");
  });

  it("识别完成前没有译文可改", () => {
    const capturing = reduce(EMPTY, { type: "capture", id: "c1", region: REGION });

    expect(can(capturing, { type: "edit-translation", id: "c1", text: "x" }).ok).toBe(false);
  });

  it("标签在圆点与小窗之间切换", () => {
    const ready = readyClip("The dominant sequence transduction models");

    expect(ready.clips[0].label).toBe("dot");
    expect(reduce(ready, { type: "toggle-label", id: "c1" }).clips[0].label).toBe("panel");
  });
});

describe("Clip reducer — 同一区域重复截图", () => {
  it("合并进已有标签：不新建摘录，回到 recognizing，笔记留下、修错字的改动不留", () => {
    const ready = [
      { type: "fix-source", id: "c1", text: "The dominant sequence transduction model" } as const,
      { type: "add-note", id: "c1", text: "这段是全文的论点起点" } as const,
    ].reduce(reduce, readyClip("The dominant sequence transduction models"));

    const state = reduce(ready, { type: "recapture", id: "c1", region: REGION });

    // 同一区域两个标签会让锚点回跳有歧义，所以合并而非新建。
    expect(state.clips).toHaveLength(1);
    expect(state.clips[0].state).toBe("recognizing");
    // 笔记是读者的，不是 OCR 的，留下；原文换了一张，之前的修错字随之作废。
    expect(state.clips[0].note).toBe("这段是全文的论点起点");
    expect(state.clips[0].sourceText).toBeNull();
  });

  it("已入库的摘录不能重拍——原文已冻结为 evidence", () => {
    const promoted = reduce(readyClip("The dominant sequence transduction models"), {
      type: "promote",
      id: "c1",
      contextId: "ctx1",
    });

    expect(can(promoted, { type: "recapture", id: "c1", region: REGION }).ok).toBe(false);
    expect(reduce(promoted, { type: "recapture", id: "c1", region: REGION }).clips[0].state).toBe(
      "promoted",
    );
  });
});

describe("Clip reducer — 删除已入库的摘录", () => {
  it("摘录删掉，context 留下并标记来源已删", () => {
    const promoted = reduce(readyClip("The dominant sequence transduction models"), {
      type: "promote",
      id: "c1",
      contextId: "ctx1",
    });

    const state = reduce(promoted, { type: "delete", id: "c1" });

    // context 已被 Blog Studio 消费，删摘录不该连坐；但来源没了要如实标出。
    expect(state.clips).toHaveLength(0);
    expect(state.contexts).toHaveLength(1);
    expect(state.contexts[0].sourceClipDeleted).toBe(true);
    expect(state.contexts[0].evidence).toBe("The dominant sequence transduction models");
  });
});

describe("Clip reducer — 入库", () => {
  it("生成 context，evidence 是入库那一刻的原文", () => {
    const ready = readyClip("The dominant sequence transduction models");

    const state = reduce(ready, { type: "promote", id: "c1", contextId: "ctx1" });

    expect(state.clips[0].state).toBe("promoted");
    expect(state.contexts).toHaveLength(1);
    expect(state.contexts[0].evidence).toBe("The dominant sequence transduction models");
    // claim 由 AI 按需补、stance 由读者标，入库时都还没有。
    expect(state.contexts[0].status).toBe("pending");
    expect(state.contexts[0].claim).toBeNull();
    expect(state.contexts[0].stance).toBeNull();
  });

  it("纯图摘录没有原文，入库被禁止", () => {
    const ready = readyClip(null);

    expect(can(ready, { type: "promote", id: "c1", contextId: "ctx1" }).ok).toBe(false);

    const state = reduce(ready, { type: "promote", id: "c1", contextId: "ctx1" });

    // sourceText === null ⟺ 纯图 ⟺ 入库 blocked，判定只看这一个字段。
    expect(state.clips[0].state).toBe("ready");
    expect(state.contexts).toHaveLength(0);
  });
});

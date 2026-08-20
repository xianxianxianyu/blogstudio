import { describe, expect, it } from "vitest";
import { can, clipTitle, reduce } from "./clip";
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

/** 固定时刻：reducer 是纯的，时间由动作带进来，测试才钉得住。 */
const CAPTURED_AT = 1_700_000_000_000;

const textContent = (sourceText: string | null): ClipContent => ({
  route: sourceText === null ? "vision" : "text",
  anchor: { page: REGION.page, rect: REGION.rect },
  sourceText,
  images: [],
  screenshot: PIXELS,
});

/** 出处由调用方给：reducer 不知道书叫什么名字。 */
const SOURCE = { docId: "doc-1", title: "Attention Is All You Need", locator: "第 3 页" };

/** 走到 ready 的摘录。sourceText 为 null 就是纯图。 */
function readyClip(sourceText: string | null): ClipsState {
  return [
    { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT } as const,
    { type: "recognize", id: "c1" } as const,
    { type: "recognized", id: "c1", content: textContent(sourceText) } as const,
  ].reduce(reduce, EMPTY);
}

describe("Clip 目录标题", () => {
  it("没设标题时从内容推导，译文优先", () => {
    const [clip] = readyClip("The dominant sequence transduction models").clips;

    expect(clipTitle({ ...clip, translation: "主流的序列转换模型" })).toBe("主流的序列转换模型");
  });

  it("不在这里按字数截——截断交给 CSS，它按像素断且自带省略号", () => {
    // 按字数截会撞在词中间：实测截出过 `\mathrm{FFN}(x)=\max(0`、`（NIPS`、光秃秃一个
    // `Jakob`。这里只留一个宽松上限，别让整段正文进 DOM。
    const [clip] = readyClip("x").clips;
    const long = { ...clip, translation: "主流的序列转换模型基于复杂的循环或卷积神经网络，其中包括编码器和解码器。" };

    expect(clipTitle(long)).toBe(long.translation);
    expect(clipTitle({ ...clip, translation: "一".repeat(200) })).toHaveLength(60);
  });

  it("开头的标点去掉——摘录常常从半句话开始", () => {
    const [clip] = readyClip("x").clips;

    expect(clipTitle({ ...clip, translation: "。不仅各个注意力头明显学会了执行不同的任务" })).toBe(
      "不仅各个注意力头明显学会了执行不同的任务",
    );
  });

  it("换行和连续空白压成单个空格，一行放得下", () => {
    const [clip] = readyClip("x").clips;

    expect(clipTitle({ ...clip, translation: "第一行\n\n  第二行" })).toBe("第一行 第二行");
  });

  it("读者设的标题优先于推导", () => {
    const [clip] = readyClip("正文").clips;
    const named = reduce({ clips: [clip], contexts: [] }, { type: "set-title", id: clip.id, text: "损失函数的定义" });

    expect(clipTitle(named.clips[0])).toBe("损失函数的定义");
  });

  it("清空标题是退回推导，不是设成空串", () => {
    // 空串会在目录里留下一行没有字的条目——看起来像坏了。
    const [clip] = readyClip("正文").clips;
    const named = reduce({ clips: [clip], contexts: [] }, { type: "set-title", id: clip.id, text: "自定义" });

    const cleared = reduce(named, { type: "set-title", id: clip.id, text: "   " });

    expect(cleared.clips[0].title).toBeNull();
    expect(clipTitle(cleared.clips[0])).toBe("正文");
  });

  it("纯图没有任何文字时给一个说得过去的占位", () => {
    const [clip] = readyClip(null).clips;

    expect(clipTitle(clip)).toBe("（纯图）");
  });
});

describe("Clip reducer — 标签（颜色即分类）", () => {
  it("设上、改成别的、清掉", () => {
    const tagged = reduce(readyClip("正文"), { type: "set-tag", id: "c1", tagId: "pink" });
    expect(tagged.clips[0].tagId).toBe("pink");

    const changed = reduce(tagged, { type: "set-tag", id: "c1", tagId: "blue" });
    expect(changed.clips[0].tagId).toBe("blue");

    const cleared = reduce(changed, { type: "set-tag", id: "c1", tagId: null });
    expect(cleared.clips[0].tagId).toBeNull();
  });

  it("还在识别时就能标——读者是先认出这段算哪一类才划的", () => {
    // 和 toggle-important 同一个理由：不该等模型回答完才准分类。
    const capturing = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });

    expect(can(capturing, { type: "set-tag", id: "c1", tagId: "green" }).ok).toBe(true);
    expect(reduce(capturing, { type: "set-tag", id: "c1", tagId: "green" }).clips[0].tagId).toBe(
      "green",
    );
  });

  it("衰减成墓碑之后标签还在——内容会过期，「这是什么」不会", () => {
    const tagged = reduce(readyClip("正文"), { type: "set-tag", id: "c1", tagId: "purple" });

    const decayed = reduce(tagged, { type: "decay", id: "c1" });

    expect(decayed.clips[0].content).toBeNull();
    expect(decayed.clips[0].tagId).toBe("purple");
  });

  it("新摘录默认没有标签，不强迫读者先选分类", () => {
    const captured = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });

    expect(captured.clips[0].tagId).toBeNull();
  });

  it("截图时可以带上默认标签——连续划同一类时一次都不用点", () => {
    const captured = reduce(EMPTY, {
      type: "capture",
      id: "c1",
      region: REGION,
      at: CAPTURED_AT,
      tagId: "blue",
    });

    expect(captured.clips[0].tagId).toBe("blue");
  });
});

describe("Clip reducer — 截图后开始识别", () => {
  it("capture 建出 capturing 的摘录，recognize 让它进 recognizing", () => {
    const captured = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });

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
    const promoted = reduce(readyClip(FIXED), { type: "promote", id: "c1", contextId: "ctx1", source: SOURCE });

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
      source: SOURCE,
    });

    const state = reduce(promoted, { type: "edit-translation", id: "c1", text: "主流的序列转导模型" });

    expect(state.clips[0].translation).toBe("主流的序列转导模型");
    // evidence 是入库那一刻的原文副本，改译文碰不到它。
    expect(state.contexts[0].evidence).toBe("The dominant sequence transduction models");
  });

  it("识别完成前没有译文可改", () => {
    const capturing = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });

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
      source: SOURCE,
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
      source: SOURCE,
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

    const state = reduce(ready, { type: "promote", id: "c1", contextId: "ctx1", source: SOURCE });

    expect(state.clips[0].state).toBe("promoted");
    expect(state.contexts).toHaveLength(1);
    expect(state.contexts[0].evidence).toBe("The dominant sequence transduction models");
    // claim 由 AI 按需补、stance 由读者标，入库时都还没有。
    expect(state.contexts[0].status).toBe("pending");
    expect(state.contexts[0].claim).toBeNull();
    expect(state.contexts[0].stance).toBeNull();
  });

  it("**纯图也能入库**——出处是底线，逐字引文是加分（ADR-0020）", () => {
    // 此前这里断言的是「纯图入库被禁止」。那条守卫在 ADR-0019 之后变成死路：
    // 松手不再自动识别，图区摘录连原文都还没有，照旧禁止的话新主路径下一条都进不去。
    // 没有 evidence 的 context 仍然可回溯——`Source` 是结构化的，点一下翻回那一页。
    const ready = readyClip(null);

    expect(can(ready, { type: "promote", id: "c1", contextId: "ctx1", source: SOURCE }).ok).toBe(true);

    const state = reduce(ready, { type: "promote", id: "c1", contextId: "ctx1", source: SOURCE });

    expect(state.clips[0].state).toBe("promoted");
    expect(state.contexts[0].evidence).toBe("");
  });

  it("**还没识别的也能入库**——`capturing` 有锚点、有截图，出处是齐的", () => {
    const capturing = {
      clips: [{ ...readyClip("x").clips[0], state: "capturing" as const, sourceText: null, content: null }],
      contexts: [],
    };

    expect(can(capturing, { type: "promote", id: "c1", contextId: "ctx1", source: SOURCE }).ok).toBe(true);
  });
});

describe("Clip reducer — 入库后不能被重新识别打回", () => {
  it("已入库的摘录收到 recognized 时原地不动——原文已是 context 的 evidence", () => {
    const FIXED = "The dominant sequence transduction models";
    const promoted = reduce(readyClip(FIXED), {
      type: "promote",
      id: "c1",
      contextId: "ctx1",
      source: SOURCE,
    });

    expect(can(promoted, { type: "recognized", id: "c1", content: textContent("改写过的原文") }).ok)
      .toBe(false);

    const state = reduce(promoted, {
      type: "recognized",
      id: "c1",
      content: textContent("改写过的原文"),
    });

    // 不变量④「入库即冻结」：绕过 fix-source 的守卫从别的动作把原文改掉，
    // context 的 evidence 就与摘录对不上了。
    expect(state.clips[0].state).toBe("promoted");
    expect(state.clips[0].sourceText).toBe(FIXED);
  });
});

describe("Clip reducer — 对同一区域再次 capture", () => {
  it("合并进已有摘录，不新建第二个——两个标签会让锚点回跳有歧义", () => {
    const first = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });
    const again = reduce(first, { type: "capture", id: "c2", region: REGION, at: CAPTURED_AT });

    expect(again.clips).toHaveLength(1);
    expect(again.clips[0].id).toBe("c1");
  });

  it("框到别处就是另一条摘录", () => {
    const first = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });
    const elsewhere: Region = {
      ...REGION,
      rect: { ...REGION.rect, y: REGION.rect.y + 200 },
    };

    const second = reduce(first, { type: "capture", id: "c2", region: elsewhere, at: CAPTURED_AT });

    expect(second.clips).toHaveLength(2);
  });
});

describe("Clip reducer — 对已入库区域再次 capture", () => {
  it("不能把已入库的摘录打回 capturing——原文已冻结为 evidence", () => {
    const FIXED = "The dominant sequence transduction models";
    const promoted = reduce(readyClip(FIXED), { type: "promote", id: "c1", contextId: "ctx1", source: SOURCE });

    expect(can(promoted, { type: "capture", id: "c2", region: REGION, at: CAPTURED_AT }).ok).toBe(false);

    const state = reduce(promoted, { type: "capture", id: "c2", region: REGION, at: CAPTURED_AT });

    // capture 的合并分支会 patch 到已有 clip 上，绕过了 recapture 那条守卫——
    // 同一个动作换个入口就能把 evidence 清空，而 context 还指着它。
    expect(state.clips[0].state).toBe("promoted");
    expect(state.clips[0].sourceText).toBe(FIXED);
  });
});

describe("保留轴：重要标记（ADR-0012）", () => {
  it("纯图也能标记为重要", () => {
    // **两根轴仍然必须是两根**，只是理由换了。ADR-0020 之后纯图能入库了，所以
    // 「纯图进不了 promoted」这条论据没了；但 `promoted` 说的是「已经交出去了」，
    // 而 ☆ 说的是「别删我」——一条随手划的、没打算入库的架构图照样要留住。
    const state = reduce(readyClip(null), { type: "toggle-important", id: "c1" });
    expect(state.clips[0].important).toBe(true);
  });

  it("刚框出来的摘录默认不重要", () => {
    // 默认重要的话保留轴就白设了：什么都不回收，等于回到「全部永久保留」。
    expect(reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT }).clips[0].important).toBe(false);
  });

  it("识别还没完成也能标记——重要与识别结果无关", () => {
    // 读者是先认出「这块要留」才框的，不该等模型回答完才准标。
    const captured = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: CAPTURED_AT });

    expect(reduce(captured, { type: "toggle-important", id: "c1" }).clips[0].important).toBe(true);
  });

  it("重来一次就取消", () => {
    const once = reduce(readyClip("Attention"), { type: "toggle-important", id: "c1" });

    expect(reduce(once, { type: "toggle-important", id: "c1" }).clips[0].important).toBe(false);
  });

  it("重拍不会把重要标记冲掉", () => {
    // recapture 换的是原文这一侧；「这块要留」是读者的判断，与换了哪张图无关。
    const marked = reduce(readyClip("Attention"), { type: "toggle-important", id: "c1" });
    const again = reduce(marked, { type: "recapture", id: "c1", region: REGION });

    expect(again.clips[0].important).toBe(true);
  });
});

describe("锚定轴：找不找得回去（档 0）", () => {
  /**
   * **第三根轴。** 与 `state`（发布：capturing→ready→promoted）和 `important`（保留）
   * 正交，回答的是「这条摘录还找不找得回原处」。
   *
   * PDF 上它恒为 `anchored`——锚点是「页码 + 矩形」，是文件里的客观事实，失败等于 bug。
   * 网页上**失败是正常路径**：锚点不是坐标，是一次检索（`docs/research-web-anchoring.md`）。
   * 现在的 `Anchor` 不能直接扩展到网页，不是字段不够，是**它没有「可能找不到」
   * 这个概念**——先把这个概念建出来，别的才有地方放。
   */

  it("PDF 框选出来的摘录一出生就是 anchored", () => {
    const state = reduce(EMPTY, { type: "capture", id: "c1", region: REGION, at: 0, tagId: null });

    expect(state.clips[0].anchorStatus).toBe("anchored");
  });

  it("锚定状态可以改，四个值都到得了", () => {
    let state = readyClip("原文");
    for (const status of ["pending", "fuzzy", "orphan", "anchored"] as const) {
      state = reduce(state, { type: "reanchor", id: "c1", status });
      expect(state.clips[0].anchorStatus).toBe(status);
    }
  });

  it("**已入库的也能变成 orphan**——页面改了不问我们的意见", () => {
    const promoted = reduce(readyClip("原文"), {
      type: "promote",
      id: "c1",
      contextId: "ctx1",
      source: SOURCE,
    });

    expect(can(promoted, { type: "reanchor", id: "c1", status: "orphan" }).ok).toBe(true);
  });

  it("改锚定状态不动别的两根轴", () => {
    const before = reduce(readyClip("原文"), { type: "toggle-important", id: "c1" });
    const after = reduce(before, { type: "reanchor", id: "c1", status: "orphan" });

    expect(after.clips[0].state).toBe(before.clips[0].state);
    expect(after.clips[0].important).toBe(true);
    expect(after.clips[0].sourceText).toBe("原文");
  });

  describe("回不去的摘录不许回收", () => {
    /**
     * `decay` 会把 content、sourceText、translation **全部抹掉**（ADR-0012 的墓碑）。
     * 那在 PDF 上是安全的：文件还在磁盘上，随时能重框一次。
     *
     * **锚不回去的时候不安全**：存下来的这份就是仅存的副本。而且对网页摘录更狠——
     * `sourceText` 就是 `exact`，**它本身就是锚点**，抹掉之后这条摘录永远再也锚不回去。
     */
    it("orphan 不回收", () => {
      const orphaned = reduce(readyClip("原文"), { type: "reanchor", id: "c1", status: "orphan" });

      expect(can(orphaned, { type: "decay", id: "c1" }).ok).toBe(false);
    });

    it("fuzzy 也不回收——它还没被确认，抹掉引文就再也确认不了了", () => {
      const fuzzy = reduce(readyClip("原文"), { type: "reanchor", id: "c1", status: "fuzzy" });

      expect(can(fuzzy, { type: "decay", id: "c1" }).ok).toBe(false);
    });

    it("pending 不回收——还没试过锚定，谈不上「回得去」", () => {
      const pending = reduce(readyClip("原文"), { type: "reanchor", id: "c1", status: "pending" });

      expect(can(pending, { type: "decay", id: "c1" }).ok).toBe(false);
    });

    it("anchored 的照旧回收——这条不能把整个 ADR-0012 关掉", () => {
      expect(can(readyClip("原文"), { type: "decay", id: "c1" }).ok).toBe(true);
    });
  });
});

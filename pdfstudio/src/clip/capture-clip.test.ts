import { describe, expect, it } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureClip, captureOnly, recognizeClip } from "./capture-clip";
import { createClipStore } from "./clip-store";
import type { ClipsState } from "./clip";
import type { ClipContent, Recognizer, Region, Screenshot } from "../recognizer/recognizer";
import { RecognizeError } from "../recognizer/recognizer";

const PNG: Screenshot = {
  mime: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  width: 332,
  height: 78,
};

const REGION: Region = {
  page: 3,
  rect: { x: 140, y: 303, width: 332, height: 78 },
  pixels: PNG,
};

const EMPTY: ClipsState = { clips: [], contexts: [] };

/** 固定时刻：reducer 是纯的，时间由依赖带进来，测试才钉得住。 */
const CAPTURED_AT = 1_700_000_000_000;

/** 识别结果由测试指定：这里验的是编排，不是识别本身。 */
function recognizerReturning(content: ClipContent): Recognizer {
  return { recognize: async () => content };
}

function recognizerThrowing(error: unknown): Recognizer {
  return {
    recognize: async () => {
      throw error;
    },
  };
}

const CONTENT: ClipContent = {
  route: "text",
  anchor: { page: 3, rect: REGION.rect },
  sourceText: "The dominant sequence transduction models",
  screenshot: PNG,
  images: [PNG],
};

const freshStore = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-clip-"));
  return { root, store: createClipStore(root) };
};

describe("框选 → 识别 → 落盘", () => {
  it("识别成功：摘录落到 ready，原文逐字进磁盘", async () => {
    const { root, store } = await freshStore();

    const next = await captureClip(
      { recognizer: recognizerReturning(CONTENT), store, newId: () => "c1", now: () => CAPTURED_AT },
      EMPTY,
      "doc-1",
      REGION,
    );

    expect(next.ok).toBe(true);
    expect(next.state.clips).toHaveLength(1);
    expect(next.state.clips[0]).toMatchObject({ id: "c1", state: "ready", sourceText: CONTENT.sourceText });
    // 文件是唯一真相（ADR-0011）——内存里对了但没落盘，等于没存。
    expect(await readdir(path.join(root, "doc-1", "clips"))).toEqual(["c1"]);
  });

  it("识别失败：摘录不能卡在 recognizing", async () => {
    // `recognize` 的守卫要求 state === "capturing"。识别抛错后摘录停在 recognizing，
    // 于是 recognize 进不去、recognized 没内容可落、fix-source/promote 都要 ready
    // ——**没有任何动作能把它救回来**，只能删掉或重新框一次。
    // 网络抖一下就要读者重划一遍，这不合理。
    const { store } = await freshStore();

    const next = await captureClip(
      {
        recognizer: recognizerThrowing(new RecognizeError("model-unavailable", "模型调用失败")),
        store,
        newId: () => "c1",
        now: () => CAPTURED_AT,
      },
      EMPTY,
      "doc-1",
      REGION,
    );

    expect(next.ok).toBe(false);
    expect(next.state.clips[0].state).toBe("capturing");
  });

  it("识别失败：磁盘上不留半条摘录", async () => {
    // 半条摘录比没有更糟：它会被 listByDoc 读回来，也会被将来的索引重建捡走。
    const { root, store } = await freshStore();

    await captureClip(
      {
        recognizer: recognizerThrowing(new RecognizeError("bad-output", "模型没有按约定返回 JSON")),
        store,
        newId: () => "c1",
        now: () => CAPTURED_AT,
      },
      EMPTY,
      "doc-1",
      REGION,
    );

    expect(await readdir(root)).toEqual([]);
  });

  it("识别失败后可以直接重试，不必重新框", async () => {
    // 上一条只保证「没卡住」，这条保证「救回来的状态真的能往下走」——
    // 两者不是一回事：状态名对了但守卫仍然拦着，读者照样动弹不得。
    const { root, store } = await freshStore();
    const deps = { store, newId: () => "c1", now: () => CAPTURED_AT };

    const failed = await captureClip(
      { ...deps, recognizer: recognizerThrowing(new RecognizeError("model-unavailable", "失败")) },
      EMPTY,
      "doc-1",
      REGION,
    );
    const retried = await captureClip(
      { ...deps, recognizer: recognizerReturning(CONTENT) },
      failed.state,
      "doc-1",
      REGION,
    );

    // 同一区域重试合并进原摘录，不新建第二条——同区域两个标签会让锚点回跳有歧义。
    // clipId 因此必须回报**合并进的那条**，调用方靠它定位；用「最后一条」会指错人。
    expect(retried.clipId).toBe("c1");
    expect(retried.state.clips).toHaveLength(1);
    expect(retried.state.clips[0].state).toBe("ready");
    expect(await readdir(path.join(root, "doc-1", "clips"))).toEqual(["c1"]);
  });
});

describe("只框选，不识别（ADR-0019）", () => {
  const deps = (recognizer: Recognizer, root: string) => ({
    recognizer,
    store: createClipStore(root),
    newId: () => "new-clip",
    now: () => CAPTURED_AT,
  });

  it("**一个模型都不调**，摘录停在 capturing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clip-"));
    let called = false;
    const spy: Recognizer = {
      recognize: async () => {
        called = true;
        throw new Error("不该被调到");
      },
    };

    const out = await captureOnly(deps(spy, root), EMPTY, "doc", REGION, null);

    expect(called).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.state.clips[0]).toMatchObject({ state: "capturing", content: null });
  });

  it("落盘了——刷新之后这条还在，只是还没有内容", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clip-"));
    const out = await captureOnly(deps(recognizerThrowing(new Error("x")), root), EMPTY, "doc", REGION, null);

    const back = await createClipStore(root).listByDoc("doc");
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(out.clipId);
  });

  it("带上默认标记——连续划同一类时一次都不用点", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clip-"));
    const out = await captureOnly(deps(recognizerThrowing(new Error("x")), root), EMPTY, "doc", REGION, "green");

    expect(out.state.clips[0].tagId).toBe("green");
  });

  it("**事后再认**：停在 capturing 的那条能被认出来", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clip-"));
    const content: ClipContent = {
      route: "text",
      anchor: { page: 3, rect: REGION.rect },
      sourceText: "认出来的原文",
      images: [],
      screenshot: PNG,
    };
    const first = await captureOnly(deps(recognizerThrowing(new Error("x")), root), EMPTY, "doc", REGION, null);

    const out = await recognizeClip(deps(recognizerReturning(content), root), first.state, "doc", first.clipId);

    expect(out.ok).toBe(true);
    expect(out.state.clips[0]).toMatchObject({ state: "ready", sourceText: "认出来的原文" });
  });

  it("事后再认失败要退回 capturing——不然它再也认不了了", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clip-"));
    const first = await captureOnly(deps(recognizerThrowing(new Error("x")), root), EMPTY, "doc", REGION, null);

    const failed = recognizeClip(
      deps(recognizerThrowing(new RecognizeError("model-unavailable", "端点不通")), root),
      first.state,
      "doc",
      first.clipId,
    );
    const out = await failed;

    expect(out.ok).toBe(false);
    expect(out.state.clips[0].state).toBe("capturing");
  });

  it("认一条不存在的，不炸也不假装成功", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clip-"));
    const out = await recognizeClip(deps(recognizerReturning({} as ClipContent), root), EMPTY, "doc", "没有这条");

    expect(out.ok).toBe(false);
    // **要是有意的拒绝，不是碰巧被 catch 兜住的空指针。** 去掉守卫的话
    // `target.region` 会抛 TypeError，而它正好落进同一个 catch——返回值一模一样，
    // 只有错误的类型能分辨这两件事。
    if (out.ok) throw new Error("不该成功");
    expect(out.error).not.toBeInstanceOf(TypeError);
    expect(String((out.error as Error).message)).toContain("没有这条摘录");
  });
});

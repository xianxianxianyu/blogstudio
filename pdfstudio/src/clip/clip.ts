import type { ClipContent, Region } from "../recognizer/recognizer";

// canonical 接口见 pdfstudio/docs/clip-interface.md

export type ClipState = "capturing" | "recognizing" | "ready" | "promoted";

/** 标签形态：圆点 ⇄ 小窗。 */
export type Label = "dot" | "panel";

export interface Clip {
  id: string;
  state: ClipState;
  region: Region;
  /** 识别完成前为 null。 */
  content: ClipContent | null;
  sourceText: string | null;
  translation: string | null;
  note: string | null;
  label: Label;
}

export interface Context {
  id: string;
  /** 指回产出它的摘录。摘录被删后 id 仍留着，配合 sourceClipDeleted 说明来源去向。 */
  sourceClipId: string;
  source: string;
  claim: string | null;
  evidence: string;
  stance: "support" | "refute" | "neutral" | null;
  status: "pending" | "approved" | "rejected" | "disputed";
  sourceClipDeleted: boolean;
}

export interface ClipsState {
  clips: Clip[];
  contexts: Context[];
}

export type Action =
  | { type: "capture"; id: string; region: Region }
  | { type: "recognize"; id: string }
  | { type: "recognized"; id: string; content: ClipContent }
  | { type: "promote"; id: string; contextId: string }
  | { type: "fix-source"; id: string; text: string }
  | { type: "add-note"; id: string; text: string }
  | { type: "edit-translation"; id: string; text: string }
  | { type: "toggle-label"; id: string }
  | { type: "recapture"; id: string; region: Region }
  | { type: "delete"; id: string };

/** 修错字与改写的分界：编辑距离 ≤ 2 算修错字。 */
const MAX_TYPO_DISTANCE = 2;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length];
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

const ALLOWED: Verdict = { ok: true, reason: "" };

const denied = (reason: string): Verdict => ({ ok: false, reason });

/** 针对某条已存在摘录的守卫。存在性检查由 `can` 统一做，守卫拿到的 clip 一定在。 */
type Guard<T extends Action["type"]> = (
  clip: Clip,
  action: Extract<Action, { type: T }>,
) => Verdict;

/**
 * 每个动作都要**显式**声明守卫。
 *
 * 这张表是 `Record<...>` 而非可选映射，所以往 `Action` 里加一个动作却忘了写守卫，
 * TS 会报错。之前的写法是「先列出受管动作、其余一律放行」——**默认放行**，
 * 于是 `recognized` 可以把已入库的摘录打回 `ready` 并覆写原文，绕过了
 * 「入库即冻结」。漏一个就默认开门，这类洞会一直长出来。
 */
const GUARDS: { [T in Exclude<Action["type"], "capture">]: Guard<T> } = {
  recognize: (clip) =>
    clip.state === "capturing" ? ALLOWED : denied("只有刚框选的摘录需要识别。"),

  recognized: (clip) =>
    clip.state === "recognizing" ? ALLOWED : denied("这条摘录不在识别中，识别结果无处可落。"),

  "fix-source": (clip, action) => {
    if (clip.state === "promoted") return denied("已入库，原文是 context 的 evidence，不能再改。");
    if (clip.state !== "ready") return denied("还没识别完成，原文还没出来。");
    if (clip.sourceText === null) return denied("纯图摘录没有原文，谈不上修错字。");

    const distance = editDistance(clip.sourceText, action.text);
    if (distance === 0) return denied("没有改动。");
    if (distance > MAX_TYPO_DISTANCE) {
      return denied("这不是修 OCR 错字，是在改写原文——原文只准修错字，不得改写措辞。");
    }
    return ALLOWED;
  },

  // 自由编辑，入库后也不冻结——冻结的只有原文。
  "edit-translation": (clip) =>
    clip.state === "capturing" || clip.state === "recognizing"
      ? denied("还没识别完成，译文还没出来。")
      : ALLOWED,

  "add-note": (clip) =>
    clip.state === "capturing" ? denied("还没识别完成，先识别再加笔记。") : ALLOWED,

  "toggle-label": () => ALLOWED,

  promote: (clip) => {
    if (clip.state === "promoted") return denied("已入库，无需重复。");
    if (clip.state !== "ready") return denied("还没识别完成，不能入库。");
    // sourceText === null ⟺ 纯图 ⟺ 入库 blocked。不看 route，也不设 kind。
    if (clip.sourceText === null) return denied("纯图摘录没有原文，无法作为 evidence 入库。");
    return ALLOWED;
  },

  recapture: (clip) =>
    clip.state === "promoted"
      ? denied("已入库的摘录原文已冻结为 evidence，不能重拍覆盖。")
      : ALLOWED,

  delete: () => ALLOWED,
};

/** `reduce` 的前置判定，也供 UI 置灰按钮。 */
export function can(state: ClipsState, action: Action): Verdict {
  if (action.type === "capture") return ALLOWED;

  const clip = state.clips.find((candidate) => candidate.id === action.id);
  if (!clip) return denied("没有这条摘录。");

  const guard = GUARDS[action.type] as Guard<typeof action.type>;
  return guard(clip, action);
}

/**
 * 同一区域：页码相同且矩形四个数都相同。
 * 定案是「合并进已有标签，不新建第二个摘录」——同一区域两个标签会让锚点回跳有歧义。
 */
function sameRegion(a: Region, b: Region): boolean {
  return (
    a.page === b.page &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

function patchClip(state: ClipsState, id: string, patch: Partial<Clip>): ClipsState {
  return {
    ...state,
    clips: state.clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)),
  };
}

export function reduce(state: ClipsState, action: Action): ClipsState {
  if (!can(state, action).ok) return state;

  switch (action.type) {
    case "capture": {
      // 合并而非新建。此前这条定案只落在 recapture 上，capture 无条件 append——
      // 于是「不新建第二个摘录」这条规则被绕过去了。
      const existing = state.clips.find((clip) => sameRegion(clip.region, action.region));
      if (existing) {
        return patchClip(state, existing.id, {
          state: "capturing",
          content: null,
          sourceText: null,
          translation: null,
        });
      }

      return {
        ...state,
        clips: [
          ...state.clips,
          {
            id: action.id,
            state: "capturing",
            region: action.region,
            content: null,
            sourceText: null,
            translation: null,
            note: null,
            label: "dot",
          },
        ],
      };
    }

    case "recognize":
      return patchClip(state, action.id, { state: "recognizing" });

    case "recognized":
      return patchClip(state, action.id, {
        state: "ready",
        content: action.content,
        sourceText: action.content.sourceText,
        translation: action.content.translation ?? null,
      });

    case "fix-source":
      return patchClip(state, action.id, { sourceText: action.text });

    case "add-note":
      return patchClip(state, action.id, { note: action.text });

    case "edit-translation":
      return patchClip(state, action.id, { translation: action.text });

    case "toggle-label": {
      const clip = state.clips.find((candidate) => candidate.id === action.id);
      return clip ? patchClip(state, action.id, { label: clip.label === "dot" ? "panel" : "dot" }) : state;
    }

    // 合并进已有标签，不新建第二个摘录：同一区域两个标签会让锚点回跳有歧义。
    // 笔记是读者的、留下；原文换了一张，之前修的错字随之作废。
    case "recapture":
      return patchClip(state, action.id, {
        state: "recognizing",
        region: action.region,
        content: null,
        sourceText: null,
        translation: null,
      });

    // context 已被 Blog Studio 消费，删摘录不该连坐；但来源没了要如实标出。
    case "delete":
      return {
        clips: state.clips.filter((clip) => clip.id !== action.id),
        contexts: state.contexts.map((context) =>
          context.sourceClipId === action.id ? { ...context, sourceClipDeleted: true } : context,
        ),
      };

    case "promote": {
      const clip = state.clips.find((candidate) => candidate.id === action.id);
      // can() 已经挡掉 sourceText === null，这里只是让类型收窄。
      if (!clip || clip.sourceText === null) return state;

      const promoted = patchClip(state, action.id, { state: "promoted" });
      return {
        ...promoted,
        contexts: [
          ...state.contexts,
          {
            id: action.contextId,
            sourceClipId: clip.id,
            source: `page ${clip.region.page}`,
            claim: null,
            // evidence 是入库那一刻的副本，不随摘录变化。
            evidence: clip.sourceText,
            stance: null,
            status: "pending",
            sourceClipDeleted: false,
          },
        ],
      };
    }
  }
}

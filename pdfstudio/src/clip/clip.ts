import type { ClipContent, Region } from "../recognizer/recognizer";
import type { Context } from "../knowledge/context";
import type { TagColor } from "../tag/tag";

export type { Context };

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
  /**
   * 保留轴（ADR-0012），与 `state` 那根发布轴**正交**。未标记的摘录到期衰减为墓碑。
   *
   * 不能拿 `promoted` 代替：promote 在 `sourceText === null` 时拒绝，纯图永远进不了
   * promoted，合并成一根轴的话一张关键架构图必被回收。
   */
  important: boolean;
  /**
   * 分类（颜色即标签）。名字住在书架根的 `tags.md` 里，这里只存 id——改名不该重写
   * 几百个摘录文件。
   *
   * **与 `important` 是两回事**：标签说「这是什么」，☆ 说「别删」。合成一根轴的话，
   * 想留一段「存疑」就只能把它改成别的颜色。
   */
  tagId: TagColor | null;
  /**
   * 最后一次看它是什么时候（epoch 毫秒），保留期从这里起算而不是从创建起算——
   * 第 30 天点开了它，说明它还活着（ADR-0012）。
   *
   * 时间由动作带进来而不是在这里取：reducer 是纯的，`Date.now()` 会让同一组动作
   * 在不同时刻算出不同结果，测试也就钉不住了。
   */
  lastViewedAt: number;
}

export interface ClipsState {
  clips: Clip[];
  contexts: Context[];
}

export type Action =
  | { type: "capture"; id: string; region: Region; at: number; tagId?: TagColor | null }
  | { type: "recognize"; id: string }
  | { type: "recognize-failed"; id: string }
  | { type: "recognized"; id: string; content: ClipContent }
  | { type: "promote"; id: string; contextId: string }
  | { type: "fix-source"; id: string; text: string }
  | { type: "add-note"; id: string; text: string }
  | { type: "edit-translation"; id: string; text: string }
  | { type: "toggle-label"; id: string }
  | { type: "toggle-important"; id: string }
  | { type: "set-tag"; id: string; tagId: TagColor | null }
  | { type: "view"; id: string; at: number }
  | { type: "decay"; id: string }
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

/**
 * 同一区域：页码相同且矩形四个数都相同。
 * 定案是「合并进已有标签，不新建第二个摘录」——同一区域两个标签会让锚点回跳有歧义。
 *
 * **不比 `region.lines`**：那是同一块地方的更精确画法，不是另一个地方。比了的话，
 * 在同一段上先框选、后划词就会得到两个重叠的标签，而回跳该跳哪个说不清。
 */
export function sameRegion(a: Region, b: Region): boolean {
  return (
    a.page === b.page &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
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

  // 没有这个动作的话，识别一抛错摘录就永远停在 recognizing：recognize 的守卫要 capturing
  // 进不去，recognized 没内容可落，fix-source / promote 都要 ready——**没有任何动作能把它
  // 救回来**，只能删掉或重新框一次。网络抖一下就要读者重划一遍，不合理。
  "recognize-failed": (clip) =>
    clip.state === "recognizing" ? ALLOWED : denied("这条摘录不在识别中。"),

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

  // 任何状态都能标：读者是先认出「这块要留」才框的，不该等模型回答完才准标。
  "toggle-important": () => ALLOWED,

  // 同理：读者是先认出「这段算哪一类」才划的。
  "set-tag": () => ALLOWED,

  view: () => ALLOWED,

  /**
   * 判定归 `isCollectable`，但守卫这里也要拦——回收器之外还有别的调用方，
   * 规则只写在编排层就等于没写。
   */
  decay: (clip) => {
    if (clip.important) return denied("标记为重要的摘录不回收。");
    if (clip.state === "promoted") {
      return denied("已入库，Context 的 evidence 不能被回收器清掉——那是读者主动删除才有的权力。");
    }
    // 原文、译文、截图都能按锚点重新识别一次拿回来，**笔记不能**：它是读者自己写的，
    // 删了就永远没了。不自动删除无法再生的用户内容。
    if (clip.note !== null) return denied("写过笔记的摘录不回收，笔记没法重新生成。");
    if (clip.state !== "ready") return denied("只有识别完成的摘录才谈得上衰减。");
    return ALLOWED;
  },

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
  if (action.type === "capture") {
    // capture 会合并到同区域的已有摘录上，所以它**也能改到别人**——已入库的那条
    // 必须挡住，否则换个入口就能绕过 recapture 那条冻结守卫，把 evidence 清空，
    // 而 context 还指着它。守卫表按 id 找，capture 的 id 是新的，所以要单独判。
    const existing = state.clips.find((clip) => sameRegion(clip.region, action.region));
    return existing?.state === "promoted"
      ? denied("这块区域的摘录已入库，原文已冻结为 evidence，不能重拍覆盖。")
      : ALLOWED;
  }

  const clip = state.clips.find((candidate) => candidate.id === action.id);
  if (!clip) return denied("没有这条摘录。");

  const guard = GUARDS[action.type] as Guard<typeof action.type>;
  return guard(clip, action);
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
          lastViewedAt: action.at,
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
            important: false,
            tagId: action.tagId ?? null,
            lastViewedAt: action.at,
          },
        ],
      };
    }

    case "recognize":
      return patchClip(state, action.id, { state: "recognizing" });

    // 退回 capturing 而不是新设一个 failed 态：capturing 的含义正是「已框选、待识别」，
    // 与失败后的处境完全吻合，而且退回去 recognize 的守卫就自然放行，重试不必重新框。
    // 失败本身是调用方手上的一次性错误，不是摘录的持久属性——真要在列表里显示
    // 「这条失败过」时再加状态，那时才有真实需求可依。
    case "recognize-failed":
      return patchClip(state, action.id, { state: "capturing" });

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

    case "view":
      return patchClip(state, action.id, { lastViewedAt: action.at });

    // 只清内容，锚点原样留着：痕迹是永久的，内容是会过期的。锚点没了标签就画不出来，
    // 而标签的独特价值恰恰全在这些随手划过的摘录上——「这儿我来过」。
    case "decay":
      return patchClip(state, action.id, { content: null, sourceText: null, translation: null });

    case "set-tag":
      return patchClip(state, action.id, { tagId: action.tagId });

    case "toggle-important": {
      const clip = state.clips.find((candidate) => candidate.id === action.id);
      return clip ? patchClip(state, action.id, { important: !clip.important }) : state;
    }

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

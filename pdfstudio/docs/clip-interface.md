# Clip 接口（定稿）

> 行为依据：`public/pdfstudio-clip-prototype.html` 的 `can()` / `reduce()`。原型里标着
> 「⚠ 未定」的四个边界 case 在本文件定案（见下）。本文件是 canonical 接口，实现时以它为准。

## 接口

```ts
import type { ClipContent, Region } from '../recognizer/recognizer';

type ClipState = 'capturing' | 'recognizing' | 'ready' | 'promoted';
type Stance = 'support' | 'refute' | 'neutral';
type Label = 'dot' | 'panel';               // 圆点 ⇄ 小窗

interface Clip {
  id: string;
  state: ClipState;
  region: Region;
  content: ClipContent | null;               // 识别完成前为 null
  sourceText: string | null;                 // 可修 OCR 错字；promoted 后冻结
  translation: string | null;                // 自由编辑
  note: string | null;                       // 自由编辑
  label: Label;
}

interface Context {                          // 与 Blog Studio 共享
  id: string;
  sourceClipId: string;                      // 指回产出它的摘录；摘录删后 id 仍留着
  source: string;                            // 展示用（`page 3`），不作关联
  claim: string | null;
  evidence: string;                          // = 入库那一刻的 sourceText
  stance: Stance | null;
  status: 'pending' | 'approved' | 'rejected' | 'disputed';
  sourceClipDeleted: boolean;
}

interface ClipsState { clips: Clip[]; contexts: Context[] }

type Action =
  | { type: 'capture'; id: string; region: Region }
  | { type: 'recognize'; id: string }
  | { type: 'recognized'; id: string; content: ClipContent }
  | { type: 'fix-source'; id: string; text: string }
  | { type: 'edit-translation'; id: string; text: string }
  | { type: 'add-note'; id: string; text: string }
  | { type: 'promote'; id: string; contextId: string }
  | { type: 'delete'; id: string }
  | { type: 'recapture'; id: string; region: Region }
  | { type: 'toggle-label'; id: string };

interface Verdict { ok: boolean; reason: string }

function can(state: ClipsState, action: Action): Verdict;
function reduce(state: ClipsState, action: Action): ClipsState;
```

`can` 是 `reduce` 的前置判定，也供 UI 置灰按钮；`reduce` 遇到非法动作原样返回 state。

## 状态机

```
capture → capturing → recognize → recognizing → recognized → ready → promote → promoted
```

## 不变量

1. **纯读纯算**：无 I/O，同一 `(state, action)` 恒得同一结果，不改入参。
2. **原文只准修错字**：`fix-source` 与原文的编辑距离 ≤ 2 才合法；超过就是改写，拒绝。
3. **`sourceText === null` ⟹ 入库 blocked**。判定只看这一个字段，**不看 `content.route`、
   也不设 `kind`**——这是 Recognizer 的「`null` 编码可入库性」决策的下游（见
   `recognizer-interface.md`）。
4. **入库即冻结**：`promoted` 之后 `sourceText` 不可变，`recapture` 不可用。译文与笔记仍可编辑。
5. **evidence 是快照**：`Context.evidence` 是入库那一刻的 `sourceText` 副本，不随摘录变化。

## 四个边界 case 的定案

| case | 定案 | 理由 |
|---|---|---|
| 同一区域重复截图 | **合并进已有标签**，不新建第二个摘录 | 同一区域两个标签会让锚点回跳有歧义。重拍后重新识别：此前的 `fix-source` 改动**不保留**（原文换了），笔记**保留**（笔记是读者的，不是 OCR 的） |
| 入库后再改原文 | **禁止** | 原文已是 context 的 evidence。要改就先删 context |
| 摘录入 chat 后又被编辑 | **快照**，之后的编辑不回写 | 落在 Chat 那一侧，见 `chat-retrieval-interface.md` |
| 删除已入库的摘录 | **摘录删、context 保留**，并置 `sourceClipDeleted` | context 已被 Blog Studio 消费，删摘录不该连坐；但来源没了要如实标出 |

## 依赖策略

无 I/O、无外部依赖（category 1）。持久化归 `ClipStore` / `KnowledgeBase`，
对外缝就是 `reduce` / `can` 这两个纯函数——接口即测试面。

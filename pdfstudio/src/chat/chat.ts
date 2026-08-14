import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildIndex, findBestChunk } from "./retrieval";
import type { Chunk } from "./retrieval";
import type { ModelClient, ModelMessage } from "../model/model-client";
import type { Screenshot } from "../recognizer/recognizer";

// canonical 接口见 pdfstudio/docs/chat-retrieval-interface.md
// Retrieval 是 Chat 的内部缝，不对外开——调用方只看得到 ask。

/**
 * 贴入时刻的深拷贝，此后摘录再怎么编辑都不回写。
 *
 * **拷贝责任在调用方**：Chat 纯被动、无会话状态（不变量 ③），历史每次由调用方传入，
 * 它什么都不存，也就无从违反这条。这里描述的是交进来的这个值该具备的性质。
 */
export interface ClipSnapshot {
  clipId: string;
  sourceText: string;
  translation?: string;
  image?: Screenshot;
  page: number;
  note?: string;
}

export type Part =
  | { kind: "text"; text: string }
  | { kind: "clip"; snapshot: ClipSnapshot }
  | { kind: "image"; image: Screenshot };

export interface Turn {
  role: "user" | "assistant";
  parts: Part[];
}

export interface Citation {
  kind: "chunk" | "clip";
  page: number;
  snippet?: string;
  clipId?: string;
}

export interface Answer {
  text: string;
  citations: Citation[];
  /** 独立于模型输出判定；没有可靠依据必须是 'none'，不许编造。 */
  grounding: "retrieved" | "pasted" | "none";
}

export interface ChatDeps {
  document: PDFDocumentProxy;
  docId: string;
  model: ModelClient;
}

/** rare，可省。`signal` 是停止按钮的入口（ADR-0008 的 LocalRuntime 要它）。 */
export interface AskOptions {
  signal?: AbortSignal;
}

export interface Chat {
  ask(turns: Turn[], options?: AskOptions): Promise<Answer>;
  /** rare 逃生口：OCR 修正 / 换切块策略后重建索引。 */
  reindex(): Promise<void>;
}

/**
 * 贴入的摘录在 prompt 里保留出处：原文是 evidence，页码让回答能标 citation，
 * 笔记是读者自己的判断，一并给模型看。
 */
function renderSnapshot(snapshot: ClipSnapshot): string {
  const lines = [`[摘录 ${snapshot.clipId} · 第 ${snapshot.page} 页]`, snapshot.sourceText];
  if (snapshot.translation) lines.push(`译文：${snapshot.translation}`);
  if (snapshot.note) lines.push(`笔记：${snapshot.note}`);
  return lines.join("\n");
}

function toMessage(turn: Turn): ModelMessage {
  const content = turn.parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.kind === "clip") return renderSnapshot(part.snapshot);
      return null; // 图不进文本，走 ModelRequest.images
    })
    .filter((piece): piece is string => piece !== null)
    .join("\n\n");

  return { role: turn.role, content };
}

/** 贴入的摘录，按贴入顺序。 */
function collectSnapshots(turns: Turn[]): ClipSnapshot[] {
  return turns.flatMap((turn) =>
    turn.parts.flatMap((part) => (part.kind === "clip" ? [part.snapshot] : [])),
  );
}

/** 贴入的图与摘录自带的图，按贴入顺序汇总。 */
function collectImages(turns: Turn[]): Screenshot[] {
  return turns.flatMap((turn) =>
    turn.parts.flatMap((part) => {
      if (part.kind === "image") return [part.image];
      if (part.kind === "clip" && part.snapshot.image) return [part.snapshot.image];
      return [];
    }),
  );
}

function queryOf(turns: Turn[]): string {
  const last = turns.at(-1);
  return (
    last?.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join(" ") ?? ""
  );
}

export function createChat(deps: ChatDeps): Chat {
  // 懒加载 + 只建一次（不变量 ④）。索引绑在这个实例上，天然不可能串到别的文档。
  let index: Promise<Chunk[]> | null = null;
  const ensureIndex = () => (index ??= buildIndex(deps.document));

  return {
    async reindex(): Promise<void> {
      index = null;
    },

    async ask(turns: Turn[], options?: AskOptions): Promise<Answer> {
      const images = collectImages(turns);

      const hit = findBestChunk(await ensureIndex(), queryOf(turns));

      const messages = turns.map(toMessage);
      if (hit) {
        messages.unshift({
          role: "system",
          content: `以下是从文档中检索到的原文，回答只能基于它：\n\n${hit.text}`,
        });
      }

      let text = "";
      for await (const chunk of deps.model.streamComplete({
        messages,
        ...(images.length > 0 ? { images } : {}),
        signal: options?.signal,
      })) {
        text += chunk.textDelta;
        // 读者按下停止就收工，已读到的那半段答案照样是合法 Answer（不变量 ⑥）。
        if (options?.signal?.aborted) break;
      }

      // grounding 由检索结果判定，不看模型说了什么（不变量 ⑤）。
      // 出处两种都要给：检索命中不代表读者贴进来的摘录就不是依据了。
      const citations: Citation[] = [
        ...(hit ? [{ kind: "chunk" as const, page: hit.page, snippet: hit.text }] : []),
        ...collectSnapshots(turns).map((snapshot) => ({
          kind: "clip" as const,
          page: snapshot.page,
          clipId: snapshot.clipId,
        })),
      ];

      // grounding 是「依据的成色」，不是「有几条出处」：检索到原文最硬；
      // 只有贴入内容时是 pasted；两者都没有就必须诚实地说 none（不变量 ⑤）。
      const grounding = hit ? "retrieved" : citations.length > 0 ? "pasted" : "none";

      return { text, citations, grounding };
    },
  };
}

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ModelClient, ModelMessage } from "../model/model-client";
import type { Screenshot } from "../recognizer/recognizer";

// canonical 接口见 pdfstudio/docs/chat-retrieval-interface.md
// Retrieval 是 Chat 的内部缝，不对外开——调用方只看得到 ask。

/** 贴入时刻的深拷贝，此后摘录再怎么编辑都不回写。 */
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

export function createChat(deps: ChatDeps): Chat {
  return {
    async ask(turns: Turn[], options?: AskOptions): Promise<Answer> {
      const images = collectImages(turns);

      let text = "";
      for await (const chunk of deps.model.streamComplete({
        messages: turns.map(toMessage),
        ...(images.length > 0 ? { images } : {}),
        signal: options?.signal,
      })) {
        text += chunk.textDelta;
        // 读者按下停止就收工，已读到的那半段答案照样是合法 Answer（不变量 ⑥）。
        if (options?.signal?.aborted) break;
      }

      return { text, citations: [], grounding: "none" };
    },
  };
}

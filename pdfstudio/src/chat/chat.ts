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

export interface Chat {
  ask(turns: Turn[]): Promise<Answer>;
}

function toMessage(turn: Turn): ModelMessage {
  const text = turn.parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
  return { role: turn.role, content: text };
}

export function createChat(deps: ChatDeps): Chat {
  return {
    async ask(turns: Turn[]): Promise<Answer> {
      let text = "";
      for await (const chunk of deps.model.streamComplete({
        messages: turns.map(toMessage),
      })) {
        text += chunk.textDelta;
      }

      return { text, citations: [], grounding: "none" };
    },
  };
}

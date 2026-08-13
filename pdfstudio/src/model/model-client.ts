// 模型端口（true external）。契约见 ADR-0009。
// SDK-agnostic：provider / SSE / Vercel AI SDK 类型不得出现在这里。

export interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ModelImage {
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
  width?: number;
  height?: number;
}

export interface ModelRequest {
  messages: ModelMessage[];
  images?: ModelImage[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
}

export interface ModelChunk {
  textDelta: string;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  streamComplete(request: ModelRequest): AsyncIterable<ModelChunk>;
}

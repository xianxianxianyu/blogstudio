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

/**
 * 模型调用失败的统一类型。adapter 必须把底层错误映射成它——
 * 漏一个 SDK 的错误类出去就是 ADR-0007 禁止的类型泄漏，调用方也就被绑到了某个 SDK。
 */
export class ModelError extends Error {
  constructor(
    readonly kind: "http" | "empty-response" | "malformed-stream",
    message: string,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "ModelError";
    this.status = options?.status;
  }

  /** HTTP 状态码，仅 kind === 'http' 时有值。 */
  readonly status?: number;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  streamComplete(request: ModelRequest): AsyncIterable<ModelChunk>;
}

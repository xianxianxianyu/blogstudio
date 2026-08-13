import { ModelError } from "../src/model/model-client";
import type { ModelChunk, ModelClient, ModelRequest, ModelResponse } from "../src/model/model-client";

export interface FakeModelClient extends ModelClient {
  /** 记录每一次 complete 调用，用来断言「零成本」不变量。 */
  readonly completeCalls: ModelRequest[];
  /** 记录每一次 streamComplete 调用——Chat 该走流式而非一次性。 */
  readonly streamCalls: ModelRequest[];
}

export interface FakeModelOptions {
  completeText?: string;
  completeError?: Error;
  /** streamComplete 的切分方式；省略则整段一次给出。 */
  deltas?: string[];
}

export function createFakeModelClient(options: FakeModelOptions = {}): FakeModelClient {
  const completeCalls: ModelRequest[] = [];
  const streamCalls: ModelRequest[] = [];
  const text = options.completeText ?? "";

  return {
    completeCalls,
    streamCalls,

    async complete(request: ModelRequest): Promise<ModelResponse> {
      completeCalls.push(request);
      if (options.completeError) throw options.completeError;
      // 与生产 adapter 守同一份契约（test/model-client-contract.ts）：
      // fake 若在这里放行空回答，就成了一个比真实端点更宽容的替身。
      if (text.trim() === "") throw new ModelError("empty-response", "模型返回了空回答");
      return { text };
    },

    async *streamComplete(request: ModelRequest): AsyncIterable<ModelChunk> {
      streamCalls.push(request);
      if (options.completeError) throw options.completeError;
      if (request.signal?.aborted) return;

      for (const textDelta of options.deltas ?? [text]) {
        yield { textDelta };
        // 取消时优雅结束、不抛（ADR-0009）。
        if (request.signal?.aborted) return;
      }
    },
  };
}

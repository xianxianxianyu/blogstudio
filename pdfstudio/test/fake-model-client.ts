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
  /**
   * 只收 `ModelError`：生产 adapter 经 `toModelError` 之后不可能抛出别的形状，
   * fake 若允许任意 Error，就成了一个能产出真端点产不出的东西的替身。
   */
  completeError?: ModelError;
  /** streamComplete 的切分方式；省略则整段一次给出。 */
  deltas?: string[];
  /** 每吐出一个增量后回调，给测试一个确定的时机去 abort。 */
  onDelta?: (index: number) => void;
  /** 吐完 deltas 后不结束流，等 abort 来掐——契约里 abort 那条要用。 */
  hang?: boolean;
  /** 远端回的东西根本解析不了。 */
  malformed?: boolean;
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
      if (options.malformed) {
        throw new ModelError("malformed-stream", "模型返回的流无法解析");
      }
      if (request.signal?.aborted) return;

      for (const [index, textDelta] of (options.deltas ?? [text]).entries()) {
        if (request.signal?.aborted) return;
        yield { textDelta };
        options.onDelta?.(index);
        // 取消时优雅结束、不抛（ADR-0009）。
        if (request.signal?.aborted) return;
      }

      // 远端流不结束的情形：一直等到 abort。
      while (options.hang && !request.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}

import type {
  ModelChunk,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from "../src/model/model-client";

export interface FakeModelClient extends ModelClient {
  /** 记录每一次 complete 调用，用来断言「零成本」不变量。 */
  readonly completeCalls: ModelRequest[];
}

export function createFakeModelClient(
  options: { completeText?: string; completeError?: Error } = {},
): FakeModelClient {
  const completeCalls: ModelRequest[] = [];

  return {
    completeCalls,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      completeCalls.push(request);
      if (options.completeError) throw options.completeError;
      return { text: options.completeText ?? "" };
    },
    // eslint-disable-next-line require-yield
    async *streamComplete(): AsyncIterable<ModelChunk> {
      throw new Error("fake streamComplete 尚未使用");
    },
  };
}

import type { ModelChunk, ModelClient, ModelRequest, ModelResponse } from "./model-client";

/**
 * 每次调用**现建**一个客户端的 `ModelClient`。
 *
 * 设置页改完 key、换了模型名，读者指望它立刻生效（设置页头上写着「改动立刻保存」）。
 * 而写作助手、问文档那几个客户端原来是启动时按当时的配置建好、之后一直用的——
 * 于是「改了 key」在这两处等于没改，直到重启。而且不报错：旧 key 还能用的话，
 * 读者永远发现不了自己一直在用旧的；旧 key 作废了，看到的是一句跟设置无关的 401。
 *
 * `resolve` 交出**此刻**该用的客户端。建一个客户端不花什么（它只是把地址和 key
 * 装起来），所以按次建，不缓存——缓存就又回到了「什么时候失效」这个问题。
 */
export function createLiveClient(resolve: () => ModelClient): ModelClient {
  return {
    complete: (request: ModelRequest): Promise<ModelResponse> => resolve().complete(request),
    streamComplete: (request: ModelRequest): AsyncIterable<ModelChunk> => resolve().streamComplete(request),
  };
}

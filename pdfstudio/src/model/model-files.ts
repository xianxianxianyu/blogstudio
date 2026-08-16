/**
 * 本地模型权重的文件清单。
 *
 * 为什么要自己存一份：浏览器的 Cache API **会被回收**，几百 MB 的条目尤其容易；而且
 * 它与 Node 侧 eval 用的缓存是两套，跑过一次 eval 也帮不上浏览器。结果就是读者感觉
 * 「下载了很多次」。存到应用自己的目录里，下一次、之后永远从本地读，离线也能用
 * （ADR-0006：local-first 打包应用）。
 */
export interface ModelSpec {
  /** HuggingFace 仓库 id，同时也是本地目录名。 */
  id: string;
  /** 量化档，决定要下哪个 onnx。 */
  dtype: "fp32" | "fp16" | "q8" | "q4";
  /** 缺一个就起不来，404 视为下载失败。 */
  files: string[];
  /**
   * 有就下、没有就算了（404 不算失败）。
   *
   * 两类都真实存在：`.onnx_data` 只有大到超过 protobuf 2GB 上限的模型才有；
   * `added_tokens.json` 之类看分词器怎么导出。把它们列成必需会让别的仓库直接下不动。
   */
  optional: string[];
}

/**
 * dtype → 文件名，用的是 transformers.js 自己的约定。
 *
 * **`q8` 对应的是 `model_quantized.onnx`，不是 `model_q8.onnx`。** 后者根本不存在，
 * 硬猜的结果是 404——这条是实测撞出来的。
 */
const ONNX_NAME: Record<ModelSpec["dtype"], string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  q4: "model_q4.onnx",
};

export function embeddingModelSpec(id: string, dtype: ModelSpec["dtype"]): ModelSpec {
  const onnx = `onnx/${ONNX_NAME[dtype]}`;
  return {
    id,
    dtype,
    files: ["config.json", "tokenizer.json", "tokenizer_config.json", onnx],
    // **权重在 .onnx_data 里。** 只下 .onnx 会得到一个几百 KB 的图、没有权重，
    // 而且那不会 404——加载时才炸，报的还是一个跟「缺权重」毫无关系的错。
    optional: [`${onnx}_data`, "special_tokens_map.json", "added_tokens.json"],
  };
}

/** 与 `transformers-embedder.ts` 的默认档一致。改一处两处都要动，所以放在同一个模块里。 */
export const DEFAULT_EMBEDDING_MODEL = embeddingModelSpec(
  "onnx-community/embeddinggemma-300m-ONNX",
  "q8",
);

import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, embeddingModelSpec } from "./model-files";

describe("模型文件清单", () => {
  it("q8 对应的是 model_quantized.onnx，不是 model_q8.onnx", () => {
    // 实测撞出来的：后者根本不存在，硬猜的结果是 404。
    expect(embeddingModelSpec("x/y", "q8").files).toContain("onnx/model_quantized.onnx");
  });

  it("权重的外部数据文件要跟着下，但它是可选的", () => {
    // 只下 .onnx 会得到一个几百 KB 的图、没有权重，而且不会 404——加载时才炸。
    // 列成可选是因为只有超过 protobuf 2GB 上限的模型才有它。
    const spec = embeddingModelSpec("x/y", "q8");
    expect(spec.optional).toContain("onnx/model_quantized.onnx_data");
    expect(spec.files).not.toContain("onnx/model_quantized.onnx_data");
  });

  it("fp32 那档没有后缀", () => {
    expect(embeddingModelSpec("x/y", "fp32").files).toContain("onnx/model.onnx");
  });

  it("默认档与 transformers-embedder 的默认值一致", () => {
    // 两处不一致的话，设置页显示「已下载」而运行时仍去网上取另一个文件，
    // 读者会觉得「下了也没用」。
    expect(DEFAULT_EMBEDDING_MODEL.id).toBe("onnx-community/embeddinggemma-300m-ONNX");
    expect(DEFAULT_EMBEDDING_MODEL.dtype).toBe("q8");
  });

  it("分词器和配置都要，少一个 transformers.js 起不来", () => {
    expect(DEFAULT_EMBEDDING_MODEL.files).toEqual(
      expect.arrayContaining(["config.json", "tokenizer.json", "tokenizer_config.json"]),
    );
  });
});

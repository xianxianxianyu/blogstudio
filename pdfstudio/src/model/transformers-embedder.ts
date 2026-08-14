import { pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Embedder } from "./embedder";

/**
 * 本地跑的 embedding（ONNX / transformers.js），local-first 的检索侧。
 *
 * ## 两个会静默出错的地方，都在这里钉死
 *
 * 1. **任务前缀必须一字不差。** embeddinggemma 的 MTEB 成绩是在注入前缀的条件下
 *    跑的；不加或加错，它就掉到 bge-m3 之下（`research-embedding-shortlist.md`
 *    §3.4，是明确的推翻条件）。前缀写在下面的常量里，query 与 document 各一条。
 * 2. **dtype 必须显式指定。** transformers.js 在 Node 下默认 `fp32`——不写就是去下
 *    2 GB 权重而不是 294.6 MB 的 q8。默认值会让「体积可控」这个前提当场失效。
 *
 * 默认档取 **q8 而非 q4**：q4 那 187.6 MB 是事后动态量化、质量无公开数据；
 * q8 只多 107 MB，而 EmbeddingGemma 论文里 int8 相对 bf16 只掉 0.22（QAT 条件下）。
 * 先用 q8 建基线，再用 eval 决定能不能降到 q4——反过来做会分不清「模型不行」
 * 还是「量化不行」。
 */
export interface TransformersEmbedderConfig {
  /** HuggingFace 仓库 id。 */
  model?: string;
  /** 量化档。 */
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** 查询侧前缀。 */
  queryPrefix?: string;
  /** 文档侧前缀。 */
  documentPrefix?: string;
}

/** 一次前向的最大块数。 */
const BATCH_SIZE = 32;

const DEFAULTS = {
  model: "onnx-community/embeddinggemma-300m-ONNX",
  dtype: "q8",
  queryPrefix: "task: search result | query: ",
  documentPrefix: "title: none | text: ",
} as const;

export function createTransformersEmbedder(config: TransformersEmbedderConfig = {}): Embedder {
  const settings = { ...DEFAULTS, ...config };

  // 首次调用时才加载（权重要下载几百 MB），之后复用同一个 pipeline。
  // **失败的 promise 不能留**：首次下载中断后若把它缓存住，这个实例此后每次调用都以
  // 同一个错误 reject，再也没有重试的路径。
  let extractor: Promise<FeatureExtractionPipeline> | null = null;
  const load = () => {
    extractor ??= pipeline("feature-extraction", settings.model, {
      dtype: settings.dtype,
    }).catch((error: unknown) => {
      extractor = null;
      throw error;
    });
    return extractor;
  };

  const encode = async (texts: string[]): Promise<Float32Array[]> => {
    const pipe = await load();
    const vectors: Float32Array[] = [];

    // 分批。整篇语料一次前向在几十页的论文上还撑得住，换成书稿就是几千块一次
    // ONNX forward，内存直接爆。
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      // 池化与归一化交给 pipeline：embeddinggemma 的两层 Dense 投影已经融进 ONNX 图，
      // 自己再做一遍反而会算错。
      const output = await pipe(texts.slice(start, start + BATCH_SIZE), {
        pooling: "mean",
        normalize: true,
      });
      vectors.push(...output.tolist().map((row: number[]) => Float32Array.from(row)));
    }

    return vectors;
  };

  return {
    async embedQuery(text: string): Promise<Float32Array> {
      const [vector] = await encode([`${settings.queryPrefix}${text}`]);
      return vector;
    },

    async embedDocuments(texts: string[]): Promise<Float32Array[]> {
      return encode(texts.map((text) => `${settings.documentPrefix}${text}`));
    },
  };
}

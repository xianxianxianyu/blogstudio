import { ModelError } from "./model-client";
import type { ModelChunk, ModelClient, ModelRequest, ModelResponse } from "./model-client";

/**
 * 让**只认固定 prompt 的专用识别模型**落在 `ModelClient` 端口后面。
 *
 * 协议兼容 ≠ prompt 兼容：PaddleOCR-VL 有官方 GGUF、官方 `llama-server` 文档，
 * HTTP 层完全兼容——但它是 element-level 识别模型，只接受六个固定 prompt
 * （`OCR:` / `Formula Recognition:` / `Table Recognition:` / `Chart Recognition:` /
 * `Seal Recognition:` / `Spotting:`），看不懂 Recognizer 那段要求返回 JSON 的契约。
 *
 * 这层装饰器把两边接上：进来的请求换成固定 prompt，出去的纯文本包回 JSON 契约。
 * **`Recognizer` 一行都不用改**，它以为自己在跟一个普通的多模态模型说话。
 *
 * ## 为什么统一用 `OCR:`
 *
 * 专用模型不做分类，而挑对 prompt 恰恰需要先知道这块是不是公式。三条路都不通：
 * 先分类再识别是两次调用（破坏「每个模块至多一次」）；让调用方指定等于把分类推给
 * 读者；从覆盖度猜——实测公式 30.3%、图 40.0%，分不开。
 *
 * ## 实测修正（2026-08-16）
 *
 * 这里原先写着「统一用 `OCR:`，公式区拿到的是拍平的字符而不是 LaTeX」。
 * **那是预测，不是测量，而且它是错的**：19 张样本跑下来，`OCR:` 对公式区照样输出
 * LaTeX（`$$…$$` 或 `\(…\)` 包裹）。
 *
 * 真实的差距在别处，且**换成 `Formula Recognition:` 也修不掉**（同一张图两个 prompt
 * 对比过）：
 *
 * - `\prod_{t=1}^{T}` 的上标 `T` 读不出来（f01/f02），云端读得出——**内容错误**
 * - `=` 被认成 `\equiv`（f04）
 * - 函数名不套 `\mathrm{}`，输出是「markdown + 行内公式」而不是一条公式（f05/f06）
 *
 * 所以本地档的损失是**模型能力边界**，不是 prompt 选择问题。给 `RecognizeOptions`
 * 加 `kind` 提示这条路可以不用走了——它解决不了上面任何一条。
 */
const OCR_PROMPT = "OCR:";

/** 专用模型不做分类，只能从「有没有认出字」反推一个保守的 kind。 */
function inferKind(sourceText: string): "image" | "mixed" {
  // 认不出字 ⟹ 当纯图。纯图的 sourceText 是 null ⟹ 入库 blocked——
  // 错判成纯图只是少一条可入库的摘录，错判成有原文则会放一条没有 evidence 的进知识库。
  // 两种错的代价不对称，所以往安全的一侧倒。
  return sourceText.trim() === "" ? "image" : "mixed";
}

export function createFixedPromptRecognitionClient(inner: ModelClient): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let text: string;
      try {
        ({ text } = await inner.complete({
          ...request,
          messages: [{ role: "user", content: OCR_PROMPT }],
        }));
      } catch (cause) {
        // 契约在这里与专用识别模型的语义冲突：对**对话模型**来说空回答是失败
        // （ADR-0009 的 empty-response），对 **OCR 模型**来说「这张图里没有字」
        // 是一个有效且有信息量的答案——纯图区就该是这个结果。
        // 只吞这一种，其余照样往上抛。
        if (!(cause instanceof ModelError) || cause.kind !== "empty-response") throw cause;
        text = "";
      }

      const kind = inferKind(text);
      return {
        text: JSON.stringify({
          kind,
          sourceText: kind === "image" ? null : text,
          // 专用识别模型不产出描述。图/表摘录因此没有一句话描述，但不阻断入库
          // ——入库只看 sourceText。
          multimodal: null,
        }),
      };
    },

    streamComplete(): AsyncIterable<ModelChunk> {
      // Chat 才用流式，而 Chat 不该接识别模型。接错了要立刻炸，不要静默降级。
      throw new ModelError("http", "识别模型不支持流式；Chat 请配对话模型");
    },
  };
}

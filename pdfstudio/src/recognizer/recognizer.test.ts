import { describe, expect, it } from "vitest";
import { createRecognizer, RecognizeError } from "./recognizer";
import type { Region, Screenshot } from "./recognizer";
import { openFixturePdf } from "../../test/fixtures";
import { createFakeModelClient } from "../../test/fake-model-client";

// 真值独立于实现：用 poppler（`pdftotext -f 1 -l 1 -x 140 -y 411 -W 332 -H 78`）
// 从 arXiv:1706.03762 抽出 Abstract 前 7 行；实现走的是 pdf.js，两条链路互不相干。
const ABSTRACT_HEAD =
  "The dominant sequence transduction models are based on complex recurrent or " +
  "convolutional neural networks that include an encoder and a decoder. The best " +
  "performing models also connect the encoder and decoder through an attention " +
  "mechanism. We propose a new simple network architecture, the Transformer, " +
  "based solely on attention mechanisms, dispensing with recurrence and convolutions " +
  "entirely. Experiments on two machine translation tasks show these models to " +
  "be superior in quality while being more parallelizable and requiring significantly";

// poppler 的裁剪框是 top-left 原点；Region.rect 是 PDF 页面坐标（左下原点，页高 792pt）。
const ABSTRACT_RECT = { x: 140, y: 792 - 489, width: 332, height: 78 };

// arXiv:2006.11239 p.1 Figure 1 的样本图阵列：目视是纯照片，
// poppler 在该框内取不到任何文字，文本覆盖度为 0。
const FIGURE_RECT = { x: 110, y: 792 - 690, width: 390, height: 210 };

// arXiv:1706.03762 p.4 式 (1) Scaled Dot-Product Attention（eval 样本 f05），框内不含式号。
// 文本层有 16 个 item、覆盖度 30.8%，但抽出来是扁的
// `Attention(Q, K, V ) = softmax( QKT√dk)V`——分式与上标全丢，所以必须落视觉。
const FORMULA_RECT = { x: 215, y: 792 - 494, width: 180, height: 32 };

// arXiv:1706.03762 p.3（eval 样本 m02）：Figure 1 架构图下半 + 图题 + 下方正文段落。
// 图内标签是描边路径、不在文本层（该页 y<405.5 没有任何 text block），
// 文本层只剩图题和段落，覆盖度 15.2%。
const MIXED_RECT = { x: 107, y: 792 - 470, width: 399, height: 170 };

const ATTENTION_LATEX =
  "\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V";

// text 路由只回显 pixels，不读像素，所以 fixture 用占位截图。
const STUB_PIXELS: Screenshot = {
  mime: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  width: 332,
  height: 78,
};

/** 断言「逐字」看的是词与词序未被改写，不锁死 TextItem 的拼接规则（内部缝）。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("Recognizer — 数字 PDF 文本区", () => {
  it("返回逐字 sourceText，且不调用 ModelClient", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const model = createFakeModelClient();
    const recognizer = createRecognizer({ document, model });

    const region: Region = {
      page: 1,
      rect: ABSTRACT_RECT,
      pixels: STUB_PIXELS,
    };

    const content = await recognizer.recognize(region);

    expect(normalizeWhitespace(content.sourceText ?? "")).toBe(ABSTRACT_HEAD);
    expect(model.completeCalls).toHaveLength(0);
  });
});

describe("Recognizer — 纯图区", () => {
  it("走 vision，且恰好调用一次 model.complete", async () => {
    const document = await openFixturePdf("2006.11239.pdf");
    const model = createFakeModelClient({
      completeText: JSON.stringify({
        sourceText: null,
        multimodal: "四张人脸样本与一格 CIFAR10 样本阵列",
      }),
    });
    const recognizer = createRecognizer({ document, model });

    const region: Region = {
      page: 1,
      rect: FIGURE_RECT,
      pixels: STUB_PIXELS,
    };

    const content = await recognizer.recognize(region);

    expect(content.route).toBe("vision");
    expect(model.completeCalls).toHaveLength(1);
  });

  it("模型把原文回成空白时归一成 null", async () => {
    const document = await openFixturePdf("2006.11239.pdf");
    // 视觉模型常把「没有原文」回成空串而不是 null。
    const model = createFakeModelClient({
      completeText: JSON.stringify({ sourceText: "   ", multimodal: "样本图阵列" }),
    });
    const recognizer = createRecognizer({ document, model });

    const content = await recognizer.recognize({
      page: 1,
      rect: FIGURE_RECT,
      pixels: STUB_PIXELS,
    });

    // sourceText === null ⟺ 纯图 ⟺ 入库 blocked。空串不是 null，
    // 会让 Clip reducer 以为有 evidence 而放行 promote。
    expect(content.sourceText).toBeNull();
  });
});

describe("Recognizer — 公式区", () => {
  it("把模型给的 LaTeX 放进 sourceText，而不是 multimodal", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const model = createFakeModelClient({
      completeText: JSON.stringify({ sourceText: ATTENTION_LATEX, multimodal: null }),
    });
    const recognizer = createRecognizer({ document, model });

    const region: Region = {
      page: 4,
      rect: FORMULA_RECT,
      pixels: STUB_PIXELS,
    };

    const content = await recognizer.recognize(region);

    // LaTeX 是逐字无损编码，所以归原文——公式摘录才有 evidence、才能入库。
    expect(content.route).toBe("vision");
    expect(content.sourceText).toBe(ATTENTION_LATEX);
    expect(content.multimodal).toBeUndefined();
  });
});

describe("Recognizer — 模型输出坏掉时", () => {
  it("抛 RecognizeError{kind:'bad-output'}，不漏 SyntaxError 给调用方", async () => {
    const document = await openFixturePdf("2006.11239.pdf");
    // 模型没按约定回 JSON，直接回了一句白话。拒答（「抱歉，我无法…」）也落这一类：
    // 在只有 text 的 ModelResponse 上，拒答和坏输出分不开。
    const model = createFakeModelClient({ completeText: "这个区域是一组人脸样本图。" });
    const recognizer = createRecognizer({ document, model });

    const error = await recognizer
      .recognize({ page: 1, rect: FIGURE_RECT, pixels: STUB_PIXELS })
      .catch((thrown: unknown) => thrown);

    // 调用方只 catch 一次、按 kind 分支；裸 SyntaxError 会让它无从区分失败原因。
    expect(error).toBeInstanceOf(RecognizeError);
    expect((error as RecognizeError).kind).toBe("bad-output");
  });
});

describe("Recognizer — 模型调不通时", () => {
  it("抛 RecognizeError{kind:'model-unavailable'}，并保留原始错误", async () => {
    const document = await openFixturePdf("2006.11239.pdf");
    const networkFailure = new Error("fetch failed");
    const model = createFakeModelClient({ completeError: networkFailure });
    const recognizer = createRecognizer({ document, model });

    const error = await recognizer
      .recognize({ page: 1, rect: FIGURE_RECT, pixels: STUB_PIXELS })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RecognizeError);
    expect((error as RecognizeError).kind).toBe("model-unavailable");
    // 原始错误留在 cause 上，排查时才知道是网络还是鉴权。
    expect((error as RecognizeError).cause).toBe(networkFailure);
  });
});

describe("Recognizer — 图文混排区", () => {
  it("原文进 sourceText，译文进 translation", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const model = createFakeModelClient({
      completeText: JSON.stringify({
        sourceText: "Figure 1: The Transformer - model architecture.",
        translation: "图 1：Transformer —— 模型架构。",
        multimodal: "编码器与解码器堆叠的架构图",
      }),
    });
    const recognizer = createRecognizer({ document, model });

    const content = await recognizer.recognize({
      page: 3,
      rect: MIXED_RECT,
      pixels: STUB_PIXELS,
    });

    expect(content.route).toBe("vision");
    // 混排区有原文 ⟹ 有 evidence ⟹ 可入库，与纯图的 null 相对。
    expect(content.sourceText).toBe("Figure 1: The Transformer - model architecture.");
    expect(content.translation).toBe("图 1：Transformer —— 模型架构。");
  });
});

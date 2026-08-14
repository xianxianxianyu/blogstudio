import { describe, expect, it } from "vitest";
import { createRecognizer, RecognizeError } from "./recognizer";
import type { Rect, Recognizer, Region, Screenshot } from "./recognizer";
import { openFixturePdf } from "../../test/fixtures";
import { createFakeModelClient } from "../../test/fake-model-client";
import { ModelError } from "../model/model-client";
import type { FakeModelOptions } from "../../test/fake-model-client";

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

// arXiv:1706.03762 p.13 的 attention 可视化图：整页是 <pad> 词元的叠绘，同一批词被
// 反复画在同一处。求和会重复计数把它抬进 text 路由，取并集才落 vision。
// 具体数字只留 recognizer-interface.md 一份，别在三处各抄一遍——已经打架过一次。
// poppler 在这里抽出的是残缺的 "Input-Input L Attention Visualiza"——叠绘让文本层不可用，
// 该走视觉。这是全部三篇论文 22265 个候选区域里仅有的两处求和/并集分歧之一。
const OVERDRAWN_FIGURE_RECT = { x: 100, y: 700, width: 100, height: 50 };

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

async function setup(paper: string, modelOptions?: FakeModelOptions, targetLang?: string) {
  const document = await openFixturePdf(paper);
  const model = createFakeModelClient(modelOptions);
  return { model, recognizer: createRecognizer({ document, recognition: model, targetLang }) };
}

/** 发给模型的那段 prompt——ModelClient 是真外部缝，跨过它的东西可观测。 */
function promptOf(model: { completeCalls: { messages: { content: string }[] }[] }): string {
  return model.completeCalls[0].messages.map((message) => message.content).join("\n");
}

function regionAt(page: number, rect: Rect): Region {
  return { page, rect, pixels: STUB_PIXELS };
}

/** 取出 recognize 抛出的 RecognizeError；抛的若不是它，断言就在这里失败。 */
async function catchRecognizeError(
  recognizer: Recognizer,
  region: Region,
): Promise<RecognizeError> {
  const thrown = await recognizer.recognize(region).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(RecognizeError);
  return thrown as RecognizeError;
}

describe("Recognizer — 数字 PDF 文本区", () => {
  it("返回逐字 sourceText，且不调用 ModelClient", async () => {
    const { model, recognizer } = await setup("1706.03762.pdf");

    const content = await recognizer.recognize(regionAt(1, ABSTRACT_RECT));

    expect(normalizeWhitespace(content.sourceText ?? "")).toBe(ABSTRACT_HEAD);
    expect(model.completeCalls).toHaveLength(0);
  });
});

describe("Recognizer — 纯图区", () => {
  it("走 vision，且恰好调用一次 model.complete", async () => {
    const { model, recognizer } = await setup("2006.11239.pdf", {
      completeText: JSON.stringify({
        kind: "image",
        sourceText: null,
        multimodal: "四张人脸样本与一格 CIFAR10 样本阵列",
      }),
    });

    const content = await recognizer.recognize(regionAt(1, FIGURE_RECT));

    expect(content.route).toBe("vision");
    expect(model.completeCalls).toHaveLength(1);
  });

  it("把区域截图放进 images——路由表四行 vision 都要", async () => {
    const { recognizer } = await setup("2006.11239.pdf", {
      completeText: JSON.stringify({ kind: "image", sourceText: null, multimodal: "样本图阵列" }),
    });

    const content = await recognizer.recognize(regionAt(1, FIGURE_RECT));

    // images 是抠出来给 markdown 用的图；screenshot 是同一块区域的 ground truth 回显。
    expect(content.images).toEqual([STUB_PIXELS]);
    expect(content.screenshot).toBe(STUB_PIXELS);
  });

  it("模型把原文回成空白时归一成 null", async () => {
    // 视觉模型常把「没有原文」回成空串而不是 null。
    const { recognizer } = await setup("2006.11239.pdf", {
      completeText: JSON.stringify({ kind: "image", sourceText: "   ", multimodal: "样本图阵列" }),
    });

    const content = await recognizer.recognize(regionAt(1, FIGURE_RECT));

    // sourceText === null ⟺ 纯图 ⟺ 入库 blocked。空串不是 null，
    // 会让 Clip reducer 以为有 evidence 而放行 promote。
    expect(content.sourceText).toBeNull();
  });

  it("模型多回了 translation 也丢弃——路由表只有混排行有译文栏", async () => {
    const { recognizer } = await setup("2006.11239.pdf", {
      completeText: JSON.stringify({
        kind: "image",
        sourceText: null,
        translation: "样本图阵列",
        multimodal: "四张人脸样本与一格 CIFAR10 样本阵列",
      }),
    });

    const content = await recognizer.recognize(regionAt(1, FIGURE_RECT));

    expect(content.translation).toBeUndefined();
    expect(content.multimodal).toBe("四张人脸样本与一格 CIFAR10 样本阵列");
  });
});

describe("Recognizer — 公式区", () => {
  it("把模型给的 LaTeX 放进 sourceText，而不是 multimodal", async () => {
    const { recognizer } = await setup("1706.03762.pdf", {
      completeText: JSON.stringify({
        kind: "formula",
        sourceText: ATTENTION_LATEX,
        multimodal: null,
      }),
    });

    const content = await recognizer.recognize(regionAt(4, FORMULA_RECT));

    // LaTeX 是逐字无损编码，所以归原文——公式摘录才有 evidence、才能入库。
    expect(content.route).toBe("vision");
    expect(content.sourceText).toBe(ATTENTION_LATEX);
    expect(content.multimodal).toBeUndefined();
  });

  it("模型多回了 multimodal 也丢弃——路由表的公式行没有描述栏", async () => {
    const { recognizer } = await setup("1706.03762.pdf", {
      completeText: JSON.stringify({
        kind: "formula",
        sourceText: ATTENTION_LATEX,
        multimodal: "一个注意力机制的公式",
      }),
    });

    const content = await recognizer.recognize(regionAt(4, FORMULA_RECT));

    expect(content.sourceText).toBe(ATTENTION_LATEX);
    expect(content.multimodal).toBeUndefined();
  });
});

describe("Recognizer — 模型输出坏掉时", () => {
  it("抛 RecognizeError{kind:'bad-output'}，不漏 SyntaxError 给调用方", async () => {
    // 模型没按约定回 JSON，直接回了一句白话。拒答（「抱歉，我无法…」）也落这一类：
    // 在只有 text 的 ModelResponse 上，拒答和坏输出分不开。
    const { recognizer } = await setup("2006.11239.pdf", {
      completeText: "这个区域是一组人脸样本图。",
    });

    const error = await catchRecognizeError(recognizer, regionAt(1, FIGURE_RECT));

    // 调用方只 catch 一次、按 kind 分支；裸 SyntaxError 会让它无从区分失败原因。
    expect(error.kind).toBe("bad-output");
  });

  it("模型没报区域类型时也算坏输出——否则它能绕过路由表的裁剪", async () => {
    const { recognizer } = await setup("2006.11239.pdf", {
      completeText: JSON.stringify({ sourceText: null, multimodal: "样本图阵列" }),
    });

    const error = await catchRecognizeError(recognizer, regionAt(1, FIGURE_RECT));

    expect(error.kind).toBe("bad-output");
  });
});

describe("Recognizer — 模型调不通时", () => {
  it("抛 RecognizeError{kind:'model-unavailable'}，并保留原始错误", async () => {
    const networkFailure = new ModelError("http", "fetch failed");
    const { recognizer } = await setup("2006.11239.pdf", { completeError: networkFailure });

    const error = await catchRecognizeError(recognizer, regionAt(1, FIGURE_RECT));

    expect(error.kind).toBe("model-unavailable");
    // 原始错误留在 cause 上，排查时才知道是网络还是鉴权。
    expect(error.cause).toBe(networkFailure);
  });
});

describe("Recognizer — 误触的框", () => {
  const misTouch = (width: number, height: number) =>
    regionAt(1, { x: ABSTRACT_RECT.x, y: ABSTRACT_RECT.y, width, height });

  it("零面积的框抛 RecognizeError{kind:'region-too-small'}，且不调模型", async () => {
    const { model, recognizer } = await setup("1706.03762.pdf");

    // 读者只点了一下、没拖出框。
    const error = await catchRecognizeError(recognizer, misTouch(0, 0));

    expect(error.kind).toBe("region-too-small");
    // 误触不该烧掉一次云模型调用（ADR-0005 是用户自配的付费端点）。
    expect(model.completeCalls).toHaveLength(0);
  });

  it("边长小到装不下一个字的框同样算误触", async () => {
    const { model, recognizer } = await setup("1706.03762.pdf");

    // 手抖拖出的小方块。
    expect((await catchRecognizeError(recognizer, misTouch(3, 3))).kind).toBe("region-too-small");
    // 面积够大但薄成一条线的框——沿着行间划过去就会产生。
    expect((await catchRecognizeError(recognizer, misTouch(200, 0.5))).kind).toBe(
      "region-too-small",
    );

    expect(model.completeCalls).toHaveLength(0);
  });
});

describe("Recognizer — 叠绘的图", () => {
  it("覆盖度取并集而非求和：反复叠绘的文字不该把区域抬成 text 路由", async () => {
    const { model, recognizer } = await setup("1706.03762.pdf", {
      completeText: JSON.stringify({
        kind: "figure",
        sourceText: null,
        multimodal: "attention 头的可视化图",
      }),
    });

    const content = await recognizer.recognize(regionAt(13, OVERDRAWN_FIGURE_RECT));

    expect(content.route).toBe("vision");
    expect(model.completeCalls).toHaveLength(1);
  });
});

describe("Recognizer — route 逃生口", () => {
  it("route: 'vision' 让文本区也走视觉——覆盖度误判时的出口", async () => {
    const { model, recognizer } = await setup("1706.03762.pdf", {
      completeText: JSON.stringify({
        kind: "mixed",
        sourceText: "The dominant sequence transduction models",
        translation: "主流的序列转导模型",
        multimodal: "一段正文",
      }),
    });

    const content = await recognizer.recognize(regionAt(1, ABSTRACT_RECT), { route: "vision" });

    expect(content.route).toBe("vision");
    expect(model.completeCalls).toHaveLength(1);
  });

  it("route: 'text' 让纯图区不调模型，且原文是 null 而非空串", async () => {
    const { model, recognizer } = await setup("2006.11239.pdf");

    const content = await recognizer.recognize(regionAt(1, FIGURE_RECT), { route: "text" });

    expect(content.route).toBe("text");
    expect(model.completeCalls).toHaveLength(0);
    // 不变量 5 压过候选文档里「强制 text 但无字 → 返回 ''」的写法：
    // '' 不是 null，会让 Clip reducer 以为有 evidence 而放行 promote。
    expect(content.sourceText).toBeNull();
  });
});

describe("Recognizer — 译文语言", () => {
  async function withTranslator(targetLang?: string) {
    const document = await openFixturePdf("1706.03762.pdf");
    const recognition = createFakeModelClient();
    const translation = createFakeModelClient({ completeText: "译文" });
    return {
      translation,
      recognizer: createRecognizer({ document, recognition, translation, targetLang }),
    };
  }

  it("默认译成 zh", async () => {
    const { translation, recognizer } = await withTranslator();

    await recognizer.recognize(regionAt(1, ABSTRACT_RECT));

    // 目标语言现在属于翻译模块，不再写进识别 prompt（ADR-0010）。
    // 只断言指令那半句——prompt 里还有被翻译的英文原文，整体匹配会误伤。
    expect(promptOf(translation)).toContain("译成 zh");
  });

  it("构造配置的 targetLang 决定译文语言", async () => {
    const { translation, recognizer } = await withTranslator("en");

    await recognizer.recognize(regionAt(1, ABSTRACT_RECT));

    const prompt = promptOf(translation);
    expect(prompt).toContain("译成 en");
    expect(prompt).not.toContain("译成 zh");
  });

  it("单次调用的 options.targetLang 压过构造配置", async () => {
    const { translation, recognizer } = await withTranslator("en");

    await recognizer.recognize(regionAt(1, ABSTRACT_RECT), { targetLang: "ja" });

    const prompt = promptOf(translation);
    expect(prompt).toContain("译成 ja");
    expect(prompt).not.toContain("译成 en");
  });
});

describe("Recognizer — 图文混排区", () => {
  it("原文进 sourceText，译文由翻译模块产出、不采纳识别模型顺手回的那份", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const recognition = createFakeModelClient({
      completeText: JSON.stringify({
        kind: "mixed",
        sourceText: "Figure 1: The Transformer - model architecture.",
        // 识别模型即使多回了译文也不采纳——翻译是另一个功能，另配模型（ADR-0010）。
        translation: "识别模型顺手翻的，不该被采用",
        multimodal: "编码器与解码器堆叠的架构图",
      }),
    });
    const translation = createFakeModelClient({ completeText: "图 1：Transformer —— 模型架构。" });
    const recognizer = createRecognizer({ document, recognition, translation });

    const content = await recognizer.recognize(regionAt(3, MIXED_RECT));

    expect(translation.completeCalls).toHaveLength(1);

    expect(content.route).toBe("vision");
    // 混排区有原文 ⟹ 有 evidence ⟹ 可入库，与纯图的 null 相对。
    expect(content.sourceText).toBe("Figure 1: The Transformer - model architecture.");
    expect(content.translation).toBe("图 1：Transformer —— 模型架构。");
  });
});

describe("Recognizer — 模型给了空回答时", () => {
  it("算 bad-output 而不是 model-unavailable——端点是通的，只是没给出能用的东西", async () => {
    const { recognizer } = await setup("2006.11239.pdf", {
      completeError: new ModelError("empty-response", "模型返回了空回答"),
    });

    const error = await catchRecognizeError(recognizer, regionAt(1, FIGURE_RECT));

    expect(error.kind).toBe("bad-output");
  });

  it("端点不通仍然是 model-unavailable", async () => {
    const { recognizer } = await setup("2006.11239.pdf", {
      completeError: new ModelError("http", "模型端点返回 HTTP 401", { status: 401 }),
    });

    const error = await catchRecognizeError(recognizer, regionAt(1, FIGURE_RECT));

    expect(error.kind).toBe("model-unavailable");
  });
});

describe("Recognizer — 译文由独立的翻译模块产出", () => {
  it("数字 PDF 文本区也有译文，且不碰识别模块", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const recognition = createFakeModelClient();
    const translation = createFakeModelClient({ completeText: "主流的序列转导模型……" });
    const recognizer = createRecognizer({ document, recognition, translation });

    const content = await recognizer.recognize(regionAt(1, ABSTRACT_RECT));

    // CONTEXT.md：摘录持有双语 markdown——逐字的原文、其译文。
    // 焊在一起时补不了这条（补它就要为纯文本区调一次视觉模型）。
    expect(content.route).toBe("text");
    expect(content.translation).toBe("主流的序列转导模型……");
    // 「零成本」收窄后仍然成立：text 路由从不调用识别模块。
    expect(recognition.completeCalls).toHaveLength(0);
    expect(translation.completeCalls).toHaveLength(1);
  });

  it("没配翻译模块就不产出译文——不去麻烦识别模块代劳", async () => {
    const { model, recognizer } = await setup("1706.03762.pdf");

    const content = await recognizer.recognize(regionAt(1, ABSTRACT_RECT));

    expect(content.translation).toBeUndefined();
    expect(model.completeCalls).toHaveLength(0);
  });
});

describe("Recognizer — 纯图区的 sourceText 也要按路由表裁剪", () => {
  it("模型报 image 却回了原文，一律归零——否则纯图能被放行入库", async () => {
    const { recognizer } = await setup("2006.11239.pdf", {
      completeText: JSON.stringify({
        kind: "image",
        // 纯图区里模型有时会把水印、页码之类的碎字当成原文回出来。
        sourceText: "CelebA-HQ",
        multimodal: "四张人脸样本与一格 CIFAR10 样本阵列",
      }),
    });

    const content = await recognizer.recognize(regionAt(1, FIGURE_RECT));

    // 路由表的纯图行 sourceText 是 null，而 null ⟺ 入库 blocked（不变量 5）。
    // 透出去就等于让一条没有 evidence 的纯图摘录混进知识库。
    expect(content.sourceText).toBeNull();
    expect(content.multimodal).toBe("四张人脸样本与一格 CIFAR10 样本阵列");
  });
});

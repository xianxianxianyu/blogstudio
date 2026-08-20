import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { baselineIntersectsRect, textCoverage, TEXT_COVERAGE_THRESHOLD } from "./coverage";
import { ModelError } from "../model/model-client";
import type { ModelClient, ModelResponse } from "../model/model-client";

// canonical 接口见 pdfstudio/docs/recognizer-interface.md

/** 页面坐标，原点左下。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Screenshot {
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** 框选手势天然产出的三样。 */
export interface Region {
  page: number;
  rect: Rect;
  pixels: Screenshot;
  /**
   * 文本流选区的**精确形状**，一行一个矩形（ADR-0016 第二步）。矩形框选不产出它。
   *
   * `rect` 仍是外接矩形，语义不变——`sameRegion` 去重、标签命中、重新识别都还看它。
   * 但从第 1 行中间起、第 3 行中间止的选区，外接矩形会把三行全部盖满：照它画高亮，
   * 首尾两行会涂到根本没选中的地方。**画的和选的必须是同一块。**
   */
  lines?: Rect[];
}

export type Route = "text" | "vision";

export interface Anchor {
  page: number;
  rect: Rect;
}

export interface ClipContent {
  route: Route;
  anchor: Anchor;
  /** 原文逐字；null ⟺ 纯图 ⟺ 入库 blocked。 */
  sourceText: string | null;
  translation?: string;
  multimodal?: string;
  images: Screenshot[];
  screenshot: Screenshot;
}

/** 每个功能各配各的模型端点，见 ADR-0010。 */
export interface RecognizerDeps {
  document: PDFDocumentProxy;
  /** 识别：OCR / 公式 → LaTeX / 图理解。text 路由从不调它。 */
  recognition: ModelClient;
  /**
   * 翻译：独立配置，通常是一个高速文本 LLM（ADR-0010）。
   *
   * **必填，不想要就显式写 `null`。** 写成可选的代价已经付过一次：`app/main.ts` 漏了
   * 它，`translate()` 从此没被调用过，译文永远不出现——而划词翻译是日常主路径。
   * 单元测试抓不到这种漏：每条翻译用例都显式传了 fake，测的是「给了会不会用」，
   * 不是「有没有给」。漏一个就默认关掉的开关，用类型堵死（同 `GUARDS` 那张表）。
   */
  translation: ModelClient | null;
  targetLang?: string;
}

/** rare，可省。`route` 是覆盖检测误判时的逃生口。 */
export interface RecognizeOptions {
  route?: "auto" | "text" | "vision";
  /**
   * 调用方已经逐字拿到了原文（文本层的原生选区），不要再从文字项里拼。
   *
   * **这不是优化，是正确性。** 从文字项拼只能按整个 item 取，而实测一行常常只有一个
   * item 且装着整行 70–103 个字符——「从第 1 行中间起」这种选区，再怎么按几何过滤也
   * 只能拿到整行。字符级的边界只有浏览器知道（ADR-0016 第二步）。
   */
  sourceText?: string;
  targetLang?: string;
  /**
   * 要不要顺手翻译。默认要。
   *
   * **文本路由的原文是免费的（文本层），翻译不是**——它是一次模型调用。ADR-0019 把
   * 「松手即翻译」推翻之后，文字区仍然免费取原文，只是不再自动翻；要译文时由读者
   * 在工具条上要。
   */
  translate?: boolean;
}

export interface Recognizer {
  recognize(region: Region, options?: RecognizeOptions): Promise<ClipContent>;
}

/**
 * 识别失败一律 throw 这个类型：默认调用方只 catch 一次，按 kind 分支。
 * 漏一个裸 SyntaxError 出去，调用方就无从区分「模型不可用」和「输出坏了」。
 *
 * 没有 `model-refused`：拒答回的也是白话、一样解析失败，与坏输出在
 * `ModelResponse`（只有 text，见 ADR-0009）这一层分不开，归入 `bad-output`。
 */
export class RecognizeError extends Error {
  constructor(
    readonly kind: "region-too-small" | "model-unavailable" | "bad-output",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecognizeError";
  }
}

/**
 * 框选区域的最小边长（PDF 点，1pt = 1/72 英寸）。两条边都得够长——
 * 只看面积挡不住「沿行间划过去」拖出的细长条。
 *
 * 4pt 取在任何真实摘录之下：论文最小的脚注字号约 7pt，公式里的上标字形约 5pt，
 * 所以框住单个字符仍然合法。低于它的框装不下任何内容，按误触处理：
 * 既不产出摘录，也不烧掉一次云模型调用（ADR-0005 是用户自配的付费端点）。
 */
const MIN_REGION_SIDE = 4;

/** 逐字：只拼 TextItem 的 str，不纠错、不重排、不裁空格连字符。 */
function joinVerbatim(items: TextItem[]): string {
  return items.map((item) => (item.hasEOL ? `${item.str}\n` : item.str)).join("");
}

/** vision 路由下的四种区域类型，对应 canonical 路由规则表的后四行。 */
export type VisionKind = "formula" | "figure" | "image" | "mixed";

/** 视觉路由的线上格式：prompt 与解析都归 Recognizer 所有，adapter 保持极薄。 */
interface VisionOutput {
  kind?: VisionKind;
  sourceText?: string | null;
  multimodal?: string | null;
}

/**
 * `sourceText === null ⟺ 纯图 ⟺ 入库 blocked`，整条规则由这一个 null 承载。
 * 模型常把「没有原文」回成空串；空串会让 Clip reducer 以为有 evidence 而放行 promote，
 * 所以空白一律归一成 null。
 */
function blankToNull(text: string | null | undefined): string | null {
  return text != null && text.trim() !== "" ? text : null;
}

/**
 * canonical 路由规则表的后四行，只保留「哪一栏该有值」这一维。
 * 出口按它裁剪，约束才不会只活在 prompt 里——模型多回的字段一律丢弃。
 * kind 缺失或不认识就是坏输出：放行等于给模型留一个绕过裁剪的口子。
 */
const VISION_TABLE: Record<
  VisionKind,
  { sourceText: boolean; translation: boolean; multimodal: boolean }
> = {
  formula: { sourceText: true, translation: false, multimodal: false },
  figure: { sourceText: true, translation: false, multimodal: true },
  // 纯图行的 sourceText 是 null，而 null ⟺ 入库 blocked（不变量 5）。模型有时会把
  // 水印、页码之类的碎字当原文回出来，透出去就是让没有 evidence 的摘录混进知识库。
  image: { sourceText: false, translation: false, multimodal: true },
  mixed: { sourceText: true, translation: true, multimodal: true },
};

const DEFAULT_TARGET_LANG = "zh";

/**
 * prompt 按区域类型分支，但识别只调一次：不先分类再调一次（那是两次调用），
 * 而是让模型在同一次回答里报出 kind，出口再按路由表强制。
 * **不索要译文**——翻译是另一个独立配置的功能（ADR-0010），
 * 索要它等于要求识别模型必须会翻译，专用识别模型就此进不来。
 */

const VISION_PROMPT = [
    "读这个区域，判断它属于哪一类，返回 JSON。kind 取 formula | figure | image | mixed。",
    "按这个顺序判定，取第一个成立的：",
    "1. 整块就是一条或几条公式 → formula",
    "2. 区域内除了图题和标签之外还有**成块的文字**（正文段落、算法伪代码、列表）→ mixed。",
    "   图题、表题、图内标签、表格单元格、坐标轴文字都**不算**——图题写满六行也仍然是图题，",
    "   看的是它在不在解释这张图，不是长度。",
    "3. 有图或表，但文字只有图题和图内标签 → figure",
    "4. 连图题和标签都没有 → image",
    "各类型的字段这样填（**不要翻译**，翻译由另一个模块负责）：",
    "- formula（公式区）：sourceText 放 LaTeX（逐字无损编码），multimodal 为 null。",
    "- figure（图/表区）：sourceText 放图内文字（没有就 null），multimodal 放一句话描述。",
    "- image（纯图区）：sourceText 为 null，multimodal 放一句话描述。",
    "- mixed（图文混排区）：sourceText 放原文逐字，multimodal 放一句话描述。",
  ].join("\n");

/**
 * 翻译是独立配置的一个功能（ADR-0010），通常接一个高速文本 LLM。
 * 没配就不产出译文——不去麻烦识别模块代劳，那是另一种活。
 */
async function translate(
  deps: RecognizerDeps,
  sourceText: string | null,
  targetLang: string,
): Promise<string | undefined> {
  if (!deps.translation || sourceText === null) return undefined;

  try {
    const { text } = await deps.translation.complete({
      messages: [
        {
          role: "user",
          content: `把下面的内容译成 ${targetLang}。只回译文本身，不要解释、不要加引号。\n\n${sourceText}`,
        },
      ],
    });
    return blankToNull(text) ?? undefined;
  } catch (cause) {
    // 译文没出来不该让整条摘录作废——原文还在，摘录仍然可用、可入库。
    if (cause instanceof ModelError) return undefined;
    throw cause;
  }
}

export function createRecognizer(deps: RecognizerDeps): Recognizer {
  return {
    async recognize(region: Region, options?: RecognizeOptions): Promise<ClipContent> {
      if (region.rect.width < MIN_REGION_SIDE || region.rect.height < MIN_REGION_SIDE) {
        throw new RecognizeError("region-too-small", "框选区域小到装不下内容，按误触处理");
      }

      const anchor: Anchor = { page: region.page, rect: region.rect };
      const targetLang = options?.targetLang ?? deps.targetLang ?? DEFAULT_TARGET_LANG;
      const page = await deps.document.getPage(region.page);
      const { items } = await page.getTextContent();
      const inRegion = items.filter(
        (item): item is TextItem => "str" in item && baselineIntersectsRect(region.rect, item),
      );
      // 覆盖检测路由：不预分类，量文本覆盖度，低 ⟹ 落视觉。
      // options.route 是逃生口，启发式误判时由调用方强制走某条路。
      const route = options?.route ?? "auto";
      const goesVision =
        route === "vision" ||
        (route === "auto" && textCoverage(region.rect, inRegion) < TEXT_COVERAGE_THRESHOLD);

      if (goesVision) {
        let response: ModelResponse;
        try {
          response = await deps.recognition.complete({
            messages: [
              {
                role: "user",
                content: VISION_PROMPT,
              },
            ],
            // Screenshot 结构上就是 ModelImage 的子集，逐字段手抄只会制造漂移。
            images: [region.pixels],
          });
        } catch (cause) {
          // 端点通了但没给出能用的东西，算坏输出；只有真的调不通才是 model-unavailable。
          const unusable =
            cause instanceof ModelError &&
            (cause.kind === "empty-response" || cause.kind === "malformed-stream");
          throw unusable
            ? new RecognizeError("bad-output", "模型没有给出可用的回答", { cause })
            : new RecognizeError("model-unavailable", "模型调用失败", { cause });
        }

        let output: VisionOutput;
        try {
          output = JSON.parse(response.text) as VisionOutput;
        } catch (cause) {
          throw new RecognizeError("bad-output", "模型没有按约定返回 JSON", { cause });
        }

        const allow = output.kind && VISION_TABLE[output.kind];
        if (!allow) {
          throw new RecognizeError("bad-output", "模型没有报出区域类型");
        }

        // 公式的 LaTeX 也走 sourceText：它是逐字无损编码，公式摘录因此有 evidence、能入库。
        const sourceText = allow.sourceText ? blankToNull(output.sourceText) : null;

        return {
          route: "vision",
          anchor,
          sourceText,
          // 译文一律由翻译模块产出，识别模型顺手回的那份不采纳（ADR-0010）。
          // 路由表的 translation 一栏现在管的是「要不要调翻译模块」——公式区不翻，
          // 翻 LaTeX 没有意义。
          translation:
            allow.translation && options?.translate !== false
              ? await translate(deps, sourceText, targetLang)
              : undefined,
          multimodal: allow.multimodal ? (output.multimodal ?? undefined) : undefined,
          images: [region.pixels],
          screenshot: region.pixels,
        };
      }

      // 这里也归一：强制 route: 'text' 打在无字区域上会拼出空串，
      // 而 '' 不是 null，会让 Clip reducer 以为有 evidence 而放行 promote。
      const sourceText = blankToNull(options?.sourceText ?? joinVerbatim(inRegion));

      return {
        route: "text",
        anchor,
        sourceText,
        translation: options?.translate === false ? undefined : await translate(deps, sourceText, targetLang),
        images: [],
        screenshot: region.pixels,
      };
    },
  };
}

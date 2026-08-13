import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
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

export interface RecognizerDeps {
  document: PDFDocumentProxy;
  model: ModelClient;
  targetLang?: string;
}

/** rare，可省。`engine` 是覆盖检测误判时的逃生口。 */
export interface RecognizeOptions {
  engine?: "auto" | "text" | "vision";
  targetLang?: string;
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
 * 行归属规则：基线线段与框相交。
 *
 * 不用 `[y, y+height]` 当行框——pdf.js 的 `transform[5]` 是基线、`height` 是字号
 * （整个字号都算在基线之上），行框会顶进下一行。基线没有这个歧义。
 * `width` 沿基线方向而非水平方向，所以线段终点要按 transform 的旋转量走，
 * 否则页边那条竖排的 arXiv 戳会被算成一条横跨半页的文字。
 */
function baselineIntersectsRect(rect: Rect, item: TextItem): boolean {
  const [a, b, , , x, y] = item.transform;
  const length = Math.hypot(a, b) || 1;
  const endX = x + (item.width * a) / length;
  const endY = y + (item.width * b) / length;

  return (
    Math.min(x, endX) <= rect.x + rect.width &&
    Math.max(x, endX) >= rect.x &&
    Math.min(y, endY) <= rect.y + rect.height &&
    Math.max(y, endY) >= rect.y
  );
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

/**
 * 覆盖度阈值。目前只按 eval 的三个样本标定：
 * 正文段落 87.2%、公式 f05 30.8%、纯图 g01 0%。
 * 公式在 LaTeX PDF 的文本层是有 item 的（抽出来是扁的，分式和上标全丢），
 * 靠「有没有字」区分不了，只能靠覆盖度。字符密度维度等有测试需要时再加。
 */
const TEXT_COVERAGE_THRESHOLD = 0.5;

/** 文本包围盒面积占框的比例。暂不做并集去重，重叠的 item 会把占比抬高。 */
function textCoverage(rect: Rect, items: TextItem[]): number {
  const textArea = items.reduce((sum, item) => sum + item.width * item.height, 0);
  return textArea / (rect.width * rect.height);
}

/** 逐字：只拼 TextItem 的 str，不纠错、不重排、不裁空格连字符。 */
function joinVerbatim(items: TextItem[]): string {
  return items.map((item) => (item.hasEOL ? `${item.str}\n` : item.str)).join("");
}

/** vision 路由下的四种区域类型，对应 canonical 路由规则表的后四行。 */
type VisionKind = "formula" | "figure" | "image" | "mixed";

/** 视觉路由的线上格式：prompt 与解析都归 Recognizer 所有，adapter 保持极薄。 */
interface VisionOutput {
  kind?: VisionKind;
  sourceText?: string | null;
  translation?: string | null;
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
const VISION_TABLE: Record<VisionKind, { translation: boolean; multimodal: boolean }> = {
  formula: { translation: false, multimodal: false },
  figure: { translation: false, multimodal: true },
  image: { translation: false, multimodal: true },
  mixed: { translation: true, multimodal: true },
};

/**
 * prompt 按区域类型分支——但只有一次调用：不先分类再选 prompt（那是两次，
 * 违反「恰好一次」），而是让模型在同一次回答里报出 kind，出口再按路由表强制。
 */
const DEFAULT_TARGET_LANG = "zh";

const visionPrompt = (targetLang: string) =>
  [
    "读这个区域，判断它属于哪一类，返回 JSON。kind 取 formula | figure | image | mixed，",
    "其余字段按类型填：",
    "- formula（公式区）：sourceText 放 LaTeX（逐字无损编码），translation 与 multimodal 一律 null。",
    "- figure（图/表区）：sourceText 放图内文字（没有就 null），translation 为 null，multimodal 放一句话描述。",
    "- image（纯图区）：sourceText 与 translation 一律 null，multimodal 放一句话描述。",
    `- mixed（图文混排区）：sourceText 放原文逐字，translation 放原文译成 ${targetLang} 的结果，multimodal 放一句话描述。`,
  ].join("\n");

export function createRecognizer(deps: RecognizerDeps): Recognizer {
  return {
    async recognize(region: Region, options?: RecognizeOptions): Promise<ClipContent> {
      if (region.rect.width < MIN_REGION_SIDE || region.rect.height < MIN_REGION_SIDE) {
        throw new RecognizeError("region-too-small", "框选区域小到装不下内容，按误触处理");
      }

      const anchor: Anchor = { page: region.page, rect: region.rect };
      const page = await deps.document.getPage(region.page);
      const { items } = await page.getTextContent();
      const inRegion = items.filter(
        (item): item is TextItem => "str" in item && baselineIntersectsRect(region.rect, item),
      );
      // 覆盖检测路由：不预分类，量文本覆盖度，低 ⟹ 落视觉。
      // options.engine 是逃生口，启发式误判时由调用方强制走某条路。
      const engine = options?.engine ?? "auto";
      const goesVision =
        engine === "vision" ||
        (engine === "auto" && textCoverage(region.rect, inRegion) < TEXT_COVERAGE_THRESHOLD);

      if (goesVision) {
        let response: ModelResponse;
        try {
          response = await deps.model.complete({
            messages: [
              {
                role: "user",
                content: visionPrompt(
                  options?.targetLang ?? deps.targetLang ?? DEFAULT_TARGET_LANG,
                ),
              },
            ],
            // Screenshot 结构上就是 ModelImage 的子集，逐字段手抄只会制造漂移。
            images: [region.pixels],
          });
        } catch (cause) {
          throw new RecognizeError("model-unavailable", "模型调用失败", { cause });
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

        return {
          route: "vision",
          anchor,
          // 公式的 LaTeX 也走 sourceText：它是逐字无损编码，公式摘录因此有 evidence、能入库。
          sourceText: blankToNull(output.sourceText),
          translation: allow.translation ? (output.translation ?? undefined) : undefined,
          multimodal: allow.multimodal ? (output.multimodal ?? undefined) : undefined,
          images: [region.pixels],
          screenshot: region.pixels,
        };
      }

      return {
        route: "text",
        anchor,
        // 这里也归一：强制 engine: 'text' 打在无字区域上会拼出空串，
        // 而 '' 不是 null，会让 Clip reducer 以为有 evidence 而放行 promote。
        sourceText: blankToNull(joinVerbatim(inRegion)),
        images: [],
        screenshot: region.pixels,
      };
    },
  };
}

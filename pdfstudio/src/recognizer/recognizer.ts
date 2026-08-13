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

export interface Recognizer {
  recognize(region: Region): Promise<ClipContent>;
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
    readonly kind: "model-unavailable" | "bad-output",
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
function isInRegion(rect: Rect, item: TextItem): boolean {
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

/** 视觉路由的线上格式：prompt 与解析都归 Recognizer 所有，adapter 保持极薄。 */
interface VisionOutput {
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

const VISION_PROMPT =
  "读这个区域，返回 JSON：sourceText 放区域内的原文逐字（公式用 LaTeX；纯图为 null），" +
  "translation 放原文的中文译文（无原文为 null），" +
  "multimodal 放图/表的一句话描述（无图为 null）。";

export function createRecognizer(deps: RecognizerDeps): Recognizer {
  return {
    async recognize(region: Region): Promise<ClipContent> {
      const anchor: Anchor = { page: region.page, rect: region.rect };
      const page = await deps.document.getPage(region.page);
      const { items } = await page.getTextContent();
      const inRegion = items.filter(
        (item): item is TextItem => "str" in item && isInRegion(region.rect, item),
      );
      // 覆盖检测路由：不预分类，量文本覆盖度，低 ⟹ 落视觉。
      if (textCoverage(region.rect, inRegion) < TEXT_COVERAGE_THRESHOLD) {
        let response: ModelResponse;
        try {
          response = await deps.model.complete({
            messages: [{ role: "user", content: VISION_PROMPT }],
            images: [
              {
                mime: region.pixels.mime,
                bytes: region.pixels.bytes,
                width: region.pixels.width,
                height: region.pixels.height,
              },
            ],
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

        return {
          route: "vision",
          anchor,
          // 公式的 LaTeX 也走 sourceText：它是逐字无损编码，公式摘录因此有 evidence、能入库。
          sourceText: blankToNull(output.sourceText),
          translation: output.translation ?? undefined,
          multimodal: output.multimodal ?? undefined,
          images: [],
          screenshot: region.pixels,
        };
      }

      return {
        route: "text",
        anchor,
        sourceText: joinVerbatim(inRegion),
        images: [],
        screenshot: region.pixels,
      };
    },
  };
}

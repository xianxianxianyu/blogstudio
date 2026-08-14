import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
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
  /** 翻译：独立配置，通常是一个高速文本 LLM。不配就不产出译文。 */
  translation?: ModelClient;
  targetLang?: string;
}

/** rare，可省。`route` 是覆盖检测误判时的逃生口。 */
export interface RecognizeOptions {
  route?: "auto" | "text" | "vision";
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
 * 覆盖度阈值。0.5 落在实测数据的谷底：
 *
 *   落 text  正文段落 89.2%
 *   —— 谷 ——
 *   落 vision 图内密集标签 m01 40.0%、叠绘的图 38.7%、公式 f05 30.3%、混排 m02 15.2%、纯图 0%
 *
 * 公式在 LaTeX PDF 的文本层是有 item 的（抽出来是扁的，分式和上标全丢），
 * 靠「有没有字」区分不了，只能靠覆盖度。
 *
 * 已知薄弱面：框得越松覆盖度越低，Abstract 段落四周各留 40pt 白时降到 54.9%，
 * 再松就会误判成 vision。逃生口是 `options.route = 'text'`。
 * canonical 还写了「非空白字符密度」这第二维，实测**加不了分**：唯一逼近正文的
 * vision 样本是 m01（密度 11.64），而松散框选的正文密度 11.44——两者在密度上反而
 * 交叠，在覆盖度上却分得开（40.0% vs 54.9%）。没有反例就不加维。
 */
const TEXT_COVERAGE_THRESHOLD = 0.5;

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** item 的包围盒，裁到框内；完全在框外返回 null。 */
function clippedBox(rect: Rect, item: TextItem): Box | null {
  const [a, b, , , x, y] = item.transform;
  const length = Math.hypot(a, b) || 1;
  const endX = x + (item.width * a) / length;
  const endY = y + (item.width * b) / length;

  const x0 = Math.max(Math.min(x, endX), rect.x);
  const x1 = Math.min(Math.max(x, endX), rect.x + rect.width);
  const y0 = Math.max(Math.min(y, endY), rect.y);
  const y1 = Math.min(Math.max(y, endY) + item.height, rect.y + rect.height);

  return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
}

/**
 * 包围盒**并集**的面积，按 x 方向切板、每板合并 y 区间。
 * 求和会把叠绘的文字重复计数——attention 可视化那类图会因此虚高到 text 路由。
 */
function unionArea(boxes: Box[]): number {
  const edges = [...new Set(boxes.flatMap((box) => [box.x0, box.x1]))].sort((p, q) => p - q);
  let area = 0;

  for (let i = 0; i < edges.length - 1; i++) {
    const [left, right] = [edges[i], edges[i + 1]];
    const spans = boxes
      .filter((box) => box.x0 <= left && box.x1 >= right)
      .map((box) => [box.y0, box.y1] as const)
      .sort((p, q) => p[0] - q[0]);

    let covered = 0;
    let start: number | null = null;
    let end = 0;
    for (const [spanStart, spanEnd] of spans) {
      if (start === null) {
        [start, end] = [spanStart, spanEnd];
      } else if (spanStart > end) {
        covered += end - start;
        [start, end] = [spanStart, spanEnd];
      } else if (spanEnd > end) {
        end = spanEnd;
      }
    }
    if (start !== null) covered += end - start;
    area += (right - left) * covered;
  }

  return area;
}

/** 文本包围盒并集的面积占框的比例。 */
function textCoverage(rect: Rect, items: TextItem[]): number {
  const boxes = items
    .map((item) => clippedBox(rect, item))
    .filter((box): box is Box => box !== null);
  return unionArea(boxes) / (rect.width * rect.height);
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
          translation: allow.translation ? await translate(deps, sourceText, targetLang) : undefined,
          multimodal: allow.multimodal ? (output.multimodal ?? undefined) : undefined,
          images: [region.pixels],
          screenshot: region.pixels,
        };
      }

      // 这里也归一：强制 route: 'text' 打在无字区域上会拼出空串，
      // 而 '' 不是 null，会让 Clip reducer 以为有 evidence 而放行 promote。
      const sourceText = blankToNull(joinVerbatim(inRegion));

      return {
        route: "text",
        anchor,
        sourceText,
        translation: await translate(deps, sourceText, targetLang),
        images: [],
        screenshot: region.pixels,
      };
    },
  };
}

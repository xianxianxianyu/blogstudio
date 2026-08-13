# Recognizer 设计 ——「一次调用，一个返回值」（为 截图→摘录 压到零仪式）

> 竞争设计之一。姊妹篇：`design-recognizer-1-extensible.md`（宽而平）、`design-recognizer-2-minimal.md`（深而窄）。

## 1. 接口 (Interface)

整个模块对外一个方法、一个必填参数、一个返回值。依赖在构造时绑定一次，每次摘录不出现。

```ts
// 输入
interface Rect { x: number; y: number; width: number; height: number }  // 页面坐标，原点左下
interface Screenshot { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array; width: number; height: number }
interface Region { page: number; rect: Rect; pixels: Screenshot }  // 框选手势天然产出的三样

// 输出
type Route = 'text' | 'vision';
interface Anchor { page: number; rect: Rect }
interface ClipContent {
  route: Route;
  anchor: Anchor;          // Region 的 page+rect 原样回显
  sourceText: string;      // 原文逐字；纯图 = ''
  translation?: string;    // 仅 vision 路由产出
  multimodal?: string;     // 图/表 → 一句话描述（公式的 LaTeX 归 sourceText）
  images: Screenshot[];    // 抠出的图
  screenshot: Screenshot;  // 整块区域截图（ground truth）= pixels 回显
}

// 选项（rare needs，可省）
interface RecognizeOptions { engine?: 'auto' | 'text' | 'vision'; targetLang?: string }

// 依赖与端口（只出现在构造处）
interface ModelClient { complete(req: { messages: {role:'user'|'assistant';content:string}[]; images: Screenshot[] }): Promise<{ text: string }> }
interface RecognizerDeps { document: PDFDocumentProxy; model: ModelClient; targetLang?: string }

class RecognizeError extends Error { kind: 'model-unavailable' | 'model-refused' | 'bad-output' }

interface Recognizer { recognize(region: Region, options?: RecognizeOptions): Promise<ClipContent> }
function createRecognizer(deps: RecognizerDeps): Recognizer
```

**路由规则表：**

| 区域类型 | route | sourceText（原文） | translation | multimodal | images |
|---|---|---|---|---|---|
| 数字 PDF 文本区 | `text` | pdf.js 逐字抽取 | — | — | `[]` |
| 公式区 | `vision` | **LaTeX**（逐字无损编码） | — | — | `[区域截图]` |
| 图/表区 | `vision` | 图内文字（常 `''`） | — | 一句话描述 | `[区域截图]` |
| 纯图区 | `vision` | `''` | — | 一句话描述 | `[区域截图]` |
| 图文混排区 | `vision` | OCR 文字 | 翻译 | 描述/LaTeX | `[区域截图]` |

**不变量：** ① 逐字（`text` 路由的 sourceText 只拼 item、不改写）；② 零成本（`route==='text'` ⟹ 从未调 `model.complete`）；③ 恰好一次（`route==='vision'` ⟹ 恰好一次 model call）；④ 纯读（可并发，无共享可变状态）；⑤ 纯图不裁决（`sourceText===''` ⟹ 入库 blocked 由 `Clip` reducer 判定，Recognizer 只产数据）。

**顺序：** 文本层覆盖检测严格先于任何模型调用。`auto` 下先 `getTextContent()` 判覆盖，达标直接返回 `text`；不足才进 vision。

**错误：** `text` 路由基本不失败（强制 `text` 但无字 → 返回 `''` 不抛错）；`vision` 失败 reject `RecognizeError`（model-unavailable / model-refused / bad-output）。

**性能：** `text` 毫秒级（对已缓存页调 `getTextContent`）；`vision` 秒级，发送前降采样/裁剪控 token。

## 2. 用法示例 (Usage)

```ts
// 打开 PDF 时（一次）
const recognizer = createRecognizer({ document: pdfDoc, model: modelClient }); // targetLang 默认 'zh'

// 框选手势（每次摘录）
async function onRegionCaptured(sel) {
  dispatch({ type: 'capture' });                        // Clip → recognizing
  try {
    const content = await recognizer.recognize(sel);    // 完整 ClipContent 就位
    dispatch({ type: 'recognized', content });          // Clip → 待编辑
  } catch (err) {
    dispatch({ type: 'recognize-failed', error: err });
  }
}

// rare 逃生口
await recognizer.recognize(region, { engine: 'vision' });   // 覆盖启发式误判时强制走模型
```

## 3. 藏在实现后面的是什么 (Hidden implementation)

- **路由 = 文本层覆盖检测，而非「这是什么区域」的预分类。** 用 `getTextContent()` 的 `TextItem`（transform → 包围盒 → 与 rect 求交）算两个量：文本包围盒并集面积占比（覆盖度）与非空白字符密度。覆盖达标 → `text`；否则 → `vision`。这一条规则同时吞掉「文字/公式/纯图/扫描件」的区分——数字 PDF 的公式和纯图在文本层里没有 item，覆盖度自然塌到零、自动落 vision；图文混排覆盖不足也正确落 vision。
- **逐字组装**：命中 item 按阅读顺序（y 降序、x 升序）依 `hasEOL` 拼成行。
- **一次模型调用 = 读图 + 翻译 + LaTeX/描述**：一条消息、要求回 JSON `{kind, sourceText, translation, multimodal}`，解析/校验/归一化全在内部。`formula` 的 LaTeX 写入 `sourceText`，`figure/table` 描述写入 `multimodal`。
- **图片预处理**：按需降采样 + `detail: original`（research [S11]）。
- **回显免组装**：`pixels`→`screenshot`、`page+rect`→`anchor`，调用方拿到成品。
- **内部缝**：覆盖检测、逐字组装、prompt 组装、JSON 解析各自私有，只被自己的测试穿过。

## 4. 依赖策略与 adapter (Dependency strategy)

- **pdf.js —— category 1（in-process）**：不做 port，`PDFDocumentProxy` 只在构造缝出现一次，测试用 fixture PDF 直测 `recognize`。
- **ModelClient —— category 4（true external）**：真缝。窄端口 `complete({messages, images}) → {text}`；生产 = OpenAI 兼容 HTTP adapter（ADR-0005），测试 = mock adapter。Recognizer 拥有 prompt 组装与 JSON 解析，adapter 保持极薄。
- 对外缝 = `recognize`；pdf.js 与 ModelClient 是内部缝，不暴露。

## 5. 取舍 (Trade-offs)

**杠杆高：** 双引擎路由 + 逐字组装 + 一次模型调用 + 输出归一化，压进「一个函数一个参数」。覆盖检测吞掉整个「文字还是图片」决策——一次实现偿还 N 调用点。返回完整 `ClipContent`（含回显）把组装仪式从调用方拿走。

**薄（诚实标注）：** `images`（抠图）v1 = `[区域截图]` / `[]`，深版（pdf.js operator list 抠原始嵌入图）推迟，字段已定、加深不改接口。错误处理单 `RecognizeError`，happy path 一个 `catch`。progress 刻意缺席——pending Promise 就是进度。

**激进点与代价：** ① 不返回 Result、直接 throw（默认调用方只 catch 一次）；② 不提供 batching（调用方 `Promise.all` 自行组合）；③ 公式 LaTeX 归 `sourceText` 而非 `multimodal`——对 ADR「formula→LaTeX」措辞的有意收紧，使公式摘录有 sourceText、能入库；④ 覆盖阈值是魔法常数——误判时唯一出路 `engine:'vision'`，缓解：阈值可调 + 用 19 张样本 fixture 覆盖 + 保留逃生口。

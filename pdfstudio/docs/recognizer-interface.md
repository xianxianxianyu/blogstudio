# Recognizer 接口（定稿）

> **胜出方案**：D3（覆盖检测路由，`design-recognizer-3-common-caller.md`）+ D2 的 `source === null`（`design-recognizer-2-minimal.md`）。候选集：`design-recognizer-1/2/3-*.md`。本文件是 canonical 接口，实现时以它为准。

## 接口

```ts
// —— 输入 ——
interface Rect { x: number; y: number; width: number; height: number }   // 页面坐标，原点左下
interface Screenshot { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array; width: number; height: number }
interface Region { page: number; rect: Rect; pixels: Screenshot }         // 框选手势天然产出的三样

// —— 输出 ——
type Route = 'text' | 'vision';
interface Anchor { page: number; rect: Rect }

interface ClipContent {
  route: Route;
  anchor: Anchor;            // page+rect 原样回显
  sourceText: string | null; // 原文逐字；null ⟺ 纯图 ⟺ 入库 blocked
  translation?: string;      // 由独立的翻译模块产出（ADR-0010），两条路由都可能有
  multimodal?: string;       // 图/表 → 一句话描述（公式的 LaTeX 不在此，见下方决策）
  images: Screenshot[];      // 抠出的图
  screenshot: Screenshot;    // 整块区域截图（ground truth）= pixels 回显
}

// —— 选项（rare，可省）——
interface RecognizeOptions {
  engine?: 'auto' | 'text' | 'vision';   // 默认 'auto'
  targetLang?: string;                    // 默认取构造配置 'zh'
}

// —— 共享模型契约 ——
// ModelMessage / ModelImage / ModelRequest / ModelResponse / ModelChunk / ModelClient
// 统一见 ADR-0009；Recognizer 只使用 complete(request)，不使用 streamComplete。
// 每个功能各配各的模型端点，见 ADR-0010。识别与翻译共享 ModelClient 契约，差异只在注入哪个实例。
interface RecognizerDeps {
  document: PDFDocumentProxy;
  recognition: ModelClient;          // OCR / 公式 → LaTeX / 图理解；text 路由从不调它
  translation?: ModelClient;         // 独立配置的翻译模块；不配就不产出译文
  targetLang?: string;
}

class RecognizeError extends Error { kind: 'region-too-small' | 'model-unavailable' | 'bad-output' }

// —— 模块 ——
interface Recognizer { recognize(region: Region, options?: RecognizeOptions): Promise<ClipContent> }
function createRecognizer(deps: RecognizerDeps): Recognizer
```

## 路由规则表

| 区域类型 | route | sourceText（原文） | translation | multimodal | images |
|---|---|---|---|---|---|
| 数字 PDF 文本区 | `text` | pdf.js 逐字抽取 | 翻译模块 | — | `[]` |
| 公式区 | `vision` | **LaTeX**（逐字无损编码） | — | — | `[区域截图]` |
| 图/表区 | `vision` | 图内文字（常 `null`） | — | 一句话描述 | `[区域截图]` |
| 纯图区 | `vision` | `null` | — | 一句话描述 | `[区域截图]` |
| 图文混排区 | `vision` | OCR 文字 | 翻译模块 | 描述 | `[区域截图]` |

## 不变量

1. **逐字**：`text` 路由的 `sourceText` 只拼 `TextItem`、不改写（不纠错/重排/裁空格连字符）。
2. **零成本**：`route === 'text'` ⟹ 从未调**识别模块**，`multimodal` 为 `undefined`。译文另由翻译模块产出（ADR-0010 收窄了这一条）。
3. **至多一次**：每个模块对一个区域至多调用一次。`route === 'text'` 时识别模块零次、翻译模块至多一次；`route === 'vision'` 时识别模块恰好一次、翻译模块至多一次。（原文是「恰好一次 `model.complete`」，它把识别和翻译焊成了一次调用，见 ADR-0010。）
4. **纯读**：`recognize` 不改 region/document，可并发，无共享可变状态。
5. **纯图不裁决**：`sourceText === null` ⟹ 入库 blocked，由 `Clip` reducer 判定，Recognizer 只产数据。

## 关键设计决策

- **覆盖检测路由**：不预分类。`getTextContent()` 量文本覆盖度（文本包围盒并集面积占比 + 非空白字符密度），高 → `text`，低/0 → `vision`。纯图在文本层无 item，覆盖度塌 0、落视觉；**公式不然**——LaTeX 生成的 PDF 会把数学字形放进文本层，公式区照样有 item，只是抽出来是扁的（`Attention(Q, K, V ) = softmax( QKT√dk)V`，分式与上标全丢），靠覆盖度低而非「无 item」落视觉。实测：落 text 的正文段落 89.2%；落 vision 的图内密集标签 m01 40.0%、叠绘的图 38.7%、公式 f05 30.3%、混排 m02 15.2%、纯图 g01 0%——阈值 0.5 在这条谷里。

面积必须取**并集**而非求和：attention 可视化那类图会把同一批词反复叠绘，求和会重复计数、把区域虚高进 text 路由（p.13 那处求和 52.1%、并集 38.7%）。三篇论文 22265 个候选区域里求和与并集在 0.5 处分歧仅 2 处，都是这一类。

text 一侧另用 poppler 版面分析（独立于 pdf.js）采了 326 个真实段落 block 验证：紧贴框选时中位数 72.2%，落在 0.5 以下的 8.3% 全是公式推导、表格、算法伪代码和含行内公式的段落——路由表本来就要它们走 vision，判对了。敏感面是**小区域被框得松**，逃生口是 `options.engine`。

canonical 原写的第二维「非空白字符密度」实测加不了分：唯一逼近正文的 vision 样本 m01 密度 11.64，而松散框选的正文密度 11.44——密度上交叠，覆盖度上反而分得开。没有反例就不加维。
- **LaTeX 归原文**：公式的 LaTeX 是逐字无损编码，写入 `sourceText` 而非 `multimodal`——使公式摘录有 evidence、能入库。这修正了早期 brief 里「formula→LaTeX 进描述」的措辞（见 ADR-0001）。
- **`null` 编码可入库性**：`sourceText === null ⟺ 纯图 ⟺ 入库 blocked`，单个 `null` 承载整条规则，不另设 `kind` 字段泄漏给调用方。
- **回显免组装**：`pixels`→`screenshot`、`page+rect`→`anchor`，调用方拿到完整 `ClipContent`，不再把手势产物粘回去。
- **误触先挡掉**：`rect` 任一边短于 4pt 就抛 `region-too-small`，在读 PDF 和调模型之前。4pt 取在任何真实摘录之下（脚注约 7pt、公式上标约 5pt），所以框住单个字符仍然合法；只看面积不行，沿行间划过去的细长条面积可以很大。挡掉的既是无内容的摘录，也是一次白烧的云模型调用。
- **figure 与 mixed 的边界靠判定顺序划清**：一张带图题和标签的架构图，两边都说得通，模型据此摇摆——同一张图两次跑分到不同类，导致「同一个摘录截两次，译文栏可能有也可能没有」。prompt 里给出四步判定顺序，并明确**图题不算文字内容**（写满六行也仍是图题，看的是它在不在解释这张图）、而算法伪代码和列表**算**（`混排` 按 CONTEXT.md 就是图与文字混在一起，不限于正文段落）。实测 19/19 与 manifest 一致，见 `eval/run-recognizer.ts`。
- **路由表在出口强制，不只写进 prompt**：vision 的四种区域类型（公式/图表/纯图/混排）由模型在**同一次** `complete` 里报出（不先分类再调一次，那是多余的一轮），Recognizer 按上表裁剪——公式区的 `multimodal` 一律丢弃，模型多回了也不透出去。模型不报类型即 `bad-output`：放行等于给它留一个绕过裁剪的口子。译文栏现在管的是**要不要调翻译模块**（公式区不调——翻 LaTeX 没有意义），而不是「模型回的字段留不留」。
- **识别 prompt 不索要译文**：索要它等于要求识别模型必须会翻译，PaddleOCR-VL 这类只认六个固定 prompt 的专用识别模型就此进不来（见 `research-local-ocr-engine.md`）。翻译是独立配置的功能，通常接一个高速文本 LLM——这也顺带补上了「数字 PDF 文本区一直没有译文」这个缺口，而那是最常见的摘录类型。
- **throw 而非 Result**：默认调用方只 `catch` 一次；返回并集类型会逼每个调用点做模式匹配。
- **没有 `model-refused`**：早期 kind 联合里有它，实现时删掉了——拒答回的也是白话、一样解析失败，与坏输出在 `ModelResponse`（只有 `text`，见 ADR-0009）这一层根本分不开。要区分就得往共享契约里加 `refusal` 字段，而第三方 OpenAI-compatible 端点常常不返回它，加了也大半降级成 `bad-output`。宁可少一个假装能区分的 kind。候选文档 `design-recognizer-3-common-caller.md` 和 `design-chat-1-common-caller.md` 里仍留着三个 kind 的写法，那是探索记录，不再是接口。
- **不做**流式 / 批量 / 取消：pending Promise 就是进度；批量 = 调用方 `Promise.all`；取消 = 忽略（纯被动，一次一个区域）。若将来流式成硬需求，升级路径见 `design-recognizer-1-extensible.md`。
- **逃生口**：`options.engine = 'vision' | 'text'`，覆盖启发式误判时强制走某条路。强制 `text` 打在无字区域上，`sourceText` 是 **`null` 而非 `''`**——候选文档 `design-recognizer-3-common-caller.md` 写的是「返回 `''` 不抛错」，但不变量 5 是 canonical：`''` 不是 `null`，会让 Clip reducer 以为有 evidence 而放行入库。两条路由的空白原文一律归一成 `null`。

## 依赖策略

- **pdf.js —— category 1（in-process）**：不做 port，`PDFDocumentProxy` 只在构造缝出现；测试用 fixture PDF 直测 `recognize`。
- **ModelClient —— category 4（true external）**：真缝（HTTP adapter + mock adapter），共享契约见 ADR-0009。Recognizer 拥有 prompt 组装与 JSON 解析，adapter 保持极薄。Recognizer 只调用 `complete`；`streamComplete` 供 Chat 使用。
- 对外缝 = `recognize`；覆盖检测、逐字组装、prompt 组装、JSON 解析是内部缝。

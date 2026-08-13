# OCR 引擎研究 — PDF 渲染 + 文本层，以及云端多模态模型

- **范围：** PDF Studio 混合 OCR 引擎的两个问题（见 `adr/0001-hybrid-ocr-engine.md`）。
- **方法：** 仅用一手来源——官方 npm registry 元数据、厂商 GitHub/源码文件、第一方 API 文档（`developers.openai.com`、`platform.claude.com`、`ai.google.dev` 的 `*.md` / `llms.txt` 镜像）。没有博客总结，没有第三方基准聚合站。
- **检索时间：** 2026-08-13。除注明外，价格均为每 1M token 的美元价。
- **引用键：** `[S1]…[S26]` 对应 [Sources](#sources) 里的 URL。没有引用的论断是我自己的分析，不是一手来源事实。

> ⚠️ 环境说明：模型格局已经超出了任务里提到的名字。GPT-4o 仍在服务，但在 OpenAI 目录里已是遗留价位；Anthropic 当前产品线是 Claude Opus 5 / Sonnet 5（外加 Haiku 4.5）；Google 当前产品线是 Gemini 3.x Flash/Pro 加上 Gemini 2.5 Pro/Flash。本文报告各厂商文档**现在**怎么说，并锚定到仍存在的具名模型家族。

---

## 问题 1 — Next.js + Cloudflare (vinext) 上的 PDF 渲染 + 文本层抽取

### 1.1 真正的选择是引擎，不是 React 壳

| 包 | 最新 | 许可 | 是什么 | 运行时依赖 |
| --- | --- | --- | --- | --- |
| `pdfjs-dist` (pdf.js) | 6.2.108 | Apache-2.0 | Mozilla 的 PDF 解析 + 渲染 + 文本抽取引擎 | 无 `[S1]` |
| `react-pdf` | 10.4.1 | MIT | 基于 `pdfjs-dist` 5.4.296 的 React **壳** | `pdfjs-dist`、`clsx`、`dequal` 等 `[S2]` |
| `mupdf` / `mupdf-js` | 1.28.0 / 2.0.1 | **AGPL-3.0-or-later** | 编译成 WebAssembly 的 MuPDF | — `[S9]` |
| `pdfium-wasm` | 0.0.2 | ISC | PDFium 的 WASM 构建（已停滞） | — `[S9]` |
| `@hyzyla/pdfium` | 2.1.13 | MIT | 社区 "Universal wrapper for PDFium"（单人维护） | — `[S9]` |
| `pdf-lib` | 1.17.1 | MIT | "Create and modify PDF files"——**无渲染、无文本抽取** | — `[S9]` |

关键结构点：**`react-pdf` 不是独立引擎。** 它自己的 npm 描述是 "Display PDFs in your React app as easily as if they were images" `[S2]`，并把 `pdfjs-dist: 5.4.296` 声明为直接依赖 `[S2]`。其 README 说 "Browser compatibility for React-PDF primarily depends on PDF.js support"，并说明必须配置 PDF.js worker 才能工作 `[S8]`。所以 "pdf.js vs react-pdf" 是伪命题——两者跑的是同一个引擎。真正的引擎对比是 **pdf.js vs MuPDF vs PDFium**。

### 1.2 渲染保真度与出身

- pdf.js 是 "general-purpose, web standards-based platform for parsing and rendering PDFs"，"community-driven and supported by Mozilla" `[S4]`。
- "PDF.js is part of Firefox since version 19" `[S5]`——它是 Firefox 内置查看器背后的引擎，这是渲染保真度和长期维护的最强一手来源信号。
- MuPDF 的 npm 包是 AGPL-3.0-or-later `[S9]`——一个会迫使 PDF Studio 承担源码披露义务的 copyleft 许可（相比 Apache-2.0 是不想要的约束）。PDFium 的 WASM 选项要么停滞（`pdfium-wasm` 0.0.2）要么是单人维护的壳（`@hyzyla/pdfium`）`[S9]`。

### 1.3 区域文本抽取（决定此事的那个需求）

pdf.js 暴露的正是混合引擎需要的 API：

- `page.getTextContent()` 返回一个 `TextContent`，其 `items` 是 `TextItem` 对象。每个 `TextItem` 携带：
  - `str`（文本 run），
  - `transform`——**变换矩阵**（该项在 PDF 用户空间中的位置），
  - `width` / `height`（设备空间），
  - `fontName`、`dir`、`hasEOL` `[S6]`。
- 因为每个 item 都携带 `transform`，可以算出它在页面上的包围盒，并对任意截取区域的页面坐标过滤（经 `page.getViewport({ scale })` 缩放）。这正是"抽取任意页面区域下的文本" `[S6]`。不涉及像素 OCR——是精确的文本层抽取，对应 ADR 里"精确、免费、即时"的文字路径。
- 官方 Node 示例 `examples/node/getinfo.mjs` 证明文本抽取**无需 canvas、无需 DOM** 即可运行——它导入 `getDocument`，调用 `page.getViewport(...)` 和 `page.getTextContent()`，在纯 Node 里打印字符串 `[S7]`。

`react-pdf` 或任何 PDFium/MuPDF 壳都没有添加专门的区域抽取 API；无论选谁，区域逻辑都是我们自己写，而 pdf.js 是三个引擎里唯一把逐项位置数据写进公开 API typedef 文档的 `[S6]`。

### 1.4 包体积与 edge/server 兼容性

在 jsDelivr CDN 提供的官方 `pdfjs-dist@6.2.108` 构建文件上实测 `[S10]`：

| 文件 | 原始 | gzip |
| --- | --- | --- |
| `build/pdf.mjs` (API) | 853 KB | 174 KB |
| `build/pdf.worker.mjs` (parser) | 2.22 MB | 471 KB |
| `build/pdf.min.mjs` | 455 KB | 130 KB |
| `build/pdf.worker.min.mjs` | 1.26 MB | 373 KB |

Minified 合计 ≈ **500 KB gzipped**（130 KB API + 373 KB worker）。worker 是解析所必需的，但可以拆出并懒加载 `[S8]`。

与 Cloudflare Workers ("vinext") 部署相关的事实：

- **渲染需要 canvas**——Cloudflare Workers 没有 DOM/canvas，所以页面*渲染*必须在浏览器里跑（客户端）。这也是 `react-pdf` README 对 Next.js 说 "make sure to skip SSR when importing the module you're using" 的原因 `[S8]`。
- **文本抽取不需要 canvas**——上面的 Node 示例是无头的 `[S7]`，所以区域文本抽取既可以在浏览器里跑（PDF 已为渲染加载），也可以在 edge 上跑。
- **单线程回退：** pdf.js 的 `PDFWorker` 在无法创建真正的 `Worker` 或未设置 `workerSrc` 时，会回退到 "fake worker"（通过 `LoopbackPort` 在主线程跑 worker 逻辑）`[S6]`。这让它在缺乏 `new Worker()` 的运行时（Cloudflare Workers）里也能走文字路径。
- pdf.js 还为老浏览器提供 `legacy/` 构建（转译/打 polyfill）`[S5]`。

### 1.5 建议 — 问题 1

**用 `pdfjs-dist` (pdf.js) 作为引擎。** 具体地：

1. 通过 `page.getTextContent()` + `TextItem.transform` 矩阵做区域文本抽取——精确、免费、无需 canvas。
2. `react-pdf` 是可选的、纯 UI 便利层；如果用它做查看器外壳，它驱动的是同一个 `pdfjs-dist` 引擎。无论哪种，都直接针对 pdf.js 对象做区域抽取（`Document.onLoadSuccess` / `Page.onLoadSuccess` 会交出底层 `PDFDocumentProxy` / `PDFPageProxy`）`[S8]`。
3. Apache-2.0（对比 MuPDF 的 AGPL）、Mozilla 维护、与 Firefox v19 起同款引擎——在许可、保真度、维护上是风险最低的选项。

已排除：MuPDF（AGPL copyleft）`[S9]`；PDFium WASM（停滞或单人维护）`[S9]`；pdf-lib（完全没有渲染/抽取）`[S9]`。

---

## 问题 2 — 用于「公式 + 图 + 混排 OCR + 翻译」（en↔zh）的云端多模态模型

### 2.1 头条发现：一手文档无法决出质量问题

三家厂商的 API 文档都没有发布**数学公式的 OCR 准确率数字**、**LaTeX 输出质量指标**、或 **en↔zh 学术翻译质量指标**。一手文档里存在的是：

- 能力描述（如 "vision"、"multilingual"、"understands charts/documents/diagrams"），
- 与 OCR 质量*相关*的操作指引（图像细节/分辨率控制、限制清单），
- 图像 token 计费公式，以及文本 token 价格。

厂商发布的基准表（如 MMMU/MathVista 风格的推理分数）是*自报的多模态推理评测*，不是公式 OCR 或翻译质量的度量，而按本研究的「仅一手来源」规则，我刻意排除了第三方基准聚合站。实际后果在 §2.5 说明：仅凭文档无法定论，需要一次针对真实摘录的小型内部 eval。

### 2.2 各厂商一手文档实际说了什么

#### OpenAI — GPT-4o（遗留）/ GPT-5.x

- `gpt-4o` 模型页："GPT-4o ('o' for 'omni') is our versatile, high-intelligence flagship model… accepts both text and image inputs, and produces text outputs"；128,000-token 上下文；定价 **$2.50 输入 / $1.25 缓存输入 / $10.00 输出** 每 1M token `[S13]`。
- 模型索引："All latest OpenAI models support text and image input, text output, **multilingual capabilities**, and vision" `[S14]`。文档里任何地方都没有翻译质量指标。
- Vision 指南——OCR 专属指引："For high-accuracy tasks that require fine visual detail or precise coordinates… such as **optical character recognition (OCR)**… set `"detail": "original"` when supported"——并警告 `low`/`high` 档 "may resize the image before analysis, which can obscure small details" `[S11]`。
- Vision 指南——限制（一手，与公式/图裁剪直接相关）：模型 "may not perform optimally when handling images with text of non-Latin alphabets, such as Japanese or Korean"；"**Small text**: Enlarge text within the image to improve readability"；"may struggle to understand graphs… where colors or styles — like solid, dashed, or dotted lines — vary"；"may misinterpret rotated or upside-down text"；"may give approximate counts"；"struggles with tasks requiring precise spatial localization" `[S11]`。
- 图像 token 化（每图成本）：GPT-4o 用 **tile-based** 计费——`85` 基础 token + 每 512px tile `170`（`high` 档），或 `low` 档固定 `85` token `[S11]`。（GPT-5.x 改为 32px-patch token 化，乘一个随模型而异的系数 `[S11]`。）
- 延迟：OpenAI 提供 "Fast mode"——对 `gpt-5.6-sol`（`service_tier: "fast"`/`"priority"`）"up to **2.5× faster** speeds and more consistent latency"，并说 Fast mode 在未达标时对企业协议给予服务积分，即存在 SLA 但无公开数字目标 `[S15]`。
- 当前旗舰定价（供参考）：`gpt-5.6-sol` $5/$30，`gpt-5.6-terra` $2/$12，`gpt-5.6-luna` $0.20/$1.20，`gpt-5.4` $2.50/$15，`gpt-4o-mini` $0.15/$0.60 `[S12]`。

#### Anthropic — Claude Sonnet 5 / Opus 5

- 模型总览："All current Claude models support **text and image input, text output, multilingual capabilities, and vision**"；Claude Opus 5 和 Sonnet 5 都有 **1M-token** 上下文 `[S18]`。
- Opus 5 "what's new" 页把 "**Vision**, understanding charts, documents, and diagrams" 列为旗舰能力 `[S19]`。
- Vision 指南——图像成本："Claude views images in patches… Each patch is a 28×28-pixel block… referred to as a visual token. An image, therefore, costs `⌈width/28⌉ × ⌈height/28⌉` visual tokens." 分辨率档位：**high-resolution**（Claude 4.7+）：长边最大 2576 px，4784 visual token；**standard**（其他）：1568 px / 1568 token `[S16]`。算例：1000×1000 图像 ≈ 1296 token；按 Opus 5 的 $5/MTok 约等于每 1,000 张图 $6.48 `[S16]`。
- Vision 指南——指引/限制："High-resolution images can use up to roughly three times more visual tokens"；高分辨率有助于 "computer use, screenshot understanding, and **dense documents**" `[S16]`。图像质量指引：文字 "should be legible and not too small"；避免重度 JPEG 压缩（"can make text difficult to read"）`[S16]`。限制："might hallucinate or make mistakes when interpreting low-quality, rotated, or very small images under 200 pixels"；"coordinate and localization outputs are approximate"；"approximate counts" `[S16]`。
- 定价：**Claude Opus 5 $5 输入 / $25 输出**；**Claude Sonnet 5 $2 输入 / $10 输出**（发布时的 "introductory" 价现已是标准价）；Claude Haiku 4.5 $1/$5；Claude Fable 5 $10/$50 `[S17]`。注意："Claude 4.7 and later models… use a newer tokenizer… produces approximately 30% more tokens for the same text"——跨厂商比价时相关 `[S17]`。
- Vision 或定价文档里都没有 OCR 准确率、LaTeX、或翻译质量指标 `[S16][S17]`。

#### Google — Gemini Pro / Flash（当前：Gemini 3.x + Gemini 2.5）

- Gemini 2.5 Pro 模型页："excels in **code, math, and STEM**, as well as analyzing large datasets, codebases, and **documents**"；输入包括 **PDF**（Audio、images、video、text、PDF）`[S25]`。Gemini 3.1 Pro 同样接受 Text、Image、Video、Audio 和 **PDF** `[S24]`——Gemini 是三家唯一原生吃 PDF 的（另两家吃图像）。
- 图像理解文档："Gemini models are built to be multimodal from the ground up"；"**enhanced accuracy** for specific use cases like object detection"；图像 token 成本 = "**258 tokens** if both dimensions ≤ 384 pixels. Larger images are tiled into 768×768 pixel tiles, each costing 258 tokens"；"Higher resolutions improve the model's ability to **read fine text** or identify small details, but increase token usage and latency" `[S21]`。
- 媒体分辨率文档（Gemini 3）——三家里最明确的一手 OCR 指引：每图 token 预算 `LOW 280 / MEDIUM 560 / HIGH 1120 / ULTRA_HIGH 2240`；推荐设置：图像 → `HIGH`（"Recommended for most image analysis tasks"）；**PDF → `MEDIUM`（"Optimal for document understanding; quality typically saturates at medium. Increasing to high rarely improves OCR results for standard documents."）**；视频文字密集 → `HIGH`（"reading dense text (OCR)"）`[S22]`。
- 定价：**Gemini 2.5 Pro $1.25 输入（≤200k）/ $10 输出**；**Gemini 2.5 Flash $0.30 输入 / $2.50 输出**；Gemini 2.5 Flash-Lite $0.10/$0.40；Gemini 3.6 Flash $1.50/$7.50；Gemini 3.5 Flash $1.50/$9.00；Gemini 3.5 Flash-Lite $0.30/$2.50；Gemini 3.1 Pro（preview）$2.00/$12.00 `[S23]`。模型描述：2.5 Flash "best price-performance model for low-latency, high-volume tasks"；3.6 Flash "most intelligent model built for speed" `[S24][S23]`。
- 思考档位（Gemini 3.5 Flash）：`high` "Best for complex reasoning, **hard math**, and the most difficult code"；默认 `medium` 推荐用于大多数任务 `[S26]`。
- 文档里没有 OCR 准确率、LaTeX、或 en↔zh 文本翻译指标；唯一带 "translate" 的模型是 `gemini-3.5-live-translate-preview`，是*语音到语音*（70+ 语言）——不是文本翻译 `[S24]`。

### 2.3 成本对比（一手，每 1M token）

| 厂商 / 模型 | 输入 | 输出 | 图像计费 |
| --- | --- | --- | --- |
| OpenAI GPT-4o（遗留） | $2.50（$1.25 缓存） | $10.00 | 85 基础 + 每 512px tile 170（high）；low 固定 85 `[S11][S13]` |
| OpenAI gpt-5.6-terra（当前中档） | $2.00 | $12.00 | 32px-patch × 系数 `[S11][S12]` |
| Anthropic Claude Sonnet 5 | $2.00 | $10.00 | 28×28 patch；high-res 上限 4784 token（4.7+）`[S16][S17]` |
| Anthropic Claude Opus 5 | $5.00 | $25.00 | 同上 `[S16][S17]` |
| Google Gemini 2.5 Flash | $0.30 | $2.50 | 258/tile（768px）`[S21][S23]` |
| Google Gemini 2.5 Pro | $1.25（≤200k） | $10.00 | 256 + pan&scan（~2048）`[S22][S23]` |
| Google Gemini 3.5 Flash | $1.50 | $9.00 | 按 `media_resolution` 280–1120 预算 `[S22][S23]` |
| Google Gemini 3.1 Pro（preview） | $2.00（≤200k） | $12.00 | 按 `media_resolution` 280–2240 预算 `[S22][S23]` |

解读：每次请求的 OCR 成本由图像 token + 短文本 prompt + 短双语输出主导，所以*图像 token 公式*比每 1M 文本费率更重要。在这个轴上 Gemini 最便宜（单个 768px tile = 258 token，对比 GPT-4o 的 ~3–6 个 tile × 170，或 Claude 对 1MP 图像的 1296+ token），而且只有 Google 允许通过 `media_resolution` 给每张裁剪图封顶图像 token `[S11][S16][S21][S22]`。

### 2.4 延迟——到处都没有公开数字

- OpenAI：对 gpt-5.6-sol 的 "up to 2.5× faster" Fast mode，附企业 SLA（目标未公开）`[S15]`。
- Google：Flash 模型被描述为 "built for speed" / "low-latency" `[S23][S24]`；更高的 `media_resolution` "increases token usage and latency" `[S21]`。
- Anthropic：抓取的文档里没有量化延迟声明；只有「预先缩小图像可降低延迟」的指引 `[S16]`。

三家都没有在 API 文档里发布每请求延迟保证。任何延迟对比都需要第三方测量，超出本研究范围。

### 2.5 建议 — 问题 2：**质量轴上没有明确胜者；一手来源的证据缺失**

**没有文档化的一手依据，能把这三家按「数学公式 OCR 准确率」、「LaTeX 输出质量」、或「en↔zh 学术翻译质量」排序。** 没有厂商发布这些数字。一手来源*确实*支持、可作为决策输入的是：

1. **成本强烈偏向 Gemini（Flash）**：Gemini 2.5 Flash 是 $0.30/$2.50，对比 $2.50/$10（GPT-4o）和 $2/$10（Sonnet 5）——输出端大约便宜一个数量级 `[S13][S17][S23]`——而且它的图像 token 最便宜 `[S21]`。
2. **只有 Google 发布 OCR 专属调参指引**（`media_resolution`、"read fine text"、"rarely improves OCR results… above medium" for documents），**而且只有 Gemini 原生吃 PDF** `[S21][S22][S25]`。这是运营优势，不是质量证明。
3. **三家发布的 OCR 相关注意事项是同一类**——小字、旋转文字、密集/线型图表——所以没有哪家在文档里被证明更擅长公式裁剪 `[S11][S16][S21]`。

**具体建议：** 把云端模型藏在接口后面（ADR 已经把它留作 "not yet fixed"——正确）。基于*成本 + 运营*挑一个默认（Gemini 2.5 Flash 或 3.5 Flash，按每条摘录设 `media_resolution`），然后在真实 PDF Studio 摘录上跑一次小型标注 eval——指标：公式渲染后的 LaTeX 正确率、en↔zh 学术翻译的忠实度、每条摘录的成本/延迟——再锁定。这是唯一站得住的选法，因为一手来源里没有那些决定性数字。

---

## Sources

- `[S1]` npm registry — `pdfjs-dist`: https://registry.npmjs.org/pdfjs-dist (license, version 6.2.108, zero runtime deps, engines)
- `[S2]` npm registry — `react-pdf`: https://registry.npmjs.org/react-pdf (MIT, v10.4.1, dependency `pdfjs-dist@5.4.296`)
- `[S3]` pdf.js LICENSE (Apache-2.0): https://raw.githubusercontent.com/mozilla/pdf.js/master/LICENSE
- `[S4]` pdf.js README: https://raw.githubusercontent.com/mozilla/pdf.js/master/README.md
- `[S5]` pdf.js FAQ wiki: https://raw.githubusercontent.com/wiki/mozilla/pdf.js/Frequently-Asked-Questions.md ("part of Firefox since version 19"; `legacy/` build; browser support)
- `[S6]` pdf.js API source (`TextContent`/`TextItem` typedefs, `getTextContent`, `PDFWorker` fake-worker fallback): https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js
- `[S7]` pdf.js headless text-extraction example (Node, no canvas): https://raw.githubusercontent.com/mozilla/pdf.js/master/examples/node/getinfo.mjs
- `[S8]` react-pdf README (worker config, skip-SSR in Next.js, `onLoadSuccess` page object): https://raw.githubusercontent.com/wojtekmaj/react-pdf/main/packages/react-pdf/README.md
- `[S9]` npm registry metadata — `mupdf`, `mupdf-js` (AGPL-3.0-or-later), `pdfium-wasm` (ISC 0.0.2), `@hyzyla/pdfium` (MIT 2.1.13), `pdf-lib` (MIT, "Create and modify PDF files"): https://registry.npmjs.org/<pkg>
- `[S10]` `pdfjs-dist@6.2.108` build file sizes, measured via jsDelivr CDN: https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/ (gzip transfer sizes measured with `curl --compressed`)
- `[S11]` OpenAI vision guide ("detail: original" for OCR; limitations; tile/patch tokenization): https://developers.openai.com/api/docs/guides/images-vision.md
- `[S12]` OpenAI pricing: https://developers.openai.com/api/docs/pricing.md
- `[S13]` OpenAI GPT-4o model page (modalities, 128k context, $2.50/$1.25/$10): https://developers.openai.com/api/docs/models/gpt-4o.md
- `[S14]` OpenAI models index ("multilingual capabilities, and vision"): https://developers.openai.com/api/docs/models.md
- `[S15]` OpenAI Fast mode ("up to 2.5× faster"; SLA): https://developers.openai.com/api/docs/guides/fast-mode.md
- `[S16]` Anthropic vision doc (patch tokenization, resolution tiers, image-quality guidance, limitations): https://platform.claude.com/docs/en/build-with-claude/vision.md
- `[S17]` Anthropic pricing (Opus 5 / Sonnet 5 / Haiku 4.5; tokenizer note): https://platform.claude.com/docs/en/about-claude/pricing.md
- `[S18]` Anthropic models overview (1M context; "multilingual… and vision"): https://platform.claude.com/docs/en/about-claude/models/overview.md
- `[S19]` Anthropic "What's new in Claude Opus 5" ("Vision, understanding charts, documents, and diagrams"): https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5.md
- `[S20]` Anthropic resources/model-card index: https://platform.claude.com/docs/en/resources/overview.md
- `[S21]` Google image-understanding doc (multimodal; 258-token tiling; "read fine text"): https://ai.google.dev/gemini-api/docs/generate-content/image-understanding.md.txt
- `[S22]` Google media-resolution doc (Gemini 3 token budgets; PDF `MEDIUM` "rarely improves OCR"; images `HIGH`): https://ai.google.dev/gemini-api/docs/generate-content/media-resolution.md.txt
- `[S23]` Google Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing.md.txt
- `[S24]` Google models overview (model descriptions; PDF input; 3.5 Live Translate is speech-to-speech): https://ai.google.dev/gemini-api/docs/models.md.txt
- `[S25]` Google Gemini 2.5 Pro model page ("code, math, and STEM… documents"; PDF input): https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro.md.txt
- `[S26]` Google "What's new in Gemini 3.5 Flash" (thinking levels, "hard math"; `media_resolution_high` for dense document parsing): https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5.md.txt

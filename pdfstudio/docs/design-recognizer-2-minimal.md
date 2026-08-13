# Recognizer（识别引擎）设计 ——「最小 surface」版

> 这是几份竞争设计之一，本份的唯一约束：**最小化 interface**——1 个入口函数 + 1 个注入点，把双引擎路由、文本层坐标几何、抠图、ClipContent 组装全部压到最小 surface 后面，最大化每个入口的 leverage。与 [`design-recognizer-1-extensible.md`](./design-recognizer-1-extensible.md)（最大化灵活）对照阅读。

核心立场：**识别引擎就是一个纯函数** `(region) => Promise<ClipContent>`。异步生命周期（Clip 状态机的 `recognizing` 态）由 Promise 的 pending / fulfilled / rejected 直接表达——不引入 session、event、stream、retry 方法、batch 数组。整个 module 只有**一个**外部依赖需要注入：模型端口 `VisionPort`。其余全是实现。

---

## 1. 接口 (Interface)

三个类型、一个函数、一个注入点。这就是全部 surface。

### 输入

```typescript
type PageRect = { x: number; y: number; w: number; h: number };   // PDF user-space（pt），不是像素

type Pixels = { data: Uint8ClampedArray; width: number; height: number };  // RGBA，截图裁剪

type Region = {
  page: PDFPageProxy;   // pdf.js 页句柄（in-process，原样使用，不包装）
  rect: PageRect;       // 选中区域，页坐标（pt）
  pixels: Pixels;       // 同一区域的截图裁剪；仅 vision 路线会读，text-layer 路线不碰
};
```

`Region` 只有三个字段，一个都不能少：`page`+`rect` 喂文本层（`getTextContent()` 的 `transform` 矩阵活在页坐标里），`pixels` 喂模型和抠图（像素空间）。二者必须描述同一区域，但识别引擎**从不**在像素↔页坐标之间换算——两条路各住各的空间，viewer（唯一知道 scale 的地方）负责对齐。

### 输出

```typescript
type ClipContent = {
  route: 'text-layer' | 'vision';  // 路由标记（稳定，进 Clip）
  source: string | null;           // 原文（逐字）；公式的原文 = LaTeX；null = 纯图 → 入库 blocked
  translation: string | null;      // 译文（可自由编辑）；text-layer / 公式 / 纯图 = null
  description: string | null;      // 多模态描述：figure → 一句话；text-layer / 公式 = null
  images: Pixels[];                // 抠出的图；text-layer / 公式 = []
};
```

五个字段，`null` 不是「空字符串」而是「此槽位不适用于该区域」。这一处 `null` 语义同时编码了三条领域规则：**`source === null` ⟺ 纯图 ⟺ 入库 blocked**（`source` 就是证据，没有证据就不能入库，一个判断覆盖全部）。翻译、描述、图的缺失同理，全部由 `route` 一个标记 + 三个 `null` 表达，不需要额外的 `kind` 标签泄漏给调用方。

> 一个有意偏离问题陈述的取舍：公式的 LaTeX 放进 `source` 而不是 `description`。理由：原文必须逐字、而公式的逐字形式**就是** LaTeX；且入库的证据是原文，公式放 `source` 才能入库。`description` 于是只留给「figure → 一句话」，与「纯图（`source=null`）」干净对应，无二义。

### 入口

```typescript
type Recognizer = (region: Region) => Promise<ClipContent>;

// 唯一注入点：模型端口（类别 4，见 §4）
type VisionPort = {
  read(pixels: Pixels): Promise<VisionReading>;   // 一次调用：分类 + 转录 + 翻译 + 描述
};

type VisionReading = {
  kind: 'formula' | 'figure' | 'text' | 'mixed';  // 区域归类（只活在识别引擎内部，不进 ClipContent）
  source: string | null;       // prose 逐字转录（text/mixed）或 LaTeX（formula）；figure = null
  translation: string | null;  // prose 的 en↔zh 译文；其余 = null
  description: string | null;  // figure 一句话（figure/mixed）；其余 = null
};

function makeRecognizer(vision: VisionPort): Recognizer;
```

**入口计数：2 个名字——`makeRecognizer`（一次）+ `recognize`（每次）。** 每个 Clip 的 surface 是**一个函数、一个参数、一个返回类型**。`makeRecognizer` 不算「每次调用都要学的 surface」：它是应用启动时的一次性接线，日常 caller（截图 flow）只知道 `recognize(region)`。这是 small-surface 能压到的最低线——再往下压，模型端口就只能由识别引擎自己去全局单例里拿，那会破坏「accept dependencies, don't create them」和 mock 测试，我不干。

`VisionReading.kind` 是**内部**类型：它驱动抠图规则和 `ClipContent` 组装，但不出现在对外 surface 上。调用方只需要 `route` + 三个 `null`。

### 不变量 (Invariants)

1. **原文逐字**：`source` 一旦写出，识别引擎绝不改写。text-layer 路线 = `getTextContent()` 的 `str` 按阅读顺序拼接；vision 路线 = 模型转录原样返回。OCR 纠错是读者的权力，不是识别引擎的。
2. **单次模型调用**：vision 路线恰好一次 `VisionPort.read()`——分类 + 转录 + 翻译 + 描述一次过（满足 ADR-0001）。text-layer 路线**零**模型调用（精确、免费、即时）。
3. **路由确定且藏在内部**：`route` 是 `(page, rect)` 的纯函数，只看文本层、不看像素。同一 region 永远走同一条路——确定性、可测。
4. **两条路永不相交**：text 路线全部在页坐标空间，vision 路线全部在像素空间。识别引擎不做任何像素↔页坐标换算。
5. **纯图不是错误**：figure → `source=null` 是**正常**的 ClipContent；「入库 blocked」由 Clip 判定（`source==null` 即不可入库），识别引擎不越权判定合法性。
6. **纯被动 + 无跨调用状态**：`recognize` 只在截图手势后显式触发，无后台、无定时器、无预取。除了 per-page 文本层缓存（纯优化，不影响结果），识别引擎不持任何影响下一次调用的状态——所以「重试」=「再调一次」。

### 顺序 (Ordering)

单次调用内，严格四步：

1. `(await)` 取该页文本层（per-page 缓存，同页多 region 复用）。
2. 过滤与 `rect` 相交的 text item；算文本层覆盖率 + 连贯性。
3. 判定：干净 prose → **text-layer**，立即返回（不碰模型）；否则 → **vision**。
4. vision：`VisionPort.read(pixels)` → 按 `kind` 组装 `ClipContent`（抠图）→ 返回。

没有跨 region 顺序——一个 region 一次调用，无所谓交错。

### 错误模式 (Error modes)

只有**一个**失败来源：模型调用。text-layer 路线无失败路径（已加载页上的纯计算；`getTextContent()` 抛错 = bug，直接冒出）。

| kind | 何时 | retryable |
| --- | --- | --- |
| `unconfigured` | vision 路线但未配 key/url | 否（引导去设置页） |
| `network` / `timeout` / `http` / `rate-limit` | 模型传输失败 | 是 |
| `malformed-output` | 模型输出不合 JSON schema（adapter 先 repair 重试一次再抛） | 是 |

```typescript
type RecognizeError = {
  kind: 'unconfigured' | 'network' | 'timeout' | 'http' | 'rate-limit' | 'malformed-output';
  message: string;      // 中文，直接给读者看
  retryable: boolean;
};
```

**不存在的错误模式**：没有 `unsupported-kind`、没有 `text-layer-empty`、没有 `aborted`——这些是设计 1 为「强制引擎 / 取消」付的价，本设计里这些概念根本不存在。取消同理：caller 忽略已 resolve 的 promise 即可，模型调用短，取消的收益撑不起一个 `AbortSignal` 参数。

### 性能特征 (Performance characteristics)

- **text-layer**：每页一次 `getTextContent()`（缓存），O(items in rect)；零网络、免费、毫秒级（async 仅因 pdf.js 返回 promise）。
- **vision**：每 region 恰好一次模型调用（秒级，模型主导）；成本 = 图像 token + 短结构化输出；识别引擎先按模型最优分辨率缩放像素再发（隐藏优化，见 §3）。
- **内存**：`images` 是 `pixels` 的裁剪引用/副本（`Uint8ClampedArray`），不引入编码开销；PNG 编码是 ClipStore 的事。

---

## 2. 用法示例 (Usage)

最常见 caller：截图 → 摘录 flow。**一个入口，一次调用，三个状态分支。**

```typescript
// 构造一次（应用启动）；模型端口在此注入，运行期 caller 永远不碰
const recognize = makeRecognizer(visionAdapterFromConfig(cfg));

// ---- 截图手势完成，得到 region ----
const region = { page, rect, pixels };

dispatchClip({ type: 'recognizing' });            // Clip 状态机：recognizing

try {
  const content = await recognize(region);        // 唯一入口
  dispatchClip({ type: 'recognized', content });  // → 待编辑
} catch (err) {
  dispatchClip({ type: 'recognizeFailed', error: err });  // 仅模型失败到这儿
}
```

四类区域的返回（可直接断言）：

```typescript
// 文字区（数字 PDF，走文本层，零模型调用）
{ route: 'text-layer', source: 'Self-attention connects...', translation: null, description: null, images: [] }

// 公式区（模型一次调用，LaTeX 进 source）
{ route: 'vision', source: '\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}(\\frac{QK^T}{\\sqrt{d_k}})V', translation: null, description: null, images: [] }

// 纯图区（模型一次调用，只有描述；source=null → 入库 blocked）
{ route: 'vision', source: null, translation: null, description: 'Transformer 编码器—解码器结构示意图', images: [pixels] }

// 图文混排（模型一次调用：转录 + 翻译 + 描述 + 抠图）
{ route: 'vision', source: 'Figure 1: The transformer architecture...', translation: '图 1：Transformer 架构……', description: '架构框图', images: [pixels] }
```

**重试没有方法——函数本身就是重试**（不变量 6：无跨调用状态）：

```typescript
// 网络失败后的重试：再调一次，语义与首次完全一致
try { await recognize(region); } catch (e) { await recognize(region); }
```

**批量没有数组参数**——caller 自己 `Promise.all`：

```typescript
const contents = await Promise.all(regions.map(recognize));  // 需要时才有，接口不为此付税
```

**interface 即测试面**（fixture PDF + scripted fake，无需任何内部 seam）：

```typescript
const fake: VisionPort = {
  read: async (p) => ({ kind: 'figure', source: null, translation: null, description: '结构示意图' }),
};
const recognize = makeRecognizer(fake);

// text-layer 路线：传 1×1 占位 pixels，断言 route='text-layer'、source 逐字精确、且 fake.read 从未被调用
// vision 路线：scripted fake 按 kind 逐个断言四个输出形状；抛错 fake 断言 RecognizeError
```

---

## 3. 藏在实现后面的是什么 (Hidden implementation)

interface 之外的复杂度全部收在 `recognize` 的实现里，caller 和测试都看不到：

- **pdf.js 坐标几何**（整份设计里最容易写错的纯几何）：`rect`（user-space）→ `getTextContent()` 的逐项 `transform` 矩阵 → 项包围盒 → 与 rect 求交过滤 → 按阅读顺序（`transform` 的 y/x）排序 → `str` 拼接（尊重 `hasEOL`）→ 空白归一化。锁死在一个私有纯函数里，通过 `recognize` 测。
- **per-page 文本层缓存**：`WeakMap<PDFPageProxy, Promise<TextContent>>`；同页多 region 共享一次 `getTextContent()`。这是唯一的跨调用状态，且是纯优化——删掉它行为不变。
- **路由启发式**（双引擎路由的全部真相）：覆盖率（文本项包围盒并集占 rect 的比例）+ 连贯性（连续成词的 run vs 孤立字形，区分「段落」和「公式散字」）。干净 prose → text-layer，其余一律 vision。阈值是一个常量，调参只需改一处。eval 样本（`f/g/p/m`）直接成为路由的回归测试。
- **vision prompt 组装 + JSON schema + 解析**：system prompt（「分类 formula/figure/text/mixed；逐字转录；prose 做 en↔zh 翻译；公式输出 LaTeX；figure 输出一句话」）+ 图像缩放/编码（按模型分辨率档封顶，来自 research-ocr-engine 的 `detail`/分辨率指引）+ 输出 JSON schema → 严格解析成 `VisionReading`。**这段住在 VisionPort 的 adapter 里，不在识别引擎核心里**——prompt 调优只动 adapter，识别引擎核心（路由 + 几何 + 组装）对 prompt 无感。
- **抠图规则**：`kind` → `images`（figure/mixed → 整块区域即图；formula/text → 空）。v1 的「抠图」=「你框的那块就是图」；未来要剥 caption、做真正的子图裁剪，只在 `VisionReading` 里加一个 `imageBoxes` 字段、在 adapter 里多要模型输出一组框、在实现里 crop——**interface 一个字不改**。这是留好的 deepening 空间。
- **route marker 盖章**：text-layer 路线盖 `'text-layer'`，vision 路线盖 `'vision'`，随 `ClipContent` 一起交给 Clip。
- **一次 repair 重试**：模型输出不合 schema 时，adapter 先带一句「按此 JSON 重新输出」重试一次，再失败才抛 `malformed-output`。这一层对 caller 完全透明。

---

## 4. 依赖策略与 adapter (Dependency strategy)

按 DEEPENING.md 四类依赖分别交代：

- **pdf.js —— 类别 1（in-process）**。不是端口、不做 adapter、不进对外 surface。它随 `region.page` 每次传入（`PDFPageProxy` 原样用，不包装——包装只加 surface 不加 leverage，`getTextContent()` + `transform` 恰好就是我们需要的全部）。文本层几何是**internal seam**：一个私有纯函数，通过 `recognize` 测。测试用一个小 fixture PDF（手工写死 `transform` 的几十字节 PDF），`getDocument(fixtureBuffer).getPage(1)` 无头构造（research-ocr-engine [S7] 证实 Node 无 canvas 可行）。text-layer 测试传 1×1 占位 pixels——因为该路线不读像素，fixture 测试极便宜。

- **model client —— 类别 4（true external）**。唯一必须注入的端口，但**不是**原样注入共享的 `ModelClient`，而是注入识别引擎自己定义的窄端口 `VisionPort`（一个方法 `read(pixels) → VisionReading`）：

  ```typescript
  interface VisionPort {
    read(pixels: Pixels): Promise<VisionReading>;
  }
  ```

  生产 adapter = `visionAdapterFromConfig(cfg)`：内部持有一个 OpenAI 兼容的 `ModelClient`（URL + key + model，一套代码覆盖 OpenAI / Gemini 兼容层 / OpenRouter / vLLM / Ollama，ADR-0005），把 §3 的 prompt 组装、图像缩放、JSON schema、repair 重试都做掉，对外只剩 `read(pixels) → VisionReading`。测试 adapter = `FakeVisionPort`，按脚本吐 `VisionReading`：LaTeX 脚本（formula）、`source=null` 脚本（纯图）、抛错脚本（网络失败）。**两个 adapter = 真缝**，不是假想缝。

- **seam 纪律**：对外 seam 只有一个——`recognize(region)`。`VisionPort` 是 config-time seam（构造期注入一次），不是 per-call seam。pdf.js 是 internal seam，绝不从 interface 露出。**路由决策、prompt、抠图规则都不从 interface 露出**——这正是本设计与设计 1 的分野：设计 1 把 `Router`/`Engine`/`Stage`/`RegionKind` 全部做成 config-time 扩展点，本设计认为它们今天各只有一个生产 adapter，是「一个 adapter 的假想缝」，属于应删除的 indirection（DEEPENING.md 的 seam 纪律第一条）。若哪天真出现第二个引擎/第二个 kind，再开缝也不迟——那时 interface 一样不用改，因为路由和抠图都藏在 `recognize` 里。

---

## 5. 取舍 (Trade-offs)

**leverage 高的地方**——路由 + 坐标几何 + prompt + 抠图 + 组装，五件事只实现一次，藏在**一个函数**后面。N 个 caller（截图 flow、未来的整页识别、批量）免费拿到整套能力，测试也穿过同一条缝。删除测试（deletion test）：删掉 `recognize`，这五件事会原样出现在每一个 caller 里——它挣到了自己的位置。

**thin 的地方——deliberate**。`VisionPort` 是浅的（一个方法，adapter 基本是 passthrough：`ModelClient` + prompt）。单个 adapter 浅、识别引擎核心深——深度不平均分布，全在 `recognize` 的实现里。这是「一个深模块 + 一个窄缝」，不是「一圈浅 adapter 围一个深编排器」。

**对 deep-module 原则的正面回答**：`recognize(region) → Promise<ClipContent>` 不是「图省事的 thin function」，而是深度**按「每学一个类型能拿到的领域杠杆」**衡量——学一个 `Region`（3 字段）、一个 `ClipContent`（5 字段）、一个 `RecognizeError`（2 字段），就拿到双引擎路由、逐字文本层抽取、一次模型调用出 LaTeX/翻译/描述、抠图、入库-block 语义，全部确定性和错误模式。三张卡，全套行为。

**代价清单（要认账）**：

1. **放弃流式/进度**：译文逐 token 出现、进度条，本设计没有。截图→摘录的常见区域一次模型调用通常 1–3 秒，spinner 足够；若逐 token 流式变成硬需求，本设计没有优雅升级路径——那会需要 session 类型，本设计会向设计 1 的形状坍缩。这是本设计最大的、且不可修复的让步，我认。
2. **放弃模块内 retry/cancel/batch**：重试 = 再调一次（无状态使然），取消 = 忽略结果，批量 = `Promise.all`。这三样被推到 caller，但每个都是一行，且不需要 caller 理解识别引擎内部。代价极低，值得。
3. **放弃 force-engine / hint / region-kind 公开**：强制引擎、调试 hint、细粒度 kind 标签都不在 interface 里。它们是调试便利，今天没有第二个引擎可 force、没有第二个 kind 可 hint，不该为「也许」付 surface。测试要碰这些，走 internal seam，不走对外 interface。
4. **路由启发式是唯一的单点风险**：一个公式被误判成 prose，`source` 就是乱码。缓解：阈值是一个常量、一处可调；eval 样本成为路由回归测试；不干净的文本一律落到 vision 兜底（宁可多一次模型调用，不吐乱码原文）。
5. **markdown 拼装不在识别引擎里**：bilingual markdown 是 Clip 的内容模型（CONTEXT.md：「摘录持有双语 markdown」），且译文可自由编辑意味着 markdown 必须能被 Clip 重渲染——渲染逻辑放 Clip 一侧才不重复。识别引擎的边界到此为止：「这个区域说了什么」（结构化），不回答「摘录长什么样」（渲染）。

**一句话总结**：这是「窄而深」的 module——一个函数、三张卡、五字段，双引擎路由和全部几何/prompt/抠图压在一个 surface 后面。它放弃了流式、retry、batch、扩展点，换来的是：截图 flow 只用学一个函数，其余全是实现。

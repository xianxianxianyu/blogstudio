# Recognizer（识别引擎）设计 ——「最大化灵活」版

> 这是几份竞争设计之一，本份的唯一约束：**最大化灵活性**——支持多 use case 与扩展点（流式进度、部分结果、选/强制引擎、后加新 region kind、重试失败区域、批量识别多个区域），哪怕 interface 变大也在所不惜。

核心立场：把 Recognizer 拆成**两个 module**——一个构造期注入全部扩展点、运行期只有一个方法 `recognize` 的 `Recognizer`；一个 per-run 的 `RecognitionSession`，异步生命周期（事件流、retry、cancel）全住在它身上。扩展点全在**构造期**（config），运行期 surface = 「一个方法 + 一个 session + 一个事件联合」。

---

## 1. 接口 (Interface)

### 输入

```typescript
type PdfPage = { doc: PDFDocumentProxy; pageNumber: number };  // pdf.js 不透明句柄，运行期原样传递

type PageRect = { x: number; y: number; w: number; h: number }; // PDF user-space 单位

type Screenshot = { bitmap: ImageBitmap; scale: number };       // 区域像素 + 渲染缩放比

type Region = {
  id: string;              // caller 分配；事件、retry、批量结果全用它关联
  page: PdfPage;
  rect: PageRect;
  screenshot: Screenshot;  // 只有 vision 类 stage 会读；text-layer 路径不碰像素
  force?: EngineId;        // 强制引擎（retry / 调试 / 用户 override）
  hint?: RegionKind;       // 强制归类（试点新 kind 或覆盖默认分类）
};
```

### 输出

```typescript
type Route = 'text-layer' | 'vision';   // route marker：稳定、进 ClipContent

type ExtractedImage =
  | { kind: 'embedded'; bitmap: ImageBitmap; ref: string }    // pdf.js obj 抠出（内嵌图）
  | { kind: 'crop'; bitmap: ImageBitmap; source: 'screenshot' }; // 截图裁剪（纯图/figure 区域）

type ClipContent = {
  sourceText: string | null;   // 原文，逐字；纯图 = null
  translation: string | null;  // 译文；text-layer 路线 = null（无模型调用）
  description: string | null;  // 多模态描述：formula → LaTeX，figure → 一句话
  extractedImages: ExtractedImage[];
  route: Route;
  kind: RegionKind;            // 细粒度标签：text / formula / figure / pure-image / mixed / …
};
```

### 扩展点（全部构造期注入，运行期不出现）

```typescript
type EngineId = string;   // 'text-layer' | 'vision-model' | 未来 'local-ocr' | 'hybrid' | ...

type RegionKind = 'text' | 'formula' | 'figure' | 'pure-image' | 'mixed' | (string & {});
// open union：核心五个稳定，`(string & {})` 允许后加 'table' / 'code' / 'music' 等

type ClipField = 'sourceText' | 'translation' | 'description' | 'extractedImages';

interface Stage {                 // 一个可独立失败/重试/报告进度的最小工作单元
  readonly id: string;
  readonly fields: ClipField[];   // 声明会写哪些字段（供路由排序与断言）
  run(input: StageInput): Promise<StageResult>;
}

interface StageInput {
  region: Region;
  partial: ClipContent;           // 前面 stage 已产出的字段
  signal: AbortSignal;
  report: (ev: StageEvent) => void;
}

type StageResult = { ok: true; patch: Partial<ClipContent> }
                 | { ok: false; error: StageError };

type StageEvent =
  | { kind: 'progress'; fraction: number }                 // 0..1
  | { kind: 'partial'; patch: Partial<ClipContent> };      // 流式中间态（逐 token）

interface Engine {
  readonly id: EngineId;
  readonly route: Route;          // 该引擎盖章的 route marker（text-layer 引擎 → 'text-layer'，其余像素路径 → 'vision'）
  readonly cost: 'free' | 'model-call';
  readonly kinds: RegionKind[];   // 声明能处理哪些 kind
  stages(kind: RegionKind, region: Region): Stage[];       // 该 kind 的 stage 序列
}

interface Router {
  route(region: Region): Promise<RouteDecision>;
}
type RouteDecision = { kind: RegionKind; engineId: EngineId; reason: string };
```

默认 `Router` 由两件可替换的零件组成：一个 in-process 的 `Classifier`（主要信号 = 文本层有无文字）和一个 route table `Map<RegionKind, EngineId>`。`force` 短路分类直接命中指定引擎，`hint` 短路分类直接给 kind。

### 运行期 interface

```typescript
interface Recognizer {
  recognize(req: { regions: Region[] }): RecognitionSession;   // 1..N 个 region，一个 session
}

interface RecognitionSession {
  readonly id: string;
  readonly events: AsyncIterable<RecognitionEvent>;

  retry(regionId: string, opts?: { force?: EngineId; hint?: RegionKind }): void;
  cancel(reason?: string): void;
}

type RecognitionEvent =
  | { type: 'started'; regionCount: number }
  | { type: 'routed'; regionId: string; kind: RegionKind; engineId: EngineId; reason: string }
  | { type: 'stage-start'; regionId: string; stageId: string }
  | { type: 'progress'; regionId: string; stageId: string; fraction: number }
  | { type: 'partial'; regionId: string; stageId: string; patch: Partial<ClipContent> }
  | { type: 'region-done'; regionId: string; content: ClipContent }
  | { type: 'region-failed'; regionId: string; error: RecognitionError; retryable: boolean }
  | { type: 'done' }                                  // 全部 region 终结（done 或 failed）
  | { type: 'aborted'; reason: string };

type RecognitionError = {
  code: 'model-unconfigured' | 'network' | 'timeout' | 'rate-limit' | 'http-error'
      | 'text-layer-empty' | 'unsupported-kind' | 'aborted' | 'prompt-invalid';
  message: string;    // 中文，直接给读者看
  regionId: string;
  stageId?: string;
};
```

### 不变量 (Invariants)

1. **原文逐字**：`sourceText` 一旦写出，Recognizer 绝不改写。text-layer 路线 = `getTextContent()` 的 `str` 按阅读顺序（`transform` 排序）拼接；vision 路线 = 模型转录原样返回。OCR 纠错是 Clip 层 / 读者的权限，不在 Recognizer 内。
2. **单引擎**：一个 region 一次只跑一个 engine。`force` 覆盖默认路由；但 engine 未在 `kinds` 声明该 kind 时拒绝并报 `unsupported-kind`（保护性拒绝，防止配错）。
3. **事件分组与单调**：事件按 `regionId` 分组；同一 region 内 stage 严格顺序；`partial` 单调追加（只增不改，streaming 语义）。
4. **终结语义**：`done` / `aborted` 是终态。之后 session 只接受对**已失败** region 的 `retry`；`retry` 把该 region 重置回 pipeline 起点，重发 `routed` 与新的 `region-done`/`region-failed`。
5. **纯图不是错误**：vision 输出 `sourceText = null` 时，kind 记 `pure-image`、`route` 仍为 `vision`，产出**正常** ClipContent。「入库被阻塞」由 Clip 状态机判定（`sourceText == null` 即不可入库），Recognizer 不越权判定合法性。
6. **纯被动**：无后台任务、无定时器、无预取。一切由 `recognize()` 显式触发，`cancel()` 显式中止（`AbortSignal` 一路下钻到模型调用）。

### 顺序 (Ordering)

- 单 region：`routed → stage-start → (progress | partial)* → region-done | region-failed`。
- 跨 region：`started` 先于一切 region 事件；`done`/`aborted` 严格最后。region 之间事件可交错（并发执行），caller 靠 `regionId` 解耦——**不需要**全局顺序。

### 错误模式 (Error modes)

| code | 何时 | retryable |
| --- | --- | --- |
| `model-unconfigured` | vision 路线但未配 key | 否（引导去设置页） |
| `network` / `timeout` / `http-error` / `rate-limit` | 模型调用失败 | 是 |
| `text-layer-empty` | `force: 'text-layer'` 但文本层无字 | 否（换 vision） |
| `unsupported-kind` | `force`/`hint` 的 kind 无 engine 声明 | 否（改配置） |
| `aborted` | `cancel()` | 否 |
| `prompt-invalid` | 模型输出不符合 JSON schema | 是（重试或降级到纯文本解析） |

### 性能特征 (Performance characteristics)

- **text-layer**：每页一次 `getTextContent()`（同页多 region 缓存复用），O(items in rect)；零网络，毫秒级。
- **vision**：每 region **恰好一次** model call（read + translate + LaTeX 一次过，满足 ADR-0001）；延迟由模型主导（秒级）；streaming 摊平感知延迟（`partial` 逐 token 出现）；token 成本由图像 token 主导。
- **批处理**：同页 region 先做一次 text-layer 预扫、批量分流（一次 `getTextContent()` 服务 N 个 region）；vision region 默认**串行**（`concurrency.vision = 1`，防 rate-limit），text-layer region 可并行。

---

## 2. 用法示例 (Usage)

最常见 caller：截图 → 摘录 flow（单 region），以及同一套 interface 覆盖的 retry / 强制引擎 / 批量 / 后加 kind。

```typescript
// 构造（应用启动一次；扩展点全在这，运行期 caller 不碰）
const recognizer = createRecognizer({
  engines: [
    textLayerEngine(),                       // pdf.js，cost: 'free'，route: 'text-layer'
    visionModelEngine({ model, prompts }),   // OpenAI 兼容模型，cost: 'model-call'，route: 'vision'
  ],
  router: defaultRouter(),                   // Classifier + route table
  concurrency: { vision: 1, textLayer: 4 },
});

// ---- 截图手势完成，得到 region ----
const region = {
  id: crypto.randomUUID(),
  page: { doc, pageNumber: 12 },
  rect: { x, y, w, h },
  screenshot: { bitmap, scale },
};

const session = recognizer.recognize({ regions: [region] });

// Clip 状态机进入 recognizing
dispatchClip({ type: 'recognizing', sessionId: session.id });

for await (const ev of session.events) {
  switch (ev.type) {
    case 'routed':
      ui.badge(`引擎：${ev.engineId}（${ev.reason}）`);   // "已走文本层" / "交给视觉模型"
      break;
    case 'partial':
      ui.patchClip(ev.regionId, ev.patch);              // 译文/原文逐 token 出现
      break;
    case 'progress':
      ui.progress(ev.fraction);
      break;
    case 'region-done':
      dispatchClip({ type: 'recognized', content: ev.content });  // 进入「待编辑」
      break;
    case 'region-failed':
      ui.showRetry(ev.regionId, ev.error, ev.retryable);
      break;
  }
}
```

重试一个失败区域（或强制换引擎重识）：

```typescript
// 网络失败后的普通重试
session.retry(regionId);

// 文本层抽出来是乱码 → 强制走 vision 重识
session.retry(regionId, { force: 'vision-model' });
```

强制引擎 / 归类（调试、试点）：

```typescript
recognizer.recognize({ regions: [{ ...region, force: 'vision-model' }] });   // 强行走视觉
recognizer.recognize({ regions: [{ ...region, hint: 'table' }] });           // 试点新 kind
```

批量识别（未来「识别整页」/「一次框多块」）：

```typescript
const session = recognizer.recognize({ regions: [r1, r2, r3] });
for await (const ev of session.events) {
  if (ev.type === 'region-done') clips.push(ev.content);  // 三个 region 各自独立成败
}
```

后加一个 region kind（`table` → Markdown），**不碰核心**：

```typescript
const recognizer = createRecognizer({
  engines: [
    textLayerEngine(),
    visionModelEngine({
      model,
      prompts: { ...defaultPrompts, table: tablePrompt },  // 新增 prompt 变体
    }),
  ],
  router: defaultRouter().withKind({
    kind: 'table',
    engineId: 'vision-model',
    classify: (r) => looksLikeTable(r.screenshot),         // 可选启发式
  }),
});
```

---

## 3. 藏在实现后面的是什么 (Hidden implementation)

interface 之外的复杂度全部藏在 orchestrator 与两个默认 engine 的实现里，caller 和测试都看不到：

- **pdf.js 坐标几何**：`rect`（user-space）↔ viewport 缩放的换算；`getTextContent()` 返回的逐项 `transform` 矩阵 → 项包围盒 → 与 rect 求交过滤 → 按阅读顺序（`transform` 的 y/x）排序 → `str` 拼接（尊重 `hasEOL`）→ 空白归一化。这是整份设计里最容易写错的纯几何，必须收在 `text-layer` engine 内。
- **text-layer 按页缓存**：同页多 region 共享一次 `getTextContent()`；缓存键 = doc + pageNumber，session 结束失效。
- **vision 单次调用的 prompt 组装**：system prompt（「若有公式输出 LaTeX、描述 figure 一句话、逐字转录文字、en↔zh 翻译」）+ 图像（缩放/编码，按模型分辨率档）+ 输出 JSON schema。kind 不同只换 prompt 变体，pipeline 不变。
- **流式结构化输出解析**：一个小的 streaming 状态机，把模型 token 块映射成 `ClipContent` 字段状态——先填 `sourceText`，再 `translation`，再 `description`；每填一段发一个 `partial` patch。模型返回空 `source` 时把它识别为 `pure-image`。
- **retry 记账**：per-region 运行状态机（idle → routing → running → done/failed），retry 重置到 routing 并重放事件；同一 region 的事件去重。
- **并发与信号**：vision 调用的 semaphore（默认 1）；`AbortSignal` 从 `session.cancel()` 一路下钻到 fetch 与流解析。
- **route marker 盖章**：`region-done` 提交时由 engine 声明的 `route` 字段盖章，与路由原因（`reason`）一起进 ClipContent。
- **抠图**：`text-layer` 路线的 `extract-images` stage 用 pdf.js `page.objs.get(ref)` 取与 rect 相交的内嵌图；vision 路线裁剪截图。二者都是可选的 stage，默认 route 列表里带上。

---

## 4. 依赖策略与 adapter (Dependency strategy)

按 DEEPENING.md 的四类依赖分别交代：

- **pdf.js —— 类别 1（in-process）**。不是端口、不做 adapter、不进外部 interface。它住在 `text-layer` engine 的实现里（engine 闭包持有一个 `PDFDocumentProxy` 来源），是 **internal seam**。测试用一个小 fixture PDF（几十字节、手工写死 `transform` 的 PDF），`getDocument(fixtureBuffer).getPage(1)` 就能构造 `PdfPage` 句柄，直接穿 interface 测。**注意**：`Region.screenshot` 在 text-layer 路径完全不被读，text-layer 测试可以传 1×1 占位像素——这让 fixture 测试极便宜。
- **model client —— 类别 4（true external）**。唯一必须注入的端口：

  ```typescript
  interface ModelClient {
    complete(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
  }
  ```

  生产 adapter = OpenAI 兼容的 HTTP 流式（SSE）实现（一个 URL + key + model，同一套代码覆盖 OpenAI / Gemini 兼容层 / OpenRouter / vLLM / Ollama，对应 ADR-0005）。测试 adapter = `MockModelClient`，按脚本吐 chunk：确定性 LaTeX 脚本（formula）、空 source 脚本（纯图）、慢速逐 chunk 脚本（流式 UI）、抛错脚本（retry）。**这是真缝**（两个 adapter：生产 + 测试）。
- **seam 纪律**：Recognizer 的**外部 interface 不暴露** pdf.js 或 ModelClient——它们只在 `createRecognizer(config)` 时注入，住在 engine 实现里。外部 seam 就是 `recognize() → session`；其余全是 internal seam。`Engine` / `Router` / `Stage` 这些扩展点是 config-time seam，不是 per-call seam。
- **诚实提醒**：`Engine` 缝今天只有一个生产 adapter 是「假想缝」（text-layer + vision 其实可以写死成两条 if）。它被「未来第二个引擎」的预期撑起来——local OCR、kind 专用模型、hybrid（text-layer 抽原文 + vision 补描述）。如果那个引擎永不到来，这层就该坍缩；本设计押它会来（约束如此要求）。

---

## 5. 取舍 (Trade-offs)

**leverage 高的地方**——路由 + 编排 + 事件流这三件事只实现一次，N 个 caller（截图 flow、批量、retry UI、进度条、错误浮层）免费拿到整套异步生命周期。扩展点全部 config-time：新 region kind = 一条 prompt 变体 + 一条 route table 项；新 engine = 一个 `Engine` adapter；换模型端点 = 换 `ModelClient` adapter。所有变更都在构造期，**核心零改动**，locality 落在「加新东西不动旧代码」。

**thin 的地方**——deliberate。单个 `Stage` 是浅的（text-layer 一次 `getTextContent`，vision 一次 model call，基本是 passthrough）；单个 `Engine` 也是浅的。深度**不**在 adapter 里，全在 orchestrator（路由分流、事件协议、retry 记账、并发/信号、流式解析）。所以这份设计的深度分布是「一个深编排器 + 一圈浅适配器」。

**对 deep-module 原则的正面冲突（要认账）**：这份设计**不是** Ousterhout 意义上的 deep module——它拒绝 `recognize(region) → Promise<ClipContent>` 的小 interface。理由是：异步生命周期（流式/部分结果/重试/取消/批量）是**固有复杂度**，塞进一个 `Promise<ClipContent>` 只会把它逼到两种下场之一——要么泄漏成一个巨型返回类型（一次全量等待、无进度、无 retry 语义），要么逼每个 caller 自己写编排，把复杂度摊到 N 处、破坏 locality。这里的 depth 要按「每学一个事件类型能拿到的异步生命周期杠杆」来衡量：事件只有 9 种、彼此正交、组合使用，学习是线性的，不是组合爆炸的。

**代价清单**：
1. **interface 大**：9 个事件 + 6 个扩展点类型。截图 caller 实际只用其中约 5 个事件，其余是给批量/重试/调试的——这是为约束付的价。
2. **indirection 多**：`Region → Router → Engine → Stage → ClipContent` 四跳。单 region 简单场景里这四跳显得多余；批量/重试/新 kind 场景里每一跳都有人用。
3. **「一个 adapter 的假想缝」风险**：`Engine` 缝当前只有一个生产 adapter，若第二个引擎不来就是纯 indirection（见 §4 诚实提醒）。
4. **open union 的税**：`RegionKind` 开放后，default 分支（未知 kind 的 prompt/兜底）必须常驻，否则后加 kind 时旧 caller 会炸。

**一句话总结**：这是「宽而平」的 module——surface 大但正交，复杂度集中在编排器，扩展点全部构造期。它牺牲了 small-interface 的优雅，换来的是：新 kind、新引擎、换模型、重试、批量、流式进度，全部不用碰核心。

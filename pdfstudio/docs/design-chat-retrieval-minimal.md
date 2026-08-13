# Chat + Retrieval（问文档）设计 ——「单缝最小」版

> 这是几份竞争设计之一，本份的唯一约束：**最小化 interface**——1 个方法 + 1 个注入点。把索引（含双栏读序还原）、切块、embedding + FTS5 检索、prompt 组装、引用解析、诚实性判定，全部压到 `ask` 一个入口后面。与「Chat + Retrieval 拆成两个 module 各开一个 seam」（`architecture.md` 现状）对照阅读。

核心立场：**问文档就是一个函数** `(doc, turns) => Promise<Answer>`。Retrieval 不是独立 module——它今天只有一个 caller（Chat），是「一个 adapter 的假想缝」，按 seam 纪律退为 Chat 的**内部缝**。索引不是入口——它懒加载在第一次 `ask` 内部，caller 永远不碰 `index`/`search`。整个 cluster 对外只有**一个**依赖要注入：模型端口 `ModelPort`。

---

## 1. 接口 (Interface)

五个类型、一个方法、一个注入点。

### 输入

```typescript
interface DocRef {
  id: string;                  // 稳定标识 = 索引命名空间（单文档封闭的锚点，绝不跨 PDF）
  document: PDFDocumentProxy;  // pdf.js 句柄（in-process，原样用，不包装）
}

interface Turn {
  role: 'user' | 'assistant';
  parts: Part[];
}

type Part =
  | { kind: 'text'; text: string }            // 普通文本
  | { kind: 'clip'; snapshot: ClipSnapshot }  // 贴入的摘录（快照）
  | { kind: 'image'; image: ImageData };      // 贴入的图/公式图

interface ClipSnapshot {
  id: string;
  anchor: { page: number; rect: Rect };  // 页码 + 坐标，用于跳回原文与引用
  sourceText: string;                    // 原文（贴入时刻的拷贝；此后编辑不回写）
  translation?: string;                  // 译文（可选）
  image?: ImageData;                     // 区域抠出的图（可选）
}

interface ImageData { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array }
```

`Turn.parts` 把「贴摘录 / 贴图」统一成消息的一种 part——不设单独的 `clips`/`images` 参数，也不设「贴入区」和「对话区」两个区域。快照语义落在 `ClipSnapshot` 这个值类型上：它是**贴入时刻的深拷贝**，接口只持有值、不持有对 Clip 的活引用。

### 输出

```typescript
interface Answer {
  text: string;
  citations: Citation[];
  grounding: 'retrieved' | 'pasted' | 'none';  // 强制诚实：无依据必须 'none'
}

interface Citation {
  kind: 'chunk' | 'clip';   // 来自全文检索块，还是贴入的摘录
  id: string;               // chunkId 或 clipId
  page: number;             // 页码（chunk 来自读序还原的页锚点；clip 来自 anchor）
  snippet?: string;         // 仅 kind='chunk'：引用的原文片段
}
```

`grounding` 是**模块自己判定的**（不靠模型自觉）：`'retrieved'` = 全文检索有命中（可能同时有贴入内容）；`'pasted'` = 检索无命中但对话里有贴入摘录/图；`'none'` = 两者皆无，此时 `text` 必须是拒绝回答（「文档和贴入内容里都没有……」，不得编造）。一个字段编码整条诚实规则，测试可直接断言。

### 入口

```typescript
interface Chat {
  ask(doc: DocRef, turns: Turn[]): Promise<Answer>;
}

// 唯一注入点：模型端口（category 4，见 §4）
interface ModelPort {
  complete(req: ModelRequest): Promise<{ text: string }>;
}

interface ModelRequest {
  messages: ModelMessage[];
}
type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'image'; image: ImageData }> };

function createChat(deps: { model: ModelPort }): Chat;
```

**入口计数：1 个方法 `ask` + 1 个注入点 `model`。** `createChat` 是应用启动时的一次性接线，日常 caller（阅读器）只知道 `ask(doc, turns)`。Retrieval 的 `index`/`search`、读序还原、切块，全都不在 surface 上。

### 不变量 (Invariants)

1. **单文档封闭**：`ask` 绝不读写 `doc.id` 以外的索引；`citations[].page` 全部属于该 PDF。跨 PDF 检索不存在于这个 interface。
2. **快照语义**：`ClipSnapshot` 是贴入时刻的深拷贝；接口只持有值，后续对 Clip 的编辑/删除不回写进对话。调用方负责在贴入时快照（这是「贴入」这个动作的天然语义）。
3. **纯被动 + 无会话状态**：`ask` 是唯一触发点，无后台索引、无定时器。对话历史由调用方持有并每次传入（模块无状态）；索引只在首次 `ask` 内部懒触发。
4. **诚实性**：`text` 只能基于「检索块 + 贴入摘录/图 + 对话」；无依据时必须 `grounding:'none'` 并明说，不得编造。`citations` 只列实际用作依据的块/摘录。
5. **幂等索引**：同一 `doc.id` + 内容哈希只建一次索引；重复 `ask` 复用。索引随文档内容变化而重建，不随会话变化。
6. **ask 只 reject 两类情况**：模型端口失败、或 `turns` 违反契约（空、或末轮不是 user）。其余一切（抽取失败、检索无命中、无文本层）一律**降级**返回一个合法的 `Answer`，不 throw。

### 顺序 (Ordering)

单次调用内，严格五步，全部内部、caller 不可见：

1. 校验 `turns`（非空、末轮为 user）。
2. **确保索引**：`doc.id` + 内容哈希未建索引 → 抽取全文（pdf.js 逐项坐标）→ 双栏读序还原 → 切块 → embed + 写 FTS5。已建 → 跳过。
3. **检索**：取末轮 user turn 的 `text` parts 拼成 query → embed query → 相似度 + FTS5（+ 可选 rerank）→ top-k 块。末轮没有 `text` part → 跳过检索（grounding 最高 `'pasted'`）。
4. **组装 prompt**：system（诚实规则 + 「引用出处」指令）+ 检索块（带页号）+ 所有轮次里贴入的 clip 快照/图 + 对话。
5. **调模型 → 组装 Answer**：模型输出文本 → 解析引用 → 计算 `grounding` → 返回。

历史轮次的文本只作对话上下文，**只有末轮 text part 触发检索**——这是唯一 caller 需要知道的顺序事实。

### 错误模式 (Error modes)

只有两类 reject：

| kind | 何时 | retryable |
| --- | --- | --- |
| `contract` | `turns` 为空或末轮非 user（caller bug，非运行时失败） | 否 |
| `model` | 模型端口失败：`unconfigured` / `network` / `timeout` / `http` / `rate-limit` / `bad-output` | 是 |

**不存在的错误模式**：没有 `index-error`、没有 `no-text-layer`、没有 `empty-retrieval`——这些在「Retrieval 独立开 seam」的设计里是 caller 必须处理的 case，本设计里它们全部降级成 `grounding` 字段的取值，caller 只读一个字段。

### 性能特征 (Performance characteristics)

- **首次 `ask`（某文档）**：抽取 + 读序 + 切块 + embed 全量块。单篇论文数百~小几千块，bge-m3 快且便宜（$0.012/M，免费额度内），**秒级到十几秒，一次性**；按 `doc.id` + 内容哈希缓存，换会话/重开文档不重算。
- **后续 `ask`**：query embed + FTS5 + 模型 = **模型延迟主导**（秒级），检索毫秒级。
- **内存/存储**：单文档索引、namespace 隔离；一个文档的块 + 向量是常量规模。无跨文档状态。
- **不流式**：`Answer` 完整才 resolve。流式见 §5 取舍。

---

## 2. 用法示例 (Usage)

最常见 caller：打开 PDF → 问。**一个入口，一次调用。**

```typescript
// 打开文档后，阅读器已持有 pdf.js 句柄
const doc: DocRef = { id: 'paper-1512', document: pdfDocProxy };
const chat = createChat({ model: modelAdapterFromConfig(cfg) });

// 第一问 —— 触发索引 + 检索 + 回答
const answer = await chat.ask(doc, [
  { role: 'user', parts: [{ kind: 'text', text: '这篇论文的方法用了什么数据集？' }] },
]);
// answer.text        → 回答正文
// answer.citations   → [{ kind: 'chunk', id: '…', page: 3, snippet: '…' }, …]
// answer.grounding   → 'retrieved'
```

**贴摘录（快照）——同一个入口，贴入内容天然是对话的一部分：**

```typescript
const snapshot: ClipSnapshot = {
  id: 'clip-42',
  anchor: { page: 7, rect: { x: 56, y: 340, width: 210, height: 90 } },
  sourceText: '……（贴入时刻的原文拷贝）……',
  translation: '……',
};

const answer = await chat.ask(doc, [
  { role: 'user', parts: [{ kind: 'text', text: '总结这篇论文的方法。' }] },
  { role: 'assistant', parts: [{ kind: 'text', text: '……' }] },
  { role: 'user', parts: [
      { kind: 'text', text: '我贴的这段里的 baseline 是什么？' },
      { kind: 'clip', snapshot },   // 快照：此后在摘录面板里改译文/原文，不回写这里
  ] },
]);
// answer.citations 里既有 kind:'chunk'（全文检索）也有 kind:'clip'（贴入摘录），各自带 page
```

**贴图/公式图——还是同一个入口：**

```typescript
const answer = await chat.ask(doc, [
  { role: 'user', parts: [
      { kind: 'text', text: '这张图里的公式代表什么？' },
      { kind: 'image', image: { mime: 'image/png', bytes: formulaPng } },
  ] },
]);
```

**重试没有方法——函数本身就是重试**（不变量 3：无状态）：

```typescript
try { await chat.ask(doc, turns); } catch (e) { await chat.ask(doc, turns); }
// 首次失败若发生在索引阶段，重试会复用已完成的部分（幂等索引，不变量 5）
```

**interface 即测试面**（mock 模型即可测整条链路，无需暴露内部缝）：

```typescript
const mock: ModelPort = {
  complete: async (req) => ({ text: '……' }),  // 或按 req.messages 里的块断言
};
const chat = createChat({ model: mock });

// 断言 1：读序还原正确 —— 问一个答案依赖「右栏第一块」的问题，
//   mock 记录 system 里的块顺序，断言按双栏阅读顺序排列、page 正确。
// 断言 2：诚实性 —— 空 fixture（无文本层）→ answer.grounding === 'none'，text 含拒绝。
// 断言 3：快照语义 —— 贴入 clip 后改原 Clip，不影响已传入的 snapshot（值语义天然成立）。
```

---

## 3. 藏在实现后面的是什么 (Hidden implementation)

interface 之外的复杂度全部收在 `ask` 的实现里，caller 和测试都看不到：

- **双栏读序还原**（整份 cluster 里最容易写错的纯几何，也是 `architecture.md` 标注的切块缺口）：逐页取 `getTextContent()` 的 `TextItem.transform` 坐标 → 按 y 分栏（栏间 gutter 检测或 x 聚类）→ 按「栏序」而非「y 排序」拼接 → 记录每个 text run 的页码锚点。锁在一个私有纯函数里，通过 `ask` 测（mock 模型把 system 里的块顺序吐出来断言）。research-rag-stack §3.3 说「这一步错了，后面任何切块都救不回来」——所以它必须是最先做对、且只实现一次的地方。
- **切块器**：结构递归切分（section 标题优先 = by-title → 段落 → 句子），chunk_size 几百 token（远低于 bge-m3 8192 上限）、overlap 保留边界、表独立成块、公式并入段落文本流；每块前置「论文标题 + section 标题」的 contextual prefix（Anthropic 报 Contextual Embeddings 降 35%、再加 Contextual BM25 降 49%）。每块携带 `{ chunkId, page, snippet }`。
- **embedding + 存储（Retrieval 内部缝）**：这是原 `architecture.md` 里独立 `Retrieval` module 的全部内容，现在退为私有。`index(doc) → indexId` / `search(indexId, q, k) → chunks` 两个签名照旧保留，但只活在 Chat 的实现内部。embed = bge-m3（1024 维，Workers AI，ADR-0003）；存储 = D1 + FTS5（英文 unicode61 + 中文 trigram，ADR-0004）；查询 = query embed → 余弦 top-k，与 FTS5 bm25 混合，可选 bge-reranker 二次排序。
- **索引管理器（懒 + 幂等）**：`doc.id` + 内容哈希 → 索引是否已建；已建则跳过，未建则整条抽取→切块→embed 流水线跑一遍。内容哈希变化（文档被替换）自动重建。索引失败（如 PDF 损坏）→ 降级为空检索，`grounding` 落到 `'pasted'`/`'none'`，绝不 throw。
- **prompt 组装 + 引用解析**：system prompt（「只依据提供的原文块和贴入内容回答；每条论断标注出处页码；依据不足就明说」）+ 检索块（带页号）+ 贴入 clip 快照 + 图 + 对话 → 一次 `ModelPort.complete()` → 从输出解析引用（模型被要求按固定格式标注，adapter 先 repair 一次再抛 `bad-output`）→ 组装 `Answer`。**这段住在 ModelPort 的 adapter 里，不在 Chat 核心里**——prompt 调优只动 adapter。
- **grounding 判定**：检索有无命中 + 对话有无贴入 clip/图 → 一个三分支，纯函数，直接可测。

---

## 4. 依赖策略与 adapter (Dependency strategy)

按 DEEPENING.md 四类依赖分别交代：

- **pdf.js —— category 1（in-process）**。不是端口、不做 adapter、不进对外 surface。它随 `doc.document` 每次传入（`PDFDocumentProxy` 原样用，不包装）。读序还原是 **internal seam**：一个私有纯函数，通过 `ask` 测，也可被 Chat 自己的测试直接构造 fixture 页测（与 Recognizer 的 fixture PDF 同法，`getDocument(fixtureBuffer).getPage(1)` 无头构造）。

- **embedding + 存储 —— category 2（local-substitutable）**。**内部缝，不是对外端口。** 生产 adapter = Workers AI `@cf/baai/bge-m3` + D1/FTS5（Worker 的 `env.AI` / `env.DB`）；测试替身 = 本地 embedding（或 fixture 向量）+ 内存 SQLite（D1 的 SQLite 语义本地可复现）。替身在测试套件里跑，`createChat` 不需要为它加参数——它在实现里按环境装配。这正是 DEEPENING.md category 2 的规则：有本地替身就深合并，缝留在内部，不升到外部 interface。

- **model client —— category 4（true external）**。唯一必须注入的端口，且是 Chat 自己定义的窄端口 `ModelPort`（一个方法 `complete(req) → { text }`），不是原样注入共享 `ModelClient`：

  ```typescript
  interface ModelPort {
    complete(req: ModelRequest): Promise<{ text: string }>;
  }
  ```

  生产 adapter = `modelAdapterFromConfig(cfg)`：内部持一个 OpenAI 兼容 `ModelClient`（URL + key + model，一套代码覆盖 OpenAI / Gemini 兼容层 / OpenRouter / vLLM / Ollama，ADR-0005），把 §3 的 prompt 组装、多模态消息编码、引用标注 schema、repair 重试做掉，对外只剩 `complete(req) → { text }`。测试 adapter = mock。**两个 adapter = 真缝。**

- **seam 纪律（本设计的分野）**：对外 seam 只有一个——`ask(doc, turns)`。`ModelPort` 是 config-time seam（构造期注入一次）。pdf.js 与 Retrieval 都是**内部缝**，绝不从 interface 露出。**Retrieval 被降级的关键理由**：它今天只有一个 caller（Chat），「知识库/书架跨 PDF 检索」是尚未发生的需求——按「一个 adapter = 假想缝」的纪律，为一个假想需求开一个外部 seam 是应删除的 indirection。**当知识库真要做跨 PDF 检索（第二个 adapter）时**，Retrieval 的内部 `index`/`search` 签名原样提级为外部 module，且其测试就是现成的种子——升级不返工，但现在不付 surface 税。同理：读序还原、切块、prompt、引用解析都不从 interface 露出。

---

## 5. 取舍 (Trade-offs)

**leverage 高的地方**——读序还原 + 切块 + embed/FTS5 检索 + prompt 组装 + 引用 + 诚实性判定，六件事只实现一次，藏在**一个方法**后面。N 个 caller（当前文档的问答、未来任何「就这个文档问一句」的入口）免费拿到全套能力，测试也穿过同一条缝。deletion test：删掉 `ask`，这六件事会原样出现在每一个 caller 里（caller 得自己排「先索引再检索再组装」的顺序）——它挣到了自己的位置。

**thin 的地方——deliberate**。`ModelPort` 是浅的（一个方法，adapter 基本是 passthrough：`ModelClient` + prompt）。单个 adapter 浅、Chat 核心深——深度不平均分布，全在 `ask` 的实现里。这是「一个深模块 + 一个窄缝」，不是「一圈浅 adapter 围一个深编排器」。

**seam 决策的代价（要认账）**：把 Retrieval 藏进 Chat，意味着**知识库跨 PDF 检索真的落地那天，要动一次手术**——从 Chat 内部把 `index`/`search` 提出来。我赌的是：手术成本 ≈ 0（签名原样提级、测试照搬），而今天为一个还没发生的需求维护一个外部 `Retrieval` seam + 一个 `indexId` 概念，是每个 caller 和每份测试都要付的税。若知识库被证明是近期硬需求，本设计会向「Chat + Retrieval 双 seam」的形状坍缩——那时我认输，但现在我赌它不发生。

**代价清单**：

1. **放弃流式**：答案逐 token 出现，本设计没有。`ask` resolve 即完整 `Answer`。若流式成硬需求，升级路径是加第二个方法 `askStream(doc, turns) → AsyncIterable<AnswerChunk>`（流式 text + 末尾完整 citations），interface 从 1 变 2 个方法——仍在「1–3 入口」约束内，但我不预支这个入口。
2. **首次提问延迟**：索引懒加载在第一次 `ask` 里，第一问要等整篇论文 embed 完（秒级到十几秒）。代价换的是「不暴露索引入口 + 纯被动」。缓解：幂等缓存让重开文档/换会话不重算；若论文体积大，未来可在「打开文档」这个用户动作里预热——那是在模块内部加一条非接口路径（open 时 fire-and-forget 预热），**interface 一个字不改**。
3. **放弃 `index`/`search` 公开**：调试索引质量、独立跑检索，都走 Chat 的 internal seam（自己的测试），不走对外 interface。这与「interface 即测试面」不冲突——对外缝测可观察行为（引用页号、grounding），内部缝测读序/切块细节。
4. **引用精确性依赖模型**：`citations` 是模型按 schema 输出的、模块解析的，模型可能标错页号或漏标。缓解：system prompt 强制、adapter repair 一次、`grounding` 不依赖模型（模块自己算）。这是所有 RAG 的固有问题，不因 interface 而加剧。
5. **`grounding` 是模块对「输入可得性」的判定，不是对「模型实际用了什么」的判定**：检索有命中但模型没用、贴了摘录但模型没读——这类更深的事实模块无从得知。我只承诺「无依据时绝不编造」，不承诺「有依据时答案一定可靠」。这是诚实的边界，也是为什么 `grounding` 只取三个值而非五个。

**一句话总结**：这是「窄而深」的 module——一个方法、一个注入点、三字段 Answer，把「先索引→再检索→再组装」的整条流水线和双栏读序这个最容易错的几何，压在一个 `ask` 后面。它把 Retrieval 从 module 降成内部缝、把索引从入口降成懒加载副作用，换来的是：阅读器只用学一个函数，其余全是实现。

# Chat（问文档）设计 ——「打开 PDF，开口就问」（为 问文档 压到零仪式）

> 竞争设计之一。姊妹篇：`design-chat-2-*.md`（宽而平）、`design-chat-3-*.md`（深而窄）。约束：**优化最常见的调用方——打开一个 PDF 然后提问**。

三个悬而未决的问题，本设计一次收口：

1. **Retrieval 是独立模块还是内部缝？** → **内部缝**。今天只有 Chat 一个调用方，一个 adapter = 假想缝，不外露。等「知识库跨 PDF 检索」这个第二个调用方真的出现，再把它提成公共模块。
2. **答案要不要带来源？** → **带**。`Answer.sources` 每个元素是「页码 + chunk 逐字片段」，UI 据此渲染引用、点击跳页。
3. **索引何时触发？** → **首次提问自动索引**，藏在 `ask` 内部；显式 `reindex()` 是 rare 逃生口。

## 1. 接口 (Interface)

模块对外两个方法、一次构造。依赖在构造时绑定一次（与 Recognizer 同款），每次提问不出现 `docId`、不出现索引仪式、不出现 prompt 组装。

```ts
// ===== 输入基础类型（复用 Recognizer 既有定义）=====
interface Screenshot { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array; width: number; height: number }
interface Anchor { page: number; rect: Rect }

// ===== 摘录快照（paste-time 拷贝；之后对 Clip 的编辑不回写）=====
interface ClipSnapshot {
  sourceText: string | null;   // 原文逐字；null ⟺ 纯图
  translation?: string;        // 译文
  multimodal?: string;         // 图/表一句话描述（公式的 LaTeX 在 sourceText）
  images: Screenshot[];        // 抠出的图（公式区 = 区域截图）
  screenshot: Screenshot;      // 整块区域截图（ground truth）
  anchor: Anchor;              // 回跳原文
  note?: string;               // 读者笔记
}

// ===== 附件：贴进对话的两种东西 =====
type Attachment =
  | { kind: 'clip'; clip: ClipSnapshot }   // 贴入一个摘录（快照）
  | { kind: 'image'; image: Screenshot };  // 贴入一张裸图（公式/截图/剪贴板图）

// ===== 会话（不透明、可序列化；调用方只透传，不解释）=====
interface Session { readonly __brand: 'chat-session' }

// ===== 调用 =====
interface AskRequest {
  text: string;                 // 本轮提问；仅贴图/摘录时可 ''
  attachments?: Attachment[];   // 本轮贴入（快照语义）
  session?: Session;            // 上一轮 Answer.session；首轮省略
  options?: AskOptions;
}
interface AskOptions {
  skipRetrieval?: boolean;      // rare：不索引不检索，只基于贴入内容回答（扫描件/只想聊摘录）
}

// ===== 返回 =====
interface SourceRef {
  page: number;   // 1-indexed 页码，UI 跳页用
  text: string;   // 命中的 chunk 逐字片段（引用即证据）
}
interface Answer {
  text: string;           // 答案正文
  sources: SourceRef[];   // 全文检索命中来源（按相关度排序、去重、截到 top-k）
  session: Session;       // 传给下一轮
}

// ===== 错误 =====
class AskError extends Error {
  kind: 'empty-request' | 'index-failed' | 'model-unavailable' | 'model-refused' | 'bad-output'
}

// ===== 端口（category 4，构造期注入；与 Recognizer 共用同一个 ModelClient）=====
interface ModelClient {
  complete(req: { messages: { role: 'user' | 'assistant'; content: string }[]; images: Screenshot[] }): Promise<{ text: string }>
}

// ===== 内部缝（category 2，只出现在构造处，不成为公共方法）=====
interface Embedder { embed(texts: string[]): Promise<Float32Array[]> }  // bge-m3（本地或 CF，ADR-0003/0006）
interface IndexStore { /* SQLite FTS5(trigram) + 向量行（ADR-0004/0006）——不外露，见 §3 */ }

// ===== 构造与配置（rare，全有默认值，普通调用方不碰）=====
interface ChatConfig {
  chunkSize?: number;     // 目标 chunk token 数，默认 ~500
  chunkOverlap?: number;  // 块间重叠 token，默认 ~50
  topK?: number;          // 检索 top-k，默认 8
  targetLang?: string;    // 答案语言，默认 'zh'
}
interface ChatDeps {
  document: PDFDocumentProxy;  // category 1，当前 PDF（单文档边界在此锁死）
  model: ModelClient;          // category 4
  embeddings: Embedder;        // category 2（内部缝）
  store: IndexStore;           // category 2（内部缝）
  config?: ChatConfig;
}

// ===== 模块 =====
interface Chat {
  ask(req: AskRequest): Promise<Answer>;
  reindex(): Promise<void>;   // rare：强制重建索引
}
function createChat(deps: ChatDeps): Chat
```

**不变量：**

1. **单文档**：`document` 在构造处绑定一次，`ask` 不带 `docId` 参数——跨 PDF 在类型层就不可能。Chat 永不访问其他 PDF。
2. **快照**：`attachments` 是 paste-time 的 plain-data 拷贝。`ask` 返回后调用方再改 `Clip`，不影响本轮与历史。Chat 只读，绝不写回 `ClipStore` / `KnowledgeBase`。
3. **纯被动**：除了调用方显式调 `ask` / `reindex`，Chat 不做任何后台工作。索引只在首次 `ask`（或显式 `reindex`）时发生。
4. **首次提问自动索引**：首次 `ask` 若索引缺失，内部 extract → chunk → embed → FTS5，完成后才检索/回答。调用方零索引仪式。
5. **会话不透明**：`Session` 是可序列化的不透明 token，调用方只透传（可存盘、可跨重启）。对话历史、超长压缩、检索缓存全在 token 内部，调用方不管理。
6. **来源可回跳**：`sources` 每个 `page` 都能让 UI 跳回原文；`text` 是 chunk 的逐字片段。贴入的摘录已在对话中可见（其 anchor 自带回跳），**不重复引用**——`sources` 只引全文检索命中。
7. **每轮成本可预期**：索引就绪后、无附件时，一轮 `ask` = 1 次 query embedding + 1 次本地检索 + 1 次 `model.complete`。

**顺序：** `createChat`（每文档一次）→ `ask`（每轮一次）。`reindex` 任意时刻可调，幂等。`ask` 内部：① 校验（`text === ''` 且无附件 → reject `empty-request`）；② 除非 `skipRetrieval`，否则索引未就绪 → 建索引；③ 组装上下文 = 检索命中 chunks + 本轮 attachments + session 解出的历史；④ 一次 `model.complete`；⑤ 解析来源 → `Answer`。

**错误：** `empty-request`（校验）；`index-failed`（抽取/切块/嵌入失败，罕见，首问时 reject）；`model-unavailable` / `model-refused` / `bad-output`（与 Recognizer 同款 kind）。索引失败不毒化后续——修好重试 `ask` 或 `reindex` 即可。

**性能：** 首问冷启动 = 索引时间（单篇论文全文抽取 + 批量嵌入，秒级到几十秒）+ 1 次检索 + 1 次模型调用；此后每轮 = 1 次 query embedding（毫秒级，本地）+ 本地检索（FTS5/向量，毫秒级）+ 1 次模型调用（秒级，取决于用户配的模型）。索引落本地 SQLite，不常驻内存；local-first（ADR-0006）无 egress。

## 2. 用法示例 (Usage)

```ts
// 打开 PDF 时（一次）——embedding 与 store 用本地替身（ADR-0006），测试换内存替身
const chat = createChat({ document: pdfDoc, model: modelClient, embeddings, store });

// 首问：索引在此刻自动发生，一次模型调用，带回来源
const a1 = await chat.ask({ text: '这篇论文的核心贡献是什么？' });
render(a1.text, a1.sources);              // sources → 点击跳页

// 追问：传回 session，不再索引
const a2 = await chat.ask({ text: '和基线相比好在哪？', session: a1.session });

// 贴入一个摘录 + 提问（一次调用；clipSnapshot 是 paste 时刻的拷贝）
const a3 = await chat.ask({
  text: '这段的公式为什么成立？',
  attachments: [{ kind: 'clip', clip: clipSnapshot }],
  session: a2.session,
});

// 只贴一张图、不说话（text 可省）
const a4 = await chat.ask({ attachments: [{ kind: 'image', image: formulaScreenshot }], session: a3.session });

// rare：换了切块参数 / 文档文件被替换后，手动重建
await chat.reindex();

// rare：扫描件只想聊摘录，跳过全文索引
const a5 = await chat.ask({ text: '这几段摘录的共同结论是？', attachments: [...], options: { skipRetrieval: true } });
```

调用方（UI）维护自己的消息列表用于渲染；`Session` 只是 Chat 的续聊凭据，两者各管各的，互不泄漏。

## 3. 藏在实现后面的是什么 (Hidden implementation)

- **双栏阅读顺序还原**：`ask` 首次触发索引时，用 pdf.js `TextItem.transform` 坐标按 y 轴分栏、栏内 x 升序、栏序拼接成线性文本。research §3.3.6 的「这一步错了后面全救不回来」的逻辑，调用方完全无感。
- **切块**：section 标题边界优先（by-title）→ 段落→句子递归 → overlap → 表独立成块 → 每块前置「论文标题 + section 标题」的 contextual prefix。参数在 `ChatConfig`（全默认），普通调用方不碰。
- **混合检索**：FTS5（英文 unicode61 + 中文 trigram 子串）+ bge-m3 向量余弦，融合排序 → top-k。query embedding 每轮一次；chunk embedding 只在索引期批量做。
- **上下文组装**：检索命中 chunk（带页码）+ 贴入摘录快照（原文/译文/描述作为文本、`images` 作为图随消息发、公式 LaTeX 以文本发）+ session 解出的历史 → 一条 prompt。当前轮的图进 `images`；历史轮次的图以其 `multimodal` 描述文本进入历史，不进 `images`。
- **来源解析**：让 model 以 `[n]` 标注引用对应 chunk 序号，内部解析回 `SourceRef{page, text}`（排序、去重、截 top-k）。model 不配合时降级为 `sources: []`，**不崩**、答案照常返回。
- **会话压缩**：`Session` 内部保存历史；接近 token 预算时自动摘要压缩（不影响答案），或简单截断。逻辑与格式全部私有。
- **索引缓存与失效**：以「文档身份（文件 hash）+ chunk 配置 hash」为键存本地 store；`reindex()` 强制失效重建。同一文档并发首问会重复索引（幂等，浪费一次而非损坏）。
- **内部缝**：extract（阅读顺序）、chunk、embed、search、prompt 组装、source 解析各自私有，只被自己的测试穿过；对外只有 `ask`（+`reindex`）。

## 4. 依赖策略与 adapter (Dependency strategy)

按 DEEPENING.md 四类逐一落位：

- **pdf.js —— category 1（in-process）**：不做 port。`PDFDocumentProxy` 只在构造缝出现一次，测试用 fixture PDF 直测 `ask`。
- **embedding（bge-m3）+ store（SQLite FTS5 + 向量）—— category 2（local-substitutable）**：**内部缝，不是公共端口**。测试用「内存 SQLite + 确定性 stub embedder」直测 `ask`；生产用「本地 SQLite FTS5 + 本地 bge-m3」（ADR-0006 的 local 形态；CF Workers AI / D1 是等价替身）。替换发生在内部缝，调用方无感。
- **ModelClient —— category 4（true external）**：真缝。**复用 Recognizer 已经有的同一个 `ModelClient` 端口**（HTTP adapter + mock adapter 都已存在），不为 chat 另造端口。Chat 拥有 prompt 组装、`[n]` 引用协议与来源解析，adapter 保持极薄。
- **对外缝 = `ask` + `reindex`**；pdf.js、embedding、store、检索全部是内部缝，不暴露。

**Retrieval 缝的收口（回答 open question）**：Retrieval 是 Chat 的**内部缝**，不是公共模块。依据「一个 adapter = 假想缝」——今天只有 Chat 一个调用方，把它当公共模块暴露 `index/search` 就是为不存在的第二个调用方付接口税。`raw search` 这个 rare need 今天没有消费者，不在任何公共接口上。当「知识库跨 PDF 检索」成为真实的第二个调用方（两个 adapter = 真缝）时，再把 extract/chunk/search 从 Chat 内部提出来成为独立 `Retrieval` 模块，接口不动 Chat——那时 `Chat` 只是把 `Retrieval` 当 category 2 依赖注入进来。

## 5. 取舍 (Trade-offs)

**杠杆高：** 双栏还原 + 切块 + 混合检索 + 上下文组装 + 来源解析 + 会话管理，全部压进 `ask`（+ 一个 rare 的 `reindex`）。调用方零索引仪式、零历史管理、零 prompt 组装、零 docId。「首次提问自动索引」吞掉「何时索引」的整个决策；「不透明 session」吞掉「谁管历史」；「快照 attachment」吞掉「贴摘录」的组装。一次实现偿还 N 个调用点与 M 个测试。

**薄（诚实标注）：** `reindex()` 是唯一的二级 surface，极薄；`AskOptions` 只有一个 `skipRetrieval`。没有流式输出（pending Promise 即进度，与 Recognizer 同款——若将来流式成硬需求，在 `Answer` 上扩展 `onDelta` 回调或返回 stream，不破坏 `ask` 签名）。没有批处理/多问题并发（调用方 `Promise.all` 自行组合）。没有取消。

**激进点与代价：** ① 不暴露 `search()`——「原始检索」今天没有消费者，暴露就是浅模块；代价是调试/评测检索质量时要穿过内部缝（用内部 seam 的测试或临时 export，不进公共接口）。② 历史由 session token 托管——调用方不能直接改写/删除历史某条消息；代价是「编辑历史」这类操作 v1 不提供（要重建 session 或后续加方法），接受。③ 来源解析依赖 model 配合输出 `[n]` 引用标记——model 不配合时降级为无来源，不崩但体验降级。④ 索引以文件 hash 为键——同一 PDF 双窗口并发首问会重复索引一次（幂等、浪费一次而非损坏），接受；`skipRetrieval` 兜住「不想付索引成本」的罕见路径。

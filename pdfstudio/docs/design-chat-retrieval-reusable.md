# Chat + Retrieval（问文档）设计 ——「一等索引」版（最大化可复用面）

> 竞争设计之一。姊妹篇：`design-chat-retrieval-minimal.md`（最小）、`design-chat-1-common-caller.md`（最顺默认）。

核心立场：**Retrieval 是一等模块、有自己的缝**——`openIndex` + `Index` 句柄。Chat 只是它的一个 caller，知识库（跨 PDF 检索）与书架（全文搜索）复用同一个 interface。答案带结构化引用（出处页码 + 原文片段，来自 retrieval provenance，不赌模型配合）。索引触发 = 首次 `ask`（懒 + memoized）+ 显式 `reindex`。

## 1. 接口

### 1.1 Retrieval —— `openIndex` + `Index`

```ts
type EmbedderName = 'bge-m3' | 'qwen3-embedding-0.6b'
interface ChunkPolicy {
  maxTokens: number; overlapTokens: number; respectSections: boolean
  tableAsOwnChunk: boolean; contextualPrefix: 'none' | 'title' | 'title+section'
}
interface IndexConfig {
  scope: 'document' | 'bookshelf' | 'knowledge'   // 只影响默认策略，不影响能力
  chunk: ChunkPolicy; embedder: EmbedderName; tokenizer: 'unicode61' | 'trigram'
}

openIndex(config: IndexConfig): Promise<Index>
listIndexes(): Promise<IndexSummary[]>

interface Index {
  readonly id: IndexId
  index(source: IndexSource, opts?: IndexDocOptions): Promise<IndexingReport>
  reindex(docId: string, opts?: IndexDocOptions): Promise<IndexingReport>
  remove(docId: string): Promise<void>
  search(query: Query, opts?: SearchOptions): Promise<SearchResult>
  stats(): Promise<IndexStats>
  drop(): Promise<void>
}

// 复用性的支点：同一套索引既能吃 PDF 原始字节，也能吃已定位文本
type IndexSource =
  | { kind: 'pdf'; docId: string; data: ArrayBuffer; fileName?: string }
  | { kind: 'text'; docId: string; title?: string; items: PositionedTextItem[] }
interface PositionedTextItem { str: string; page: number; x: number; y: number; width: number; height: number }

interface IndexDocOptions { readingOrder?: 'auto' | 'single-column' | 'two-column'; chunk?: Partial<ChunkPolicy> }
interface IndexingReport { docId: string; indexId: IndexId; chunkCount: number; tokenCount: number; readingOrder: 'single-column' | 'two-column'; durationMs: number }

type SearchMode = 'hybrid' | 'semantic' | 'keyword'
interface SearchOptions {
  k?: number; mode?: SearchMode
  filter?: { docIds?: string[]; pageRange?: { from: number; to: number } }
  weights?: { vector?: number; keyword?: number }; rerank?: boolean; scoreThreshold?: number
}
interface RetrievedChunk { chunkId: string; docId: string; page: number; text: string; score: number; matchKind: 'vector' | 'keyword' | 'both'; snippet: string }
```

**不变量：** ① index 幂等且原子（同 docId 重复 = 覆盖；同输入同策略 → 同计数）；② search 只见已 commit 的完整索引，不见中间态；③ 出处不变式——`RetrievedChunk.page` 必须指向真实 PDF 页，`text` 保留 `PositionedTextItem` 原始顺序；④ 快照不变式——Chat 贴入的 clip/image 是 paste 时刻副本，Retrieval 不感知。

**顺序：** `openIndex` 先于 index/search；search 可在 index 之前调用（空索引返回空结果）；reindex = remove + index 的原子版。

**错误：** 不可解析 PDF → `ExtractionError`（不 commit）；embedding 不可达 → `IndexUnavailableError`（回滚可重试）；扫描 PDF 无文本层 → `IndexingReport{chunkCount:0}`（不报错，提示先走 Recognizer）；大文档超事务上限 → 内部分批、对外仍原子。

**性能：** index 冷启动 = pdf.js 提取（线性页数）+ embedding（线性块数），单篇论文目标 < 10s；search 热路径 FTS5 < 10ms + 单 PDF 规模 brute-force cosine < 50ms；rerank 加一次 Workers AI 往返。

### 1.2 Chat —— `ask` + `reindex`（编排面，单文档）

```ts
interface Chat {
  ask(req: AskRequest): Promise<AskResult>
  reindex(docId: string): Promise<IndexingReport>
}
interface AskRequest { docId: string; messages: Message[]; clips?: ClipSnapshot[]; images?: ImageAttachment[] }
interface ClipSnapshot { clipId: string; sourceText: string; translation?: string; image?: ImageAttachment; page: number; anchor?: {x:number;y:number}; note?: string }
interface ImageAttachment { mimeType: string; dataUrl: string }
interface Message { role: 'user' | 'assistant'; content: string }
interface AskResult { answer: string; citations: Citation[]; usedClips: string[] }
interface Citation { chunkId: string; page: number; quote: string; clipId?: string }
```

**Chat 侧不变量：** 贴入的 clip/image 不进索引、不 embedding，直接拼进 model context；`citations` 由 retrieval provenance 生成（page + quote），与模型是否输出 `[n]` 标记无关。

## 2. 用法示例

```ts
// 打开 PDF：只建句柄，不算任何东西
const docIndex = await openIndex({ scope: 'document', chunk: {...}, embedder: 'bge-m3', tokenizer: 'trigram' });
const chat = new Chat({ index: docIndex, model, pdfSource });

// 第一次 ask：Chat 内部发现 docId 未索引 → index() → search()
const r = await chat.ask({ docId, messages: [{ role: 'user', content: '这篇论文的双栏阅读顺序怎么处理？' }] });
// r.citations 每条有 page + quote

// 贴摘录快照 + 图
const r2 = await chat.ask({ docId, messages: [{ role: 'user', content: '结合这段公式解释它的假设。' }], clips: [snapshot(clip)], images: [formulaImage] });

// 知识库跨 PDF 检索（同一 interface，换 scope）
const kb = await openIndex({ scope: 'knowledge', ... });
await kb.index({ kind: 'text', docId: sourceDocId, title: claim.source, items: evidenceItems });
const hits = await kb.search({ text: '跨文档找关于 stance 的证据' }, { k: 20, mode: 'hybrid' });

// 书架全文搜索（keyword-only）
const shelf = await openIndex({ scope: 'bookshelf', ... });
await shelf.search({ text: 'reducer' }, { mode: 'keyword', filter: { docIds: [a, b] } });
```

## 3. 藏在实现后面的是什么

1. **双栏阅读顺序还原**（最难的"分块缺口"）：pdf.js `TextItem.str + transform` → 归一化 `PositionedTextItem` → y 分行、x 分布直方图双峰判双栏 → 栏内自顶向下、栏间自左向右拼接。
2. **切块**：结构递归（section 标题 → 段落 → 句子），respectSections / tableAsOwnChunk / contextualPrefix / overlap。
3. **双写索引**：D1 三张表 `chunks` + `fts5`（trigram）+ `vectors`（1024 维 blob）；单 PDF 规模 brute-force cosine 足够，不上 Vectorize——storage 是内部缝，换 Vectorize 不碰 interface。
4. **hybrid 打分归一化**：bm25 与 cosine 各自归一化 [0,1]，按 weights 加权（默认 0.6/0.4），输出单一 score + matchKind。
5. **generation 指针 + 原子 swap**：reindex 写新 generation 再原子切指针，search 期间不停。

## 4. 依赖策略与 adapter

| 依赖 | 类别 | 缝 | adapter |
|---|---|---|---|
| pdf.js | 1 in-process | Retrieval 内部缝 | 无；fixture PDF / 直接喂 `kind:'text'` |
| embedding（bge-m3） | 2 local-substitutable | Retrieval 内部缝 | 生产 Workers AI；测试确定性假向量 |
| 存储（D1+FTS5+向量） | 2 local-substitutable | Retrieval 内部缝 | 生产 D1；测试 SQLite/PGLite |
| ModelClient | 4 true external | Chat 外部缝（真缝） | 生产 HTTP；测试 mock |
| PdfSource（取字节） | 2 local-substitutable | Chat 依赖端口 | 生产书架 getBytes；测试 fixture |

seam 纪律：Retrieval 外部缝只有一个（`openIndex`/`Index`），pdf.js/embedding/存储是内部缝，测试站在 index/search 上断言。embedder/tokenizer/chunk 只是 config 数据（选 adapter 的名字），不把 adapter 对象塞进接口。

## 5. 取舍

**杠杆高：** 读序 + 切块 + hybrid 打分 + 出处溯源四件难事全藏在 index/search 后面，三个 caller（Chat/知识库/书架）各只学 5 个方法。`IndexSource` union 是复用支点——知识库跨 PDF 检索、书架全文搜索不新增代码路径，只换 scope 与 source.kind。

**薄的地方：** stats/listIndexes/drop 是生命周期簿记；ModelClient 保持浅 adapter；IndexConfig 是纯数据（caller 填名字不接对象）。

**代价：** ① 5 方法 + config 比基线 `index(doc)/search(indexId,q,k)` 面大，换来 reindex/filter/weights/mode/rerank 未来需求今天就有落点；② config 过度参数化风险（ChunkPolicy 五旋钮 + SearchOptions 八旋钮）——护栏是默认值让"什么都不配"就是正确行为；③ scope 是暗示不是能力，文档必须写死；④ citation 保真拆成「必然返回的 provenance」+「尽力而为的模型 [n] 标记」，前者不赌模型。

# PDF Studio 模块图（Module Map）

用 codebase-design 词汇描述：**module**（模块）、**interface**（接口）、**seam**（缝）、**adapter**（适配器）、**depth**（深度）、**leverage**（杠杆）、**locality**（局部性）。

## 模块与 seam

| 模块 | 职责 | 对外 interface | 依赖（类别） | 深浅 |
|---|---|---|---|---|
| `Recognizer`（识别） | 区域 → ClipContent。**两件事**：按文本覆盖度选路由（文本层 / 视觉模型），以及编排识别与翻译两个模块 | `recognize(region, options?) → ClipContent`（异步） | pdf.js（in-process）、ModelClient ×2（external 端口，识别与翻译各一个实例） | **深** |
| `Clip`（摘录） | 状态机（框选→识别→待编辑→已入库）+ 合法性 + 入库 | 纯 reducer：`reduce(state, action)` / `can(state, action)` | 无 I/O（in-process） | **深**（原型已验证） |
| `Chat`（问文档） | 单文档问答：全文检索 + 贴入摘录/图 → 答案 | `ask(turns) → Answer`（含 citations + grounding） | ModelClient（+ 内部缝：读序/分块/embedding/FTS5） | **深** |
| `KnowledgeBase`（知识库） | context 聚合，入库 + 查询，供 blogstudio 消费 | `promote(clip, {claim,stance}) → context` / `list` / `get` | 持久化 | 中 |
| `ModelClient`（模型客户端） | 用户配的 OpenAI 兼容端点。**一个契约、多个实例**——识别 / 翻译 / chat 各注入各的（ADR-0010） | `complete(request) → response` / `streamComplete(request) → chunks` | true external | 浅（adapter） |
| `ModelLibrary`（本地模型库） | 本地模型的下载、校验、存放与进程生命周期（ADR-0001 修订的「一键下载」） | 未定 | 文件系统 + 子进程 | 浅（**尚未实现**） |
| `ClipStore`（摘录库） | 摘录持久化（锚定到 PDF） | `save` / `listByPdf` / `delete` | 持久化 | 浅（adapter） |
| `Bookshelf`（书架） | PDF 列表：上传/浏览/打开 | CRUD | 持久化 | 浅 |
| `Config`（配置） | 读/写 config JSON。**按功能分组**（识别/翻译/chat/embedding/补 claim 各一组 url+key+model），需要「跟随默认」以免读者填五遍 | `load()` / `save()` | 本地文件 | 浅（adapter） |

## 核心循环（数据流）

```
截图(UI)
  → Recognizer.recognize(region) → ClipContent
  → Clip.reduce(create(content))  → 摘录（标签/小窗可编辑）
      ├─ 选取 → Chat.ask(..., {clip 快照, images})      （快照语义）
      └─ 入库 → KnowledgeBase.promote(clip, {claim, stance}) → context
```

## 依赖类别（DEEPENING.md）

1. in-process（纯计算/内存）· 2. local-substitutable（有本地替身）· 3. remote but owned（自己的服务，port+adapter）· 4. true external（第三方，注入端口，测试 mock）

## seam 纪律

- 一个 adapter = 假想缝；两个 adapter（生产 + 测试）= 真缝。`ModelClient` 是真缝（HTTP adapter + mock adapter），共享契约见 ADR-0009，两者由 `test/model-client-contract.ts` 的同一组契约测试各跑一遍——fake 一旦比真端点宽容，测试就会说谎。
- `Recognizer` 对外缝是 `recognize`；pdf.js / ModelClient 是其内部缝，不暴露。`Recognizer` 使用 `complete`，Chat 使用 `streamComplete`。
- `Clip` 保持纯（无 I/O），持久化交给 `ClipStore` / `KnowledgeBase`——接口即测试面。

## 加深顺序（deepen 优先级）

1. **`Recognizer`** —— 接口最开放、隐藏复杂度最大（覆盖度路由、transform 坐标、抠图、markdown 组装、编排识别与翻译）。
2. `Chat`（含内部检索缝）—— 分块缺口（双栏阅读顺序）落在这里；Retrieval 不独立开缝，见 `chat-retrieval-interface.md`。
3. `Clip` —— reducer 已定型，主要是把它从原型提进来并补齐 4 个未定 case 的最终语义。

## 落地进度（2026-08-14）

`Recognizer` / `Clip` / `Chat` / `ModelClient` 都已有实现与测试（60 条，全绿），canonical 接口见各自的 `*-interface.md`。两处**已知不够用的基线**，都在代码注释里写明了替换条件：

- `Chat` 的检索：读序仍是 pdf.js 原始顺序（双栏会交错）、打分是关键词重合（中文问英文论文一分打不出来）。替换方向见 `research-local-rag-stack.md`，标注 eval 在 `eval/retrieval/`。
- 本地识别：`ModelClient` 的生产 adapter 只覆盖 OpenAI 兼容的对话式端点。PaddleOCR-VL 这类只认固定 prompt 的专用识别模型需要一层新的 adapter，见 `research-local-ocr-engine.md`。

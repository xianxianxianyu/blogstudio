# ADR-0010：每个 AI 功能独立配置自己的模型

## 状态

Accepted（2026-08-14）

## 背景

ADR-0001 的修订把视觉路由改成本地/云端双引擎后，`research-local-ocr-engine.md` 的一手证据暴露出一个协议层看不见的问题：

**协议兼容 ≠ prompt 兼容。** PaddleOCR-VL 有官方 GGUF、官方 `llama-server` 文档、llama.cpp 上游已合并，HTTP 层完全落在现有 `ModelClient` 端口后面。但它是 **element-level 识别模型**，只接受六个固定 prompt（`OCR:` / `Formula Recognition:` / `Table Recognition:` / `Chart Recognition:` / `Seal Recognition:` / `Spotting:`），**不遵循 JSON schema，也不做翻译**。

而 `Recognizer` 的 `visionPrompt` 是一次调用要回 `{ kind, sourceText, translation, multimodal }` 的 JSON。这个形状是照着**云端通用 instruct 模型**定的——不变量 3「恰好一次 `model.complete`」把「识别」和「翻译」焊成了一次调用。焊死的后果是：任何不会翻译的识别模型都进不来。

## 决策

**每个 AI 功能独立配置自己的模型端点**，而不是全应用共用一个。当前的功能清单：

| 功能 | 适合的模型 |
|---|---|
| 识别（OCR / 公式 → LaTeX / 图理解） | 专用识别模型（本地 PaddleOCR-VL）或通用多模态模型 |
| 翻译 | 高速文本 LLM，不开思考——这类模型翻得又快又好，让识别模型顺手翻是另一回事 |
| chat（问文档） | 会推理的对话模型 |
| embedding（检索） | 专用 embedding 模型，见 `research-local-rag-stack.md` |
| 补 claim（入库时） | 对话模型 |

业务流上仍由各模块串起来，读者看到的仍是一次截图得到一条双语摘录；但每个功能各配各的端点与模型，可以一个本地一个云端，也可以都本地。

**这不是把一个大模型拆成小模型，而是承认这些是不同的活。** 识别要的是版面与公式的保真，翻译要的是语言质量与速度，检索要的是向量空间——把它们焊在一个端点上，是拿最贵的模型干最不需要它的活，同时还挑不出更擅长某一项的模型。

## 后果

### 被推翻的不变量

- **不变量 3「恰好一次 `model.complete`」作废。** 它原本表达的是「不为一个区域重复烧钱」，但实现方式绑死了「一个模型干完所有事」。替代它的是更弱也更诚实的一条：**每个模块对一个区域至多调用一次**。
- **「零成本」不变量收窄。** 原文是「`route === 'text'` ⟹ 从未调 `model.complete`」。拆开后，text 路由的**识别**仍然零成本（pdf.js 文本层，不调任何模型），但**翻译**会调翻译模块。改成：**text 路由从不调用识别模块**。

### 被修好的缺口

拆分顺带修掉一个一直存在的矛盾：`CONTEXT.md` 说「摘录持有双语 markdown——逐字的原文、**其译文**」，但路由规则表里「数字 PDF 文本区」的 translation 一栏是 `—`。**数字 PDF 的文字摘录一直没有译文**，而那恰恰是最常见的摘录类型。焊在一起时这个缺口不好补（补它就要为纯文本区调一次视觉模型）；拆开后，text 路由的原文直接送进翻译模块即可。

### 代价

- `RecognizerDeps` 从单个 `model: ModelClient` 变成分功能的依赖，接口与测试都要改。
- 一个区域可能产生两次网络调用而非一次。对云端档是成本上升；对本地档无所谓。
- 设置界面要按功能提供多组配置，而不是一组。配置项多了，所以需要一个「跟随默认」的选项——只配一个端点的读者不该被迫填五遍。

## 边界

- 拆的是**配置与调用**，不是领域概念。摘录仍然是一个整体，读者不感知两次调用。
- 所有功能共享同一个 `ModelClient` 契约（ADR-0009），**不新增端口类型**——差异只在注入哪个实例。这是拆分代价小的根本原因：缝的位置本来就对。
- embedding 是唯一形状不同的（输入文本、输出向量，不是 `complete` / `streamComplete`），它需要自己的端口，留给 RAG 落地时定。
- 本地识别模型不产出 `multimodal` 描述时，该字段为空；这不阻断入库（入库只看 `sourceText`）。

## 参考

- `research-local-ocr-engine.md`（PaddleOCR-VL 的六个固定 prompt、官方 GGUF）
- ADR-0001 修订（视觉路由双引擎）、ADR-0005（用户配置端点）、ADR-0009（ModelClient 契约）
- `recognizer-interface.md` 的路由规则表与不变量

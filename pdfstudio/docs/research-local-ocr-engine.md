# 本地 OCR / 视觉识别引擎研究 — 能否落在现有 ModelClient 端口后面

- **范围：** PDF Studio 视觉路由（公式区 / 图表区 / 图文混排区）的**本地**引擎选型。数字 PDF 的纯文字区仍由 pdf.js 文本层处理，不在本文范围（见 `recognizer-interface.md` 路由规则表）。
- **方法：** 仅用一手来源——官方 GitHub README / PR、Hugging Face 模型卡与 `huggingface.co/api/models` 元数据、arXiv 论文、npm registry、vLLM / llama.cpp / Ollama 官方文档。第三方博客与基准聚合站只用于**定位**一手 URL，不作为事实来源。
- **检索时间：** 2026-08-13。
- **引用键：** `[L1]…[L34]` 对应 [Sources](#sources)。没有引用的论断是我的分析，不是一手事实。
- **与 `research-ocr-engine.md` 的关系：** 那篇的结论是「云端多模态模型 + 云端无质量胜者」。本篇不推翻它，但**推翻了它隐含的一个前提**——差异集中写在 [§6](#6-与-research-ocr-enginemd-的结论差异)。

---

## 0 — 判据：什么叫「落在现有 ModelClient 端口后面」

`ModelClient` 只有两个方法（`complete` / `streamComplete`），生产 adapter 是 `openai-compatible.ts`，它把 `ModelRequest.images` 挂到最后一条 user 消息上，走 OpenAI 兼容的 `/v1/chat/completions`（ADR-0009、`src/model/openai-compatible.ts`）。ADR-0005 已经明确写过这条路径存在：「用户把 URL 填成自己本机服务就是本地部署」。

所以一个本地引擎要「落在端口后面」，得同时满足**三个**条件，它们的难度是递增的：

| # | 条件 | 判定 |
|---|---|---|
| C1 | 能暴露 OpenAI 兼容 `/v1/chat/completions` | HTTP 协议层 |
| C2 | 该端点接受**图片**（`image_url` / base64 multimodal content） | 多模态层 |
| C3 | 能遵循 Recognizer 现有 prompt——**一次 `complete` 同时给出**区域类型 + LaTeX/OCR 原文 + 描述 + 翻译的 JSON（不变量 3「恰好一次」） | **指令遵循层** |

本文的核心发现是：**C1 和 C2 在 2026 年已经不再是问题，C3 才是**。所有候选的分类见 [§5](#5-结论)。

---

## 1 — DeepSeek-OCR / DeepSeek-OCR-2

### 1.1 形态：是 VLM，不是 pipeline

论文摘要逐字：「DeepSeek-OCR consists of two components: DeepEncoder and **DeepSeek3B-MoE-A570M as the decoder**」`[L1]`。即一个 vision encoder + 一个 3B MoE（激活 570M）语言解码器的端到端 VLM——单模型、单次前向，**不是** detection→recognition 的多模型 pipeline。README 自述是「a model to investigate the role of vision encoders from an LLM-centric viewpoint」`[L2]`。

**DeepSeek-OCR-2**（2026 年初）是第二代，主题是「Visual Causal Flow」，官方 repo `deepseek-ai/DeepSeek-OCR-2` `[L5]`。HF 元数据：参数 **3,389,119,360**（BF16），`lastModified` **2026-02-03**，下载 1,449,685 `[L6]`。

两代的官方 prompt 都只有两个：`<image>\n<|grounding|>Convert the document to markdown` 和 `<image>\nFree OCR.` `[L2][L5]`。v1 的 README 还列出 figure parsing、layout、`Locate <ref>...</ref> in the image` 之类的定位 prompt `[L2]`。

### 1.2 体积与量化选项

| 形态 | 体积 | 来源 |
|---|---|---|
| v1 safetensors（BF16） | 3.34B 参数 | HF API `[L3]` |
| v1 Ollama 官方 library `deepseek-ocr:3b` | **6.7 GB**（F16），8K context，vision tag，需 Ollama ≥ v0.13.0 | Ollama library `[L9]` |
| v2 safetensors（BF16） | 3,389,119,360 参数 | HF API `[L6]` |
| v2 GGUF Q4_K_M（**社区**，非官方） | 1,950,326,688 B ≈ **1.95 GB** + mmproj q8_0 512,537,792 B ≈ **0.51 GB** | HF API `[L14]` |
| v2 GGUF q8_0 / bf16（社区） | 3.13 GB / 5.88 GB（+ mmproj bf16 0.93 GB） | HF API `[L14]` |

注意：**deepseek-ai 官方没有发布 GGUF**——`[L3][L6]` 的 siblings 里只有 safetensors。GGUF 由社区（`sabafallah`）转换 `[L14]`，而 PaddleOCR-VL 的 GGUF 是**官方账号**发的（见 §2.2），这是一处实质差别。

### 1.3 许可证

- DeepSeek-OCR v1：**MIT**（HF 模型卡 license 字段）`[L3][L4]`。
- DeepSeek-OCR-2：**Apache-2.0**（HF 元数据 + repo 内 `LICENSE.txt`）`[L6][L5]`。

两者都允许随应用重分发权重，无附加条款。

### 1.4 能否暴露成 OpenAI 兼容接口 — **三条路全部可行**

**vLLM：** 官方 supported-models 表里同时列着两代：`DeepseekOCRForCausalLM`（`deepseek-ai/DeepSeek-OCR, etc.`，输入 `T + I⁺`）与 `DeepseekOCR2ForCausalLM`（`deepseek-ai/DeepSeek-OCR-2, etc.`）`[L7]`。`vllm serve` 启动的就是一个实现 `/v1/chat/completions` 等 OpenAI 端点的 HTTP server，且 Chat Completions 接受多模态消息格式 `[L8]`。DeepSeek-OCR README 给出的 vLLM 版本要求是 **v0.11.1+**（upstream）`[L4]`。→ **C1 ✅ C2 ✅**

**Ollama：** `deepseek-ocr` 在**官方 library**（不是用户上传），tags `latest` / `3b` / `3b-bf16`，标记为 vision 模型 `[L9]`。Ollama 官方 OpenAI 兼容文档逐字列出 `/v1/chat/completions` 支持的特性：「Chat completions, Streaming, JSON mode, Reproducible outputs, **Vision**, Tools, Reasoning/thinking control」，且 `messages` 支持「text and image content, **including base64 encoded images**」`[L10]`。→ **C1 ✅ C2 ✅**

**llama.cpp：** `mtmd: Add DeepSeekOCR Support`（PR #17400）**已合并进 master**，2025-11-20 开，2026-03-25 合 `[L11]`；`mtmd: Add DeepSeekOCR 2 Support`（PR #20975）**已合并**，2026-05-29 合 `[L12]`。`llama-server` 提供 `/v1/chat/completions`，且官方 server README 写明「Multimodal support ... currently available in the following endpoints: **The OAI-compatible chat endpoint**」，图片可以是 remote URL、`data:image/...;base64`、或本地文件路径 `[L13]`。→ **C1 ✅ C2 ✅**

结论：DeepSeek-OCR 在**协议层**完全可以直接挂在现有 `openai-compatible.ts` 后面，一行业务代码都不用改，用户只需在设置里换 `baseURL` + `model`。

### 1.5 公式 → LaTeX 的一手证据 — **有，但是间接的**

一手证据链是这样的（不是直接声明）：

1. 论文在 OmniDocBench 上报告了 **formula 子项的 edit distance**：Base(256 tokens) 0.267、Large(400) 0.277、Gundam 0.269、Gundam-M 0.242，越小越好 `[L1]`。
2. OmniDocBench 官方 README 写明「**Formulas contain LaTeX annotations**」，公式指标是 Normalized Edit Distance 与 CDM `[L15]`。

所以「DeepSeek-OCR 输出 LaTeX 公式」是从「它在一个以 LaTeX 为 ground truth 的公式子集上被打分」推出来的，逻辑成立，但**官方文档里没有一句「outputs LaTeX」**，也**没有专门的公式 prompt**——只有 `Convert the document to markdown` 和 `Free OCR` `[L2][L4]`。论文里唯一显式的 formula 段落讲的是**化学式**：「For chemical formulas, we utilize SMILES format from PubChem as the data source and render them into images using RDKit, constructing 5M image-text pairs」`[L1]`。

对 PDF Studio 的直接后果：拿一个框选的**公式区裁剪图**喂进去，官方没有一个「只识别这个公式、只回 LaTeX」的 prompt 契约。这跟 PaddleOCR-VL 的 `Formula Recognition:` 是完全不同的工程确定性（见 §2.2）。

**数学公式（非化学式）的独立准确率：无公开数据。** 论文只给 OmniDocBench 的聚合 edit distance，不是我们这种「单公式裁剪」场景的指标。

### 1.6 「可以提炼 context」这个说法 — 对应官方的什么机制

对应的官方机制叫 **Contexts Optical Compression**，就是论文标题 `[L1]`。它的确切含义，逐字引摘要：

> 「We present DeepSeek-OCR as an initial investigation into the feasibility of **compressing long contexts via optical 2D mapping**. ... Experiments show that when the number of text tokens is within 10 times that of vision tokens (i.e., **a compression ratio < 10x**), the model can achieve decoding (OCR) precision of **97%**. Even at a compression ratio of **20x**, the OCR accuracy still remains at about **60%**.」`[L1]`

也就是说：把 N 个文本 token 渲染成图，用 N/10 个 vision token 表示，再解回来仍有 97% 精度。分辨率档位对应的 vision token 数是 512×512 → 64 token，最高 1280×1280 → 400 token `[L2]`。

**这个说法属实，但它不是「提炼/摘要 context」。** 它是**输入侧的 token 计数压缩**（同一段文字用更少 token 表示，无损意图），不是语义压缩、不是摘要、不是抽取要点。论文自己把用途定位在「historical long-context compression and memory forgetting mechanisms in LLMs」`[L1]`——是 LLM 长上下文研究方向，不是文档理解功能。

**对 PDF Studio 的价值：接近于零。** 我们送进模型的是一张几百像素的区域裁剪图，本来就只有几十到几百个 vision token；「压缩比」这个维度上没有任何东西可省。它唯一的间接好处是：同样质量下 DeepSeek-OCR 的 vision token 更少 → 本地推理更快、显存更省（论文对比：「surpasses GOT-OCR2.0 (256 tokens/page) using only 100 vision tokens, and outperforms MinerU2.0 (6000+ tokens per page on average) while utilizing fewer than 800 vision tokens」`[L1]`）。**这是性能论据，不是能力论据。**

---

## 2 — PaddleOCR

### 2.1 形态：一个 repo，两条产品线

PaddleOCR 3.7.0（2026-06-11 发布），**Apache-2.0** `[L16]`。它同时包含：

**(a) 传统 pipeline（Python）**——多个小模型串起来：
- PP-OCRv5 文本检测+识别，三档：tiny 1.5M / small 7.7M / medium 34.5M 参数，100+ 语言 `[L16]`。
- PP-StructureV3 版面分析，把 PDF/图转成 Markdown 或 JSON，带「fine-grained coordinate information, including table cell coordinates, text coordinates」`[L16]`。
- **PP-FormulaNet / PP-FormulaNet_plus**（S/M/L）公式识别模块。官方文档逐字：公式识别 pipeline「extract[s] formula information from images and output[s] it in **LaTeX source code format**」`[L17]`。PP-FormulaNet_plus-L 增加了中文公式支持，最大预测 token 从 1024 提到 2560 `[L17]`。
- 依赖链：`paddleocr` → `paddlex` → `paddlepaddle`，Python 3.9–3.13 `[L18]`。

**(b) PaddleOCR-VL（VLM）**——见下。

### 2.2 PaddleOCR-VL — **本文最契合 PDF Studio 用例的候选**

**形态与体积。** 0.9B 级 VLM：NaViT 风格动态分辨率视觉编码器 + **ERNIE-4.5-0.3B** 语言模型，109 种语言 `[L19]`。最新版 `PaddleOCR-VL-1.6`：HF 元数据 safetensors BF16 ≈ **958.6 MB**，`pipeline_tag: image-text-to-text`，`lastModified` **2026-08-08** `[L20]`。模型卡自述 OmniDocBench v1.6 总分 **96.33** `[L19]`。许可 **Apache-2.0** `[L19][L20]`。

**关键点 1 —— 它天生就是 element-level 的。** 模型卡逐字列出六个 element-level recognition prompt `[L19]`：

| prompt | 用途 |
|---|---|
| `OCR:` | 文字 |
| `Formula Recognition:` | **公式** |
| `Table Recognition:` | 表格 |
| `Chart Recognition:` | 图表 |
| `Seal Recognition:` | 印章 |
| `Spotting:` | 带坐标的文字 |

模型卡说明用 `transformers` 调用时「formulas 以 **LaTeX** 格式输出」`[L19]`。

这正好是 PDF Studio 的形状：Recognizer 已经把区域裁出来了、已经用覆盖检测判过路由了，需要的就是「给一张公式裁剪图，还我 LaTeX」。**不需要它做整页版面分析**，那部分我们自己已经有。

**关键点 2 —— 官方发 GGUF，官方文档就写 `llama-server`。** `PaddlePaddle/PaddleOCR-VL-1.6-GGUF` 是 PaddlePaddle 官方账号的 repo，Apache-2.0，`lastModified` 2026-06-10，下载 682,895 `[L21]`：

| 文件 | 字节 | ≈ |
|---|---|---|
| `PaddleOCR-VL-1.6-GGUF.gguf` | 935,769,056 | 0.94 GB |
| `PaddleOCR-VL-1.6-GGUF-mmproj.gguf` | 881,770,560 | 0.88 GB |
| **合计** | | **≈ 1.82 GB** |

官方 README 给的启动命令逐字 `[L22]`：

```bash
llama-server \
    -m /path/to/PaddleOCR-VL-1.6-GGUF.gguf \
    --mmproj /path/to/PaddleOCR-VL-1.6-GGUF-mmproj.gguf \
    --port 8080 --host 0.0.0.0 --temp 0
```

并给出以 `http://127.0.0.1:8080/v1` 为 `vl_rec_server_url`、`vl_rec_backend="llama-cpp-server"` 的客户端示例 `[L22]`——即官方自己就把它当 **OpenAI 兼容 `/v1` 端点**在用。

**llama.cpp 上游支持已合并：** `model: Add PaddleOCR-VL model support`（PR #18825），2026-01-14 开、**2026-02-19 合入 master** `[L23]`。

**vLLM 也支持：** supported-models 表列 `PaddleOCRVLForConditionalGeneration`，example model `PaddlePaddle/PaddleOCR-VL, etc.`，输入 `T + I⁺` `[L7]`。

**Ollama：** 只有社区上传（`MedAIBase/PaddleOCR-VL:0.9b`，936 MB），**不在官方 library** `[L24]`。

→ **C1 ✅ C2 ✅**，且是全部候选里 C1/C2 证据最硬的一个（官方权重 + 官方 GGUF + 官方 `llama-server` 文档 + 上游合并）。C3 见 §5.1 的警告。

### 2.3 Node / TypeScript 形态 — 有两个，但**都不是**「本地跑公式识别」

这是最容易踩坑的一点，两个官方 JS 产物都不满足我们的需求：

1. **`@paddleocr/paddleocr-js`**——官方**浏览器**推理 SDK，基于 ONNX Runtime Web + OpenCV.js，跑的是 **PP-OCR pipeline（PP-OCRv5 文字检测+识别）**`[L25]`。它是真本地推理，但**只有文字 OCR，没有公式识别**——而文字区在 PDF Studio 里根本不走模型（走 pdf.js 文本层）。所以它解决的正好是我们唯一不需要解决的问题。
2. **官方 TypeScript SDK**（`inference_deployment/serving/paddleocr_official_api/typescript`）——文档逐字：「calls the PaddleOCR **official API** for OCR and document parsing. It uses **hosted PaddleOCR services** and **does not run local PaddleOCR inference**」，目标 Node.js 18+ `[L26]`。它是**云端 API 客户端**，功能覆盖 PP-StructureV3 的公式识别，但那是百度的托管服务——与 local-first 直接冲突。

**结论：PaddleOCR 传统 pipeline（含 PP-FormulaNet）没有本地 Node/TS 形态。** 要用它就得跑 Python。

### 2.4 只有 Python 的话，打包进跨平台应用的现实代价

PaddleOCR 3.x 依赖 PaddlePaddle 3.0+，Python 3.9–3.13 `[L18]`。要把它塞进 ADR-0006 那个 Mac/Windows/手机通用的包，代价是：

1. **要嵌一个 Python runtime**（PyInstaller / embeddable Python / uv 打包），Mac + Windows 各一套，安装包从几十 MB 级跳到几百 MB 级。paddlepaddle wheel 本身还有平台限制（官方 macOS 文档写明某些 Python 版本只支持 intel 版 Python，不支持 universal 版）`[L27]`。
2. **多进程架构**：Node/Electron 主进程 ↔ Python sidecar，得自己做进程生命周期、健康检查、端口分配、崩溃重启——这套东西无论如何都要写（见 §5.1），但走 llama.cpp 时被 `llama-server` 一个二进制吸收掉了，走 Python 时要吸收整条依赖树。
3. **手机端没有路。** PaddlePaddle 官方 pip 安装文档只覆盖 Linux/macOS/Windows `[L27]`，移动端没有对应形态。这一条直接和 ADR-0006 的「Mac/Windows/手机通用」冲突。
4. **不落在 ModelClient 端口后面**：得新开一个端口（或自建一层本地 HTTP 服务把它包成 OpenAI 兼容——那等于自己实现 §5.1 的东西，但底下换成更重的运行时）。

对比：PaddleOCR-VL GGUF 路线上，同一家的公式能力以 1.82 GB 权重 + 一个 `llama-server` 二进制的形式拿到，且协议层免费兼容。**在 PDF Studio 的约束下，PaddleOCR 的 VLM 线全面优于它的 Python pipeline 线。**

---

## 3 — 其他本地候选

### 3.1 olmOCR 2（Ai2）

- `allenai/olmOCR-2-7B-1025`：**Apache-2.0**，**~8B 参数**（BF16），是 `Qwen2.5-VL-7B-Instruct` 在 `olmOCR-mix-1025` 上的 fine-tune，并「additionally fine tuned using **GRPO RL training** to boost its performance at **math equations**, tables, and other tricky OCR cases」`[L28]`。
- olmOCR-Bench 总分 **82.3 ± 1.1**，其中 **Math equations 82.1**、ArXiv 82.9、Tables 84.3；FP8 量化版 82.4 ± 1.1 `[L28]`。**这是本文所有候选里唯一一个把「数学公式」单独列成一档并给出数字的一手来源。**
- 部署：官方 toolkit 走 vLLM，也支持「vLLM with OpenAI-compatible API」、SGLang、Docker、transformers `[L28]`。→ C1 ✅ C2 ✅
- **硬伤：** 官方 README 的硬件要求逐字是「Recent NVIDIA GPU (tested on RTX 4090, L40S, A100, H100) with **at least 12 GB of GPU RAM**」+ 30 GB 磁盘 `[L29]`。README 未提供 CPU / Apple Silicon 路径。也未查到官方 GGUF。→ **与「Mac/Windows/手机消费级机器」不兼容**。
- 用途限制：模型卡写「Intended for **research and educational use** in accordance with Ai2's Responsible Use Guidelines」`[L28]`——与 Apache-2.0 并存的一句意图声明，商用前需自行判断。
- 最近更新日期：**未从一手来源取到**。

### 3.2 MinerU

- `opendatalab/MinerU` v3.4（2026-06-18）`[L30]`。
- 能力：「automatically recognize and convert **formulas** in the document **to LaTeX format**」、表格转 HTML `[L30]`——公式→LaTeX 是**显式一手声明**，比 DeepSeek-OCR 的间接证据强。
- 后端：pipeline（**纯 CPU 可跑**，自报 86.47）、vlm（需 8 GB 显存，95.30）、hybrid（95.39/95.26）`[L30]`。最低 16 GB 内存、20 GB 磁盘、Python 3.10–3.13 `[L30]`。
- 部署：Python 包、FastAPI HTTP API、Docker；VLM 后端可经 vLLM/LMDeploy/SGLang 暴露 OpenAI 兼容端点 `[L30]`。
- **许可是硬约束：** 不是 Apache-2.0，而是「MinerU Open Source License」——基于 Apache 2.0 加附加条款 `[L31]`：MAU > 1 亿或月收入 > 2000 万美元须另购商业授权；「if you provide online services to third parties based on MinerU, you must **clearly and prominently indicate** ... that MinerU is used」；违反则**自动终止授权** `[L31]`。对 PDF Studio 当前规模不构成阻断，但是一个要记进 ADR 的附着条款。
- 形态是 Python（同 §2.4 的全部代价），且它做的是**整页文档解析**，与我们「用户框选一个区域」的交互不同构——会有大量能力浪费在我们已经用 pdf.js 解决的部分。

### 3.3 GOT-OCR2.0

- `stepfun-ai/GOT-OCR-2.0-hf`：**Apache-2.0**，**560,528,640 参数**（BF16，≈1.1 GB），`lastModified` **2025-01-31**，下载 126,531 `[L32]`。
- 能力覆盖「plain document OCR, scene text OCR, formatted document OCR, and even OCR for tables, charts, **mathematical formulas**, geometric shapes, molecular formulas and sheet music」`[L32]`。
- **不在 vLLM 的 supported models 表里** `[L7]`；在 HF transformers 内有原生支持（`got_ocr2` 架构 tag）`[L32]`。
- 维护：HF 仓库最近修改是 **2025-01-31**`[L32]`，是本文候选里最旧的。DeepSeek-OCR 的 README 把它列为致谢对象，论文里把它当基线并宣称超过它 `[L1][L2]`——它已经是「被超越的上一代」。
- 体积最小（1.1 GB），若将来要做「最低配置档」，它是唯一 1 GB 级且明确声明数学公式能力的候选。

### 3.4 dots.ocr（rednote-hilab）

- `rednote-hilab/dots.ocr`：**MIT**，**3,039,179,264 参数**（BF16），tags 含 `formula`、`table`、`layout`，`lastModified` **2025-10-31**，下载 313,632 `[L33]`。
- vLLM 官方 supported-models 表里有 `DotsOCRForCausalLM`（`rednote-hilab/dots.ocr`）`[L7]`。→ C1 ✅ C2 ✅
- 有更新的 `dots.ocr-1.5`（1.2B vision + 1.7B LM），但该 repo 的 HF API 返回 **401（gated）**，**其许可与元数据无法从一手来源确认**。
- 公式能力的一手数字：**无公开数据**——`dots.ocr-1.5` 自述省略了 OmniDocBench 1.5 的 formula/table 指标（理由是对检测与匹配协议过于敏感），这条来自 gated 模型卡的转述，我未能直接核验，故不作为结论依据。

### 3.5 Nougat（Meta）— **直接出局**

- `facebookresearch/nougat`：学术 PDF 解析器，明确懂 LaTeX 数学与表格，有 `0.1.0-small` / `0.1.0-base` 两档 `[L34]`。
- 许可逐字：「Nougat codebase is licensed under **MIT**. Nougat model **weights are licensed under CC-BY-NC**」`[L34]`。
- **CC-BY-NC = 禁止商业用途**，与「打包进要分发的应用」直接冲突。无论技术上多合适，这一条就足以排除。这是本文唯一一个因许可出局的候选。

---

## 4 — 一键下载

### 4.1 分发方式

上述所有权重的一手分发渠道都是 **Hugging Face Hub**（`deepseek-ai/*`、`PaddlePaddle/*`、`allenai/*`、`stepfun-ai/*`、`rednote-hilab/*`）`[L3][L6][L20][L21][L28][L32][L33]`。Ollama library 是第二渠道，但只对 `deepseek-ocr`（v1）成立 `[L9]`；PaddleOCR-VL 在 Ollama 上只有社区上传 `[L24]`。

### 4.2 体积量级（一次性下载）

| 目标 | 下载量 |
|---|---|
| PaddleOCR-VL-1.6 GGUF（官方，model + mmproj） | **≈ 1.82 GB** `[L21]` |
| DeepSeek-OCR-2 GGUF Q4_K_M + mmproj q8_0（社区） | **≈ 2.46 GB** `[L14]` |
| DeepSeek-OCR v1 via Ollama | **6.7 GB** `[L9]` |
| GOT-OCR2.0 safetensors BF16 | ≈ 1.1 GB `[L32]` |
| olmOCR-2-7B BF16 | 8B 参数（文件体积未从一手来源确认） |

### 4.3 可直接用的 TypeScript 下载/缓存库 — **有**

`@huggingface/hub` **2.15.0，MIT，Node ≥ 18**`[L35]`。官方 README 给出两个正好对口的 API `[L36]`：

```ts
import { downloadFileToCacheDir, snapshotDownload } from "@huggingface/hub";
const file = await downloadFileToCacheDir({ repo: 'foo/bar', path: 'README.md' });
const directory = await snapshotDownload({ repo: 'foo/bar' });
```

`snapshotDownload` 内部复用 `downloadFileToCacheDir`，**自带缓存目录语义** `[L36]`——即「一键下载 + 断点后不重下」这一半是现成的。进度条属于可选依赖 `cli-progress` `[L35]`；要在 UI 上做进度，得自己按文件粒度包一层。

配套的运行时（用于真正跑模型）：

| 包 | 版本 | 许可 | 平台 |
|---|---|---|---|
| `node-llama-cpp` | 3.20.0 | MIT | 预编译二进制覆盖 **macOS x64/arm64 (Metal)、Windows x64/arm64（含 CUDA/Vulkan）、Linux x64/arm64/armv7l/riscv64**；Node ≥ 20 `[L37]` |
| `llama.rn` | 0.13.0-rc.0 | MIT | React Native（iOS/Android）绑定，postinstall 拉预编译原生库 `[L38]` |
| `@huggingface/transformers`（transformers.js） | 4.2.0 | Apache-2.0 | ONNX Runtime web/node `[L39]` |

**注意 `node-llama-cpp` 不覆盖手机**：官方 issue #287「feat: React Native support」表明 RN 场景需改用 `llama.rn` `[L38]`。这意味着桌面与手机是**两套原生绑定**，但**同一份 GGUF 权重、同一个 llama.cpp 内核**。

transformers.js 路线：本文候选中**未找到**官方发布的 ONNX 权重（`[L20][L21]` 的 siblings 里只有 safetensors 与 GGUF），故 transformers.js 路线**无一手可用权重**。

### 4.4 许可是否允许应用内分发

| 模型 | 许可 | 可随应用分发/应用内下载 |
|---|---|---|
| DeepSeek-OCR v1 | MIT `[L3]` | ✅ |
| DeepSeek-OCR-2 | Apache-2.0 `[L6]` | ✅ |
| PaddleOCR-VL-1.6 / GGUF | Apache-2.0 `[L20][L21]` | ✅ |
| GOT-OCR2.0 | Apache-2.0 `[L32]` | ✅ |
| dots.ocr | MIT `[L33]` | ✅ |
| olmOCR-2-7B | Apache-2.0 + 「research and educational use」意图声明 `[L28]` | ⚠️ 需自行判断 |
| MinerU | Apache-2.0 + 附加条款（规模阈值 + 署名义务）`[L31]` | ⚠️ 有义务 |
| Nougat weights | **CC-BY-NC** `[L34]` | ❌ |

---

## 5 — 结论

### 5.1 A 类：**协议层能落在现有 ModelClient 端口后面**（C1 + C2 满足）

**PaddleOCR-VL-1.6、DeepSeek-OCR、DeepSeek-OCR-2、dots.ocr**——四者都能经 vLLM / Ollama / llama-server 暴露成带 vision 的 OpenAI 兼容 `/v1/chat/completions` `[L7][L9][L10][L11][L12][L13][L22][L23]`。`openai-compatible.ts` 一行不改，用户在设置里换 `baseURL` + `model` 即可。ADR-0005 早就写下了这条路径。

**但要付两笔架构代价，都不在 `ModelClient` 里：**

**代价 1 —— 需要一个与 `ModelClient` 正交的新端口：`LocalEngine` supervisor。**
用户要的不是「自己装 Ollama 再填 URL」，而是「设置里一键下载模型、一键切本地」。这要求应用自己负责：权重下载与校验（`@huggingface/hub` `[L36]`）、`llama-server` 进程的拉起/健康检查/停止、端口分配、崩溃恢复、磁盘配额。这些**都不是模型调用**，塞进 `ModelClient` 会污染一个刻意保持极薄的 SDK-agnostic 端口（ADR-0009 边界条款）。正确形状是**新开一个端口**：

```
LocalEngine: ensureReady() → { baseURL } | download(progress) | stop()
```

它的产物只是一个 `baseURL`，喂给已有的 `createModelClient({ baseURL, apiKey: '-', model })`。**两个端口正交，`ModelClient` 契约零改动。** 这是本文推荐路线的核心结构。

**代价 2 —— C3（指令遵循）不成立，这是最贵的一笔。**
Recognizer 的不变量 3 要求：`route === 'vision'` ⟹ **恰好一次** `complete`，一次拿到区域类型 + LaTeX/OCR 原文 + 描述 + **中文翻译** 的 JSON。而：

- PaddleOCR-VL 只吃六个固定 element-level prompt（`OCR:` / `Formula Recognition:` / …）`[L19]`，它是**专用识别模型，不是 instruct 模型**——不会遵循「按这个 JSON schema 回答」，也**不做 en↔zh 翻译**（模型卡的能力列表里没有翻译 `[L19]`）。
- DeepSeek-OCR 两代的官方 prompt 也只有 `Convert the document to markdown` / `Free OCR` `[L2][L5]`，同样不承诺 JSON schema 与翻译。

所以本地路线**不可能**是「同一套 prompt 换个 baseURL」。现实的落法是二选一：

- **(a) 本地只做 sourceText，翻译与描述仍走云端** ——`vision` 路由变成「本地一次 + 云端一次」，破坏「零成本/恰好一次」的语义，且本地档位不再是纯离线。
- **(b) 本地档位降级路由表** ——公式区本地出 LaTeX（`sourceText`），图/表区本地出 OCR 文字，`translation` / `multimodal` 在本地档位下**不产出**（`undefined`）。Recognizer 的出口裁剪逻辑已经在做「模型多回了也不透出去」，这里是反过来「少回了也合法」。

**(b) 更干净**，代价是本地档与云端档的 `ClipContent` 丰富度不对等——这是产品决策，不是技术决策，必须由决策者拍板，且应当写进 ADR。

### 5.2 B 类：**需要新开一个识别端口**（C1 不满足或需自建服务）

**PaddleOCR 传统 pipeline（PP-StructureV3 + PP-FormulaNet）、MinerU、olmOCR、Nougat。**

- PaddleOCR pipeline / MinerU：Python-only，要嵌 Python runtime、多进程 sidecar、安装包膨胀到几百 MB 级，**手机端无路** `[L18][L27][L30]`。要么新开 `LocalRecognizer` 端口，要么自己写一层 OpenAI 兼容 shim（等于自建 §5.1 的东西但运行时更重）。MinerU 另有许可附加条款 `[L31]`。
- olmOCR：协议上其实是 A 类（vLLM OpenAI 兼容 `[L28]`），但硬件要求「NVIDIA GPU ≥ 12 GB VRAM」`[L29]` 把它踢出「消费级 Mac/Windows/手机」，实际不可选。
- Nougat：CC-BY-NC 权重，**不可分发** `[L34]`。

### 5.3 推荐路线

**主推：PaddleOCR-VL-1.6-GGUF + llama.cpp（`llama-server`），经 `baseURL` 切换落在现有 `ModelClient` 后面；新增一个与之正交的 `LocalEngine` supervisor 端口负责下载与进程。**

依据（全部一手）：

1. **唯一一个官方 prompt 契约就等于我们用例的候选**：`Formula Recognition:` 输入一张公式裁剪图、输出 LaTeX `[L19]`，与 Recognizer「区域已裁好、路由已判好」的形状同构。其余候选都是整页文档解析器，得靠 prompt 工程把它掰成区域识别。
2. **官方权重 + 官方 GGUF + 官方 `llama-server` 文档 + 上游已合并**，四条证据齐全 `[L19][L21][L22][L23]`；PaddleOCR-VL 是本文唯一由**模型作者本人**发布 GGUF 并演示 OpenAI 兼容 `/v1` 调用的候选。
3. **体积最优**：1.82 GB 一次性下载 `[L21]`，是 DeepSeek-OCR v1 via Ollama（6.7 GB `[L9]`）的 27%。
4. **Apache-2.0，无附加条款** `[L20][L21]`，可随应用分发。
5. **一份权重打通桌面与手机**：`node-llama-cpp`（MIT，macOS/Windows 预编译含 Metal）`[L37]` 与 `llama.rn`（MIT，RN iOS/Android）`[L38]` 共用同一份 GGUF 与同一个 llama.cpp 内核——这是 ADR-0006「Mac/Windows/手机通用」在本文里唯一走得通的技术路径。
6. **仍在活跃维护**：模型 2026-08-08、GGUF 2026-06-10 `[L20][L21]`。

**备选：DeepSeek-OCR-2 GGUF，同一套 `LocalEngine` 基础设施，只换权重。**

`LocalEngine` 端口设计成「模型仓库 + 文件名 + prompt 模板」可配置，主推与备选就只是配置差异。备选的取舍：

- ✅ Apache-2.0 `[L6]`；vLLM 与 llama.cpp master 均已支持 `[L7][L12]`；vision token 效率明显更高（100 vision token 超过 GOT-OCR2.0 的 256）`[L1]`。
- ❌ 体积约 2.46 GB（Q4_K_M + mmproj）`[L14]`，比主推大 35%。
- ❌ **GGUF 是社区转换的，不是官方发布** `[L6][L14]`——供应链与长期可用性弱于主推。
- ❌ 无 `Formula Recognition:` 这类专用 prompt，公式 LaTeX 只有间接证据（经 OmniDocBench 的 LaTeX ground truth 推得 `[L1][L15]`）。

**兜底档（可选）：GOT-OCR2.0**，1.1 GB `[L32]`，用于最低配置；但 2025-01-31 之后无更新 `[L32]`，且不在 vLLM 支持表 `[L7]`，只建议作为将来「极低配」再评估的对象，不进第一版。

### 5.4 一句话的架构代价总结

| 路线 | 新端口 | 打包体积增量 | 原生依赖 | 手机 |
|---|---|---|---|---|
| **主推** PaddleOCR-VL + llama.cpp | `LocalEngine`（正交，`ModelClient` 零改动） | 二进制随 `node-llama-cpp`/`llama.rn` 预编译；权重 1.82 GB **运行时下载**，不进安装包 | 有（llama.cpp 原生模块，Electron 需 unpack/rebuild） | ✅ 换 `llama.rn`，权重通用 |
| **备选** DeepSeek-OCR-2 + llama.cpp | 同上 | 权重 2.46 GB | 同上 | ✅ 同上 |
| Ollama 外挂 | 无（用户自装） | 0 | 无 | ❌ Ollama 无手机形态 |
| PaddleOCR Python pipeline | `LocalRecognizer`（新识别端口） | Python runtime + paddlepaddle，几百 MB 级 | 重（整条 Python 依赖树） | ❌ 无移动形态 `[L27]` |
| MinerU | 同上 | 同上 | 同上 + 许可附加条款 `[L31]` | ❌ |

---

## 6 — 与 `research-ocr-engine.md` 的结论差异

`research-ocr-engine.md` 问题 2 的结论是：**走云端多模态模型**，按成本+运营挑一个默认（Gemini Flash），再跑内部 eval 定档。ADR-0001 的措辞更强，直接写了「也否决了**全本地 OCR**，因为它处理公式和图文混排很差」。

本篇的差异有四点，按重要性排列：

1. **「全本地 OCR 处理公式很差」这个前提，在 2026 年的一手证据面前不再成立。** ADR-0001 写作时，本地选项还是像素级 OCR pipeline（Tesseract 那一类）。现在的本地候选是 0.9B–3B 的**文档 VLM**：PaddleOCR-VL-1.6 自报 OmniDocBench v1.6 总分 96.33 且带专用 `Formula Recognition:` → LaTeX 的 prompt `[L19]`；olmOCR 2 在 olmOCR-Bench 的 **Math equations 一档拿 82.1** `[L28]`；MinerU 显式声明公式转 LaTeX `[L30]`。**这不等于「本地已经追平云端」**——`research-ocr-engine.md` §2.1 那个判断依然有效：一手来源里没有能横跨本地/云端排序公式 OCR 质量的数字，仍然只能靠内部 eval。但「本地做不了公式」这个断言，已经**被一手证据证伪**，ADR-0001 的这句措辞需要修订。
2. **前篇隐含「本地 = 另一套架构」，本篇证明不是。** 前篇把云端 OpenAI 兼容端点当作唯一形态；本篇确认 vLLM、Ollama、llama.cpp 三条本地路径**全都**暴露带 vision 的 OpenAI 兼容 `/v1/chat/completions` `[L7][L10][L13]`，其中 llama.cpp 对 DeepSeek-OCR、DeepSeek-OCR-2、PaddleOCR-VL 的支持分别于 2026-03-25、2026-05-29、2026-02-19 合入 master `[L11][L12][L23]`。所以「本地 vs 云端」在 `ModelClient` 这一层**根本不是一个分叉**——ADR-0005 押的 OpenAI 兼容协议这一注，赢得比它当初预期的更彻底。
3. **前篇的成本轴，在本篇失效并被两个新轴取代。** 前篇用了整整一节做每 1M token 的比价；本地推理的边际成本是 0，成本不再是选型维度。取代它的是：**(a) 一次性下载体积**（1.82 GB vs 2.46 GB vs 6.7 GB `[L21][L14][L9]`）与 **(b) 权重许可**（本篇唯一一个被许可直接否掉的候选是 Nougat 的 CC-BY-NC 权重 `[L34]`——前篇里许可根本不是模型层的考量，因为云端模型不需要分发权重）。
4. **前篇没有的新风险：指令遵循，而非识别质量。** 前篇担心的是模型看不看得清小字、认不认得公式。本篇的瓶颈完全在别处：本地专用 OCR 模型**看得清但不听话**——它们不承诺 JSON schema、不做翻译（§5.1 代价 2）。前篇「一次 `complete` 读图+翻译+LaTeX」的假设是云端通用 VLM 特有的红利，本地档位拿不到。这直接影响 `ClipContent` 在本地档与云端档下的形状是否要不对等。

**净结论：** 前篇的云端选型**不需要推翻**——它仍然是默认档、也仍然是唯一能一次调用交付完整 `ClipContent` 的档。本篇是在它旁边加一条**可切换的本地档**（用户明确要求的双接口），而且这条本地档**不需要新的模型端口**，只需要一个正交的 `LocalEngine` supervisor。真正要重写的一手结论只有一条：**ADR-0001 里「全本地 OCR 处理公式很差」这句话过时了。**

---

## 候选总表

| 候选 | 模型/包名 | 体积 | 许可 | OpenAI 兼容 | 最近维护 |
|---|---|---|---|---|---|
| **PaddleOCR-VL-1.6** ★推荐 | `PaddlePaddle/PaddleOCR-VL-1.6` / `-GGUF` | 0.96 GB safetensors；GGUF 0.94 + 0.88 = **1.82 GB** | Apache-2.0 | ✅ 官方 `llama-server` 文档直接演示 `/v1`；vLLM `PaddleOCRVLForConditionalGeneration` | 2026-08-08（模型）/ 2026-06-10（GGUF） |
| **DeepSeek-OCR-2** ★备选 | `deepseek-ai/DeepSeek-OCR-2` | 3.39B 参数；社区 GGUF Q4_K_M 1.95 + mmproj 0.51 = **2.46 GB** | Apache-2.0 | ✅ vLLM `DeepseekOCR2ForCausalLM`；llama.cpp PR #20975 已合并 | 2026-02-03 |
| DeepSeek-OCR v1 | `deepseek-ai/DeepSeek-OCR` / `ollama:deepseek-ocr` | 3.34B 参数；Ollama **6.7 GB** | MIT | ✅ vLLM + **Ollama 官方 library** + llama.cpp PR #17400 已合并 | 2025-11-04 |
| dots.ocr | `rednote-hilab/dots.ocr` | 3.04B 参数 | MIT | ✅ vLLM `DotsOCRForCausalLM` | 2025-10-31（`-1.5` 为 gated，元数据无法核验） |
| GOT-OCR2.0 | `stepfun-ai/GOT-OCR-2.0-hf` | 560M 参数 ≈ **1.1 GB** | Apache-2.0 | ❌ 不在 vLLM 表；transformers 原生 | 2025-01-31 |
| olmOCR 2 | `allenai/olmOCR-2-7B-1025` | 8B 参数 | Apache-2.0 + 研究/教育用途声明 | ✅ vLLM | 未从一手来源取到 |
| MinerU | `opendatalab/MinerU` v3.4 | pipeline 后端纯 CPU 可跑 | MinerU OSL（Apache-2.0 + 附加条款） | ✅ 经 vLLM/SGLang/LMDeploy | 2026-06-18 |
| PaddleOCR pipeline | `paddleocr` (PP-StructureV3 + PP-FormulaNet_plus) | PP-OCRv5 1.5M/7.7M/34.5M 参数 | Apache-2.0 | ❌ 需自建 shim | 3.7.0 / 2026-06-11 |
| Nougat | `facebookresearch/nougat` | small / base | 代码 MIT，**权重 CC-BY-NC** | ❌ | — |
| `@huggingface/hub` | npm | — | MIT | — | 2.15.0 |
| `node-llama-cpp` | npm | — | MIT | — | 3.20.0 |
| `llama.rn` | npm | — | MIT | — | 0.13.0-rc.0 |

---

## Sources

- `[L1]` DeepSeek-OCR 论文《DeepSeek-OCR: Contexts Optical Compression》（摘要、压缩比 97%/60%、OmniDocBench formula edit distance、SMILES 化学式训练数据、vs GOT-OCR2.0/MinerU2.0 的 vision token 对比）: https://arxiv.org/abs/2510.18234 · https://arxiv.org/html/2510.18234v1
- `[L2]` DeepSeek-OCR GitHub README（架构自述、分辨率档位与 vision token 数、prompt 列表、致谢 Vary/GOT-OCR2.0/MinerU/PaddleOCR）: https://raw.githubusercontent.com/deepseek-ai/DeepSeek-OCR/main/README.md
- `[L3]` HF API `deepseek-ai/DeepSeek-OCR`（license MIT、3.34B BF16、siblings 无 GGUF、lastModified 2025-11-04）: https://huggingface.co/api/models/deepseek-ai/DeepSeek-OCR
- `[L4]` DeepSeek-OCR HF 模型卡（license mit、Tiny/Small/Base/Large/Gundam 配置、vLLM v0.11.1+、transformers `infer()`）: https://huggingface.co/deepseek-ai/DeepSeek-OCR/raw/main/README.md
- `[L5]` DeepSeek-OCR-2 GitHub（Visual Causal Flow、vLLM/transformers 用法、prompt 列表、Apache-2.0）: https://github.com/deepseek-ai/DeepSeek-OCR-2
- `[L6]` HF API `deepseek-ai/DeepSeek-OCR-2`（Apache-2.0、3,389,119,360 参数 BF16、lastModified 2026-02-03、siblings 无 GGUF）: https://huggingface.co/api/models/deepseek-ai/DeepSeek-OCR-2
- `[L7]` vLLM supported models（`DeepseekOCRForCausalLM`、`DeepseekOCR2ForCausalLM`、`PaddleOCRVLForConditionalGeneration`、`DotsOCRForCausalLM`；GOT-OCR/olmOCR/Nougat 不在表内）: https://raw.githubusercontent.com/vllm-project/vllm/main/docs/models/supported_models.md · https://docs.vllm.ai/en/latest/models/supported_models.html
- `[L8]` vLLM online serving 文档（`vllm serve` 启动「an HTTP server that is compatible with many interfaces」；实现 `/v1/completions`、`/v1/chat/completions`、`/v1/embeddings` 等；Chat Completions 接受 multi-modal 消息格式）: https://docs.vllm.ai/en/latest/serving/online_serving/
- `[L9]` Ollama 官方 library `deepseek-ocr`（tags latest/3b/3b-bf16、3.34B F16 6.7 GB、8K context、vision、需 Ollama ≥ v0.13.0）: https://ollama.com/library/deepseek-ocr · https://ollama.com/library/deepseek-ocr/tags
- `[L10]` Ollama OpenAI 兼容文档（`/v1/chat/completions` 支持 Vision、messages 支持 base64 图片；不支持 logprobs/tool_choice/n）: https://docs.ollama.com/api/openai-compatibility
- `[L11]` llama.cpp PR #17400「mtmd: Add DeepSeekOCR Support」——**已合并 master**，2025-11-20 开 / 2026-03-25 合: https://github.com/ggml-org/llama.cpp/pull/17400
- `[L12]` llama.cpp PR #20975「mtmd: Add DeepSeekOCR 2 Support」——**已合并**，2026-03-25 开 / 2026-05-29 合: https://github.com/ggml-org/llama.cpp/pull/20975
- `[L13]` llama.cpp server README（`/v1/chat/completions` 等 OAI 端点；「Multimodal support ... The OAI-compatible chat endpoint」；`image_url.url` 支持 remote URL / `data:image/...;base64` / 本地文件）: https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md
- `[L14]` HF API `sabafallah/DeepSeek-OCR-2-GGUF`（**社区**转换；Q4_K_M 1,950,326,688 B、q8_0 3,126,139,808 B、bf16 5,876,578,208 B、mmproj q8_0 512,537,792 B / bf16 929,037,632 B；lastModified 2026-05-29）: https://huggingface.co/api/models/sabafallah/DeepSeek-OCR-2-GGUF?blobs=true
- `[L15]` OmniDocBench README（「Formulas contain LaTeX annotations」；Normalized Edit Distance / CDM / TEDS 指标；Overall 公式含 Formula CDM）: https://raw.githubusercontent.com/opendatalab/OmniDocBench/main/README.md
- `[L16]` PaddleOCR GitHub README（Apache-2.0、3.7.0 / 2026-06-11、PP-OCRv5 tiny 1.5M / small 7.7M / medium 34.5M、PP-StructureV3、PP-FormulaNet、C++/serving 部署、PaddleOCR.js）: https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/README.md
- `[L17]` PaddleOCR 公式识别文档（「outputting it in **LaTeX source code format**」；PP-FormulaNet_plus S/M/L；L 版支持中文公式、max token 1024→2560）: https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/formula_recognition.html · https://paddlepaddle.github.io/PaddleX/3.1/en/module_usage/tutorials/ocr_modules/formula_recognition.html
- `[L18]` PaddleOCR 安装文档（`paddleocr` → `paddlex` → PaddlePaddle 3.0+；extras；Python 版本要求）: https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/installation.en.md
- `[L19]` PaddleOCR-VL-1.6 HF 模型卡（Apache-2.0；ERNIE-4.5-0.3B + NaViT；109 语言；OmniDocBench v1.6 96.33；六个 element-level prompt `OCR:` / `Formula Recognition:` / `Table Recognition:` / `Chart Recognition:` / `Seal Recognition:` / `Spotting:`；transformers 下公式以 LaTeX 输出）: https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6 · https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6/raw/main/README.md
- `[L20]` HF API `PaddlePaddle/PaddleOCR-VL-1.6`（apache-2.0、safetensors BF16 ≈ 958.6 MB、`image-text-to-text`、tags 含 formula/chart/table、lastModified 2026-08-08）: https://huggingface.co/api/models/PaddlePaddle/PaddleOCR-VL-1.6
- `[L21]` HF API `PaddlePaddle/PaddleOCR-VL-1.6-GGUF`（apache-2.0；`PaddleOCR-VL-1.6-GGUF.gguf` 935,769,056 B、`-mmproj.gguf` 881,770,560 B；lastModified 2026-06-10；downloads 682,895）: https://huggingface.co/api/models/PaddlePaddle/PaddleOCR-VL-1.6-GGUF?blobs=true
- `[L22]` PaddleOCR-VL-1.6-GGUF 模型卡（`llama-server -m ... --mmproj ... --port 8080 --temp 0`；`vl_rec_backend="llama-cpp-server"`, `vl_rec_server_url="http://127.0.0.1:8080/v1"`；六个 element prompt）: https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/raw/main/README.md
- `[L23]` llama.cpp PR #18825「model: Add PaddleOCR-VL model support」——**已合并 master**，2026-01-14 开 / 2026-02-19 合: https://github.com/ggml-org/llama.cpp/pull/18825
- `[L24]` Ollama 上的 PaddleOCR-VL 为**社区上传**（`MedAIBase/PaddleOCR-VL:0.9b`，936 MB），非官方 library: https://ollama.com/MedAIBase/PaddleOCR-VL
- `[L25]` `@paddleocr/paddleocr-js`——官方**浏览器**推理 SDK，ONNX Runtime Web + OpenCV.js，跑 PP-OCRv5（仅文字检测+识别）: https://www.npmjs.com/package/@paddleocr/paddleocr-js
- `[L26]` PaddleOCR 官方 TypeScript SDK 文档（「uses hosted PaddleOCR services and **does not run local PaddleOCR inference**」；Node.js 18+）: http://www.paddleocr.ai/main/en/version3.x/inference_deployment/serving/paddleocr_official_api/typescript.html
- `[L27]` PaddlePaddle pip 安装文档（Linux/macOS/Windows；Python 3.9–3.13；macOS 上 Python 版本/架构限制；无移动端形态）: https://www.paddlepaddle.org.cn/documentation/docs/en/install/index_en.html
- `[L28]` `allenai/olmOCR-2-7B-1025` HF 模型卡（Apache-2.0；Qwen2.5-VL-7B-Instruct 微调 + GRPO RL「to boost its performance at math equations, tables」；olmOCR-Bench 82.3±1.1，Math equations 82.1；vLLM OpenAI-compatible API；「research and educational use」）: https://huggingface.co/allenai/olmOCR-2-7B-1025
- `[L29]` olmOCR GitHub README（Apache-2.0；「Recent NVIDIA GPU ... at least 12 GB of GPU RAM」；30 GB 磁盘；vLLM 后端；默认模型 `allenai/olmOCR-2-7B-1025-FP8`）: https://raw.githubusercontent.com/allenai/olmocr/main/README.md
- `[L30]` MinerU GitHub README（v3.4 / 2026-06-18；「convert formulas ... to LaTeX format」、表格转 HTML；pipeline 纯 CPU 86.47 / vlm 8 GB 显存 95.30 / hybrid 95.39；FastAPI HTTP API；vLLM/LMDeploy/SGLang OpenAI 兼容；16 GB RAM / 20 GB 磁盘 / Python 3.10–3.13）: https://raw.githubusercontent.com/opendatalab/MinerU/master/README.md
- `[L31]` MinerU 许可（Apache-2.0 + 附加条款：MAU > 1 亿或月收入 > $20M 须另购商业授权；对外服务须显著标注使用 MinerU；违反自动终止）: https://raw.githubusercontent.com/opendatalab/MinerU/master/LICENSE.md
- `[L32]` HF API + 模型卡 `stepfun-ai/GOT-OCR-2.0-hf`（Apache-2.0；560,528,640 参数 BF16；lastModified 2025-01-31；downloads 126,531；能力含 mathematical formulas / molecular formulas / sheet music）: https://huggingface.co/api/models/stepfun-ai/GOT-OCR-2.0-hf · https://huggingface.co/stepfun-ai/GOT-OCR-2.0-hf
- `[L33]` HF API `rednote-hilab/dots.ocr`（MIT；3,039,179,264 参数 BF16；tags 含 formula/table/layout；lastModified 2025-10-31）。`rednote-hilab/dots.ocr-1.5` 的 API 返回 **401 gated**，元数据无法核验: https://huggingface.co/api/models/rednote-hilab/dots.ocr
- `[L34]` Nougat GitHub README（「Nougat codebase is licensed under MIT. Nougat model weights are licensed under **CC-BY-NC**」；0.1.0-small / 0.1.0-base）: https://raw.githubusercontent.com/facebookresearch/nougat/main/README.md
- `[L35]` npm registry `@huggingface/hub@2.15.0`（MIT；deps `@huggingface/tasks`、`@huggingface/xetchunk-wasm`；optional `cli-progress`；engines Node ≥ 18）: https://registry.npmjs.org/@huggingface/hub/latest
- `[L36]` `@huggingface/hub` README（`downloadFileToCacheDir`、`snapshotDownload`，后者内部复用前者，带 cache dir）: https://github.com/huggingface/huggingface.js/blob/main/packages/hub/README.md
- `[L37]` npm registry `node-llama-cpp@3.20.0`（MIT；Node ≥ 20；预编译二进制 macOS x64/arm64 Metal、Windows x64/arm64 含 CUDA/Vulkan、Linux x64/arm64/armv7l/riscv64）: https://registry.npmjs.org/node-llama-cpp/latest
- `[L38]` npm registry `llama.rn@0.13.0-rc.0`（MIT；React Native binding of llama.cpp；peer react/react-native）+ node-llama-cpp issue #287「feat: React Native support」: https://registry.npmjs.org/llama.rn/latest · https://github.com/withcatai/node-llama-cpp/issues/287
- `[L39]` npm registry `@huggingface/transformers@4.2.0`（Apache-2.0；deps `onnxruntime-web` / `onnxruntime-node`）——本文候选中未找到官方 ONNX 权重: https://registry.npmjs.org/@huggingface/transformers/latest

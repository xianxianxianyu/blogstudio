# 本地 RAG 栈研究 — 打包应用里的 embedding 运行时、模型体积与 SQLite/FTS5

- **范围：** ADR-0006 把 PDF Studio 定为 local-first 跨平台打包应用（Mac/Windows/手机），并明确「ADR-0003/0004 里的 Cloudflare 假设在打包落地时改成 local 形态（SQLite FTS5、本地或用户配的 embedding）」。本文研究这个 local 形态的四件事：① bge-m3 级多语言 embedding 在本地 TypeScript 应用里怎么跑；② bge-m3 的体积/量化在打包应用里是否现实、更小的候选有什么公开数据；③ 本地 SQLite 选型与 FTS5 / 中文 trigram / sqlite-vec hybrid；④ 每条路线的包名、版本、star、维护、许可、是否原生编译。
- **不推翻的约束：** ADR-0003（embedding = bge-m3，理由是唯一有第一方多语言/中文证据）、ADR-0004（存储 = FTS5 + trigram，不引入专门向量库）、ADR-0006（local-first 打包）、ADR-0007（Agent/Model 基础层 = Vercel AI SDK）。技术栈 TypeScript / React / Node 22+，仓库已有 `pdfjs-dist`、`ai`、`@ai-sdk/openai-compatible`。
- **关键用例：** 读者用**中文**提问、文档是**英文**学术论文。**跨语言检索（zh query → en passage）是硬需求**，这一条会淘汰掉大部分「小而快」的候选。
- **方法：** 仅用一手来源——npm registry 元数据（`registry.npmjs.org`）、GitHub REST API（star / 最近 push / archived / license）、HuggingFace Hub API（模型文件的**实测字节数**）、模型卡原文、Node.js 官方 API 文档、`sqlite.org` 官方文档、各仓库 README 与源码。没有第三方博客总结，没有基准聚合站。
- **检索时间：** 2026-08-13。npm 版本、star 数、最近 push 时间均为该日实测值。
- **引用键：** `[S1]…` 对应 [Sources](#sources)。没有引用的论断是我自己的分析，不是一手来源事实。

> ⚠️ 一手来源的可得性说明：`arxiv.org` 在本次检索环境中不可达（TLS 连接被拒），因此 BGE-M3 论文（arXiv 2402.03216）与 mE5 技术报告（arXiv 2402.05672）的**表格数字无法直接引用**。BGE-M3 模型卡把 MIRACL / MKQA / MLDR 结果全部放成**图片**（`imgs/miracl.jpg`、`imgs/mkqa.jpg`、`imgs/long.jpg`），文本里没有数字 `[S20]`。凡是我拿不到原文数字的地方，本文一律写「无公开数据（本次不可达）」，不转述二手数字。可引用的替代一手源是 MTEB 官方结果仓库 `embeddings-benchmark/results` 的逐任务 JSON。

---

## 问题 1 — bge-m3 级 embedding 在本地 TypeScript 应用里怎么跑

### 1.1 路线全景

| 路线 | 入口包 | 推理引擎 | 模型格式 | 桌面（Mac/Win）| 移动端 |
| --- | --- | --- | --- | --- | --- |
| **A. transformers.js（Node）** | `@huggingface/transformers` | ONNX Runtime Node | ONNX | ✅ | ❌（Node 跑不了）|
| **B. transformers.js（浏览器/WebView）** | 同上 | ONNX Runtime Web（WASM / WebGPU）| ONNX | ✅ | ⚠️ 取决于 WebView |
| **C. node-llama-cpp** | `node-llama-cpp` | llama.cpp | GGUF | ✅ | ❌ |
| **D. 移动端原生 ONNX** | `onnxruntime-react-native` | ONNX Runtime Mobile | ONNX | — | ✅ |
| **E. 移动端 llama.cpp** | `llama.rn` / `cactus-react-native` | llama.cpp | GGUF | — | ✅ |
| **F. 用户配置的远端 endpoint** | 已有 `@ai-sdk/openai-compatible` | 任意 | — | ✅ | ✅ |

ADR-0006 说的是「核心循环不依赖服务器」，ADR-0005 已经确立「模型由用户配置 OpenAI-compatible URL + key」。**路线 F 不是本地推理，但它是唯一在所有平台都成立的兜底**，且零新增依赖。

### 1.2 路线 A：transformers.js + ONNX Runtime Node

**版本与维护（2026-08-13 实测）：**

| 项 | 值 |
| --- | --- |
| npm 包名 / 版本 | `@huggingface/transformers` **4.2.0**（最新发布 2026-04-22）`[S1]` |
| 许可 | Apache-2.0 `[S1]` |
| GitHub | `huggingface/transformers.js` — **16,253 star**，最近 push 2026-08-13 `[S2]` |
| 运行时依赖 | `@huggingface/jinja`、`@huggingface/tokenizers`、`onnxruntime-node`、`onnxruntime-web`、`sharp`（**全部是必需依赖，不是 optional**）`[S1]` |
| npm unpackedSize（主包） | 9,536,375 字节 ≈ 9.5 MB `[S1]` |
| `onnxruntime-node` | **1.27.0**、MIT、**unpackedSize 270,827,297 字节 ≈ 258 MB**、**有 `postinstall` 脚本** `[S3]` |
| `onnxruntime-web` | 1.27.0、MIT、unpackedSize ≈ 131 MB、无 install 脚本 `[S4]` |
| `microsoft/onnxruntime` GitHub | **21,370 star**，最近 push 2026-08-14 `[S5]` |

**是否需要原生编译：不需要，但需要下载预编译二进制。** `onnxruntime-node` 有 `postinstall` 脚本 `[S3]`——它不是 `node-gyp` 编译，而是拉取对应平台的预编译 native binding。代价是安装体积与首次 `npm install` 时长（见 §1.6 实测）。

**关键源码事实（`packages/transformers/src/backends/onnx.js`）`[S6]`：**

1. **`onnxruntime-node` 和 `onnxruntime-web` 被无条件同时 import**。源码注释原文：*"Ideally, we could import the `onnxruntime-web` and `onnxruntime-node` packages only when needed… So, we just import both packages, and use the appropriate one based on the environment"*。这意味着**打包器（Electron/Vite）默认会把两套运行时都拖进来**，需要显式配置 external / 排除才能瘦身。
2. **Node 环境下的设备支持**，源码里直接抄了 ONNX Runtime 的官方支持矩阵：

   | EP | Win x64 | Win arm64 | Linux x64 | Linux arm64 | macOS x64 | macOS arm64 |
   | --- | --- | --- | --- | --- | --- | --- |
   | CPU | ✔️ | ✔️ | ✔️ | ✔️ | ✔️ | ✔️ |
   | WebGPU（实验）| ✔️ | ✔️ | ✔️ | ❌ | ✔️ | ✔️ |
   | DirectML | ✔️ | ✔️ | ❌ | ❌ | ❌ | ❌ |
   | CUDA | ❌ | ❌ | ✔️(v12) | ❌ | ❌ | ❌ |
   | CoreML | ❌ | ❌ | ❌ | ❌ | ✔️ | ✔️ |

   **Mac 与 Windows 桌面都被 CPU 完整覆盖**；Mac 额外可选 `coreml`、Windows 额外可选 `dml`。`defaultDevices = ['cpu']` `[S6]`。
3. **默认 dtype 在 Node 下是 `fp32`。** `src/utils/dtypes.js` 里 `DEFAULT_DEVICE_DTYPE = fp32`，`DEFAULT_DEVICE_DTYPE_MAPPING` 只给 `wasm` 映射了 `q8` `[S7]`。**含义很实际：在 Node 里不写 `dtype` 就加载 bge-m3，会去下 2.16 GB 的 fp32 权重**，而不是 543 MB 的 int8。必须显式写 `dtype: 'q8'`（或 `'q4f16'`）。
4. dtype 取值与文件后缀映射是固定的：`fp16→_fp16`、`q8→_quantized`、`int8→_int8`、`q4→_q4`、`q4f16→_q4f16`、`bnb4→_bnb4` `[S7]`——这正好对上 §2.4 表里的实际文件名。v4 新增 `ModelRegistry.get_available_dtypes(repo)` 可以在运行时探测某个仓库有哪些量化档，用来「自动选最小可用量化」`[S8]`。

### 1.3 路线 C：node-llama-cpp

| 项 | 值 |
| --- | --- |
| npm 包名 / 版本 | `node-llama-cpp` **3.20.0** `[S9]` |
| 许可 | MIT `[S9]` |
| GitHub | `withcatai/node-llama-cpp` — **2,153 star**，最近 push 2026-08-11 `[S10]` |
| 上游 | `ggml-org/llama.cpp` — **123,837 star**，最近 push 2026-08-13，MIT `[S11]` |
| engines | `node >= 20.0.0` `[S9]` |
| npm unpackedSize（主包） | 38,502,605 字节 ≈ 36.7 MB `[S9]` |
| 原生编译 | **通常不需要**：README 说 "This package comes with pre-built binaries for macOS, Linux and Windows"；平台二进制走 optionalDependencies（`@node-llama-cpp/mac-arm64-metal`、`win-x64`、`win-x64-cuda`、`win-x64-vulkan`、`linux-x64`、`linux-arm64` 等 **14 个**）`[S9][S12]` |
| 编译回退 | 若无对应平台二进制，**回退到下载 llama.cpp 源码并用 cmake 编译**（README 明说 "without `node-gyp` or Python"），可用 `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` 关掉 `[S12]` |
| embedding 支持 | README 功能列表明写 **"Embedding and reranking support"** `[S12]` |
| GPU | "Metal, CUDA and Vulkan support"、"Adapts to your hardware automatically" `[S12]` |

**相对 transformers.js 的优劣（我的分析）：**
- **优势：** GGUF 量化更狠（bge-m3 Q4_0 = 402 MB vs ONNX int8 543 MB `[S23]`）；Metal/Vulkan 开箱即用；依赖树里没有 `sharp`（图像库，embedding 用不到）。
- **劣势：** 主包 36.7 MB + 依赖 27 个直接 dependency（`cmake-js`、`simple-git`、`yargs`、`ora`、`chalk`… 全是 CLI/构建工具）`[S9]`——这是一个**面向「本地跑 LLM」的完整套件**，而我们只要 embedding 这一个函数。且**存在源码编译回退路径**，在用户机器上是不可控风险（transformers.js 没有这条路径）。

### 1.4 已排除或不适用的候选

- **`fastembed`（fastembed-js）**：`Anush008/fastembed-js` GitHub 状态 **archived**（2026-08-13 实测），最后 push 2025-12-15，177 star `[S13]`。npm 上是 2.1.0 / MIT，依赖 `onnxruntime-node` + `@anush008/tokenizers` `[S14]`。**已归档，不要新用。**
- **`@xenova/transformers`（v2）**：2.17.2，是 transformers.js v3 之前的旧包名 `[S15]`。**用 `@huggingface/transformers` 取代。**
- **`sqlite-lembed`**（在 SQLite 里直接用 llama.cpp 算 embedding）：`asg017/sqlite-lembed`，263 star，**最后 push 2024-11-24**（近两年无更新），仓库无 license 字段 `[S16]`。**不成熟，排除。**

### 1.5 移动端：一手事实与空白

**Node 路线（A、C）在手机上不成立**——`onnxruntime-node` 与 `node-llama-cpp` 都是 Node native addon。手机端的一手可选项：

| 包 | 版本 | 许可 | GitHub | 说明 |
| --- | --- | --- | --- | --- |
| `onnxruntime-react-native` | **1.24.3** | MIT | `microsoft/onnxruntime` 21,371 star，push 2026-08-14 `[S5]` | 官方 "ONNX Runtime bridge for react native" `[S17]` |
| `llama.rn` | **0.13.0-rc.0** | MIT | `mybigday/llama.rn` **1,021 star**，push 2026-08-13 `[S18][S19]` | "React Native binding of llama.cpp" |
| `react-native-executorch` | 无公开数据（npm 本次不可达）| — | `software-mansion/react-native-executorch` **1,686 star**，push 2026-08-14，license `NOASSERTION` `[S20]` | Software Mansion 出品 |
| `cactus-react-native` | **1.13.1** | MIT | — | "Run AI models locally on mobile devices" `[S21]` |

**⚠️ 关键空白（不要在这里推测）：** 上述任何一个包，**都没有发布「bge-m3 / embeddinggemma-300m 级模型在手机上的内存占用、加载耗时或每 chunk 编码耗时」的一手数据**。手机端能不能扛住一个 543 MB（int8 bge-m3）或 187 MB（q4 embeddinggemma）的模型——**无公开数据**，只能自己在真机上测。

**我的分析（明确标注为分析）：** 手机端最现实的形态不是「同一个模型跑三端」，而是**分层降级**：桌面本地跑 → 手机走路线 F（用户配置的 endpoint）或只用 FTS5 关键词检索（零模型）。这与 ADR-0006 的「核心循环不依赖服务器」有张力，需要在打包阶段明确「手机端的核心循环包不包括语义检索」——**这是一个产品决策，不是技术决策，本文不替它做主。**

### 1.6 实测：安装体积与首次加载

本机 Node **v24.18.0** / macOS arm64 / 2026-08-13。

**安装（`npm install @huggingface/transformers`，全新目录）：**

| 指标 | 实测值 |
| --- | --- |
| 安装耗时 | **276 秒（约 5 分钟）**，新增 50 个包 |
| `node_modules` 总计 | **343 MB** |
| `onnxruntime-node` | **216 MB** |
| `onnxruntime-web` | **138 MB** |
| `@img`（sharp 的平台二进制）| 16 MB |
| 实际安装的版本 | `@huggingface/transformers@4.2.0`、`onnxruntime-node@1.24.3`、`onnxruntime-web@1.26.0-dev.20260416-b7804b056c`、`sharp@0.34.5` |

**`onnxruntime-node` 里各平台二进制都装了**（这是打包时必须裁掉的东西）：

| 平台目录 | 大小 |
| --- | --- |
| `bin/napi-v6/win32`（x64 + arm64，含 `DirectML.dll`、`dxcompiler.dll`、`dxil.dll`）| **127 MB** |
| `bin/napi-v6/linux`（x64 + arm64）| **53 MB** |
| `bin/napi-v6/darwin`（arm64）| **35 MB** |

macOS arm64 真正需要的只有 `libonnxruntime.1.24.3.dylib`（**35 MB**）+ `onnxruntime_binding.node`（**260 KB**）。

> ⚠️ 注意 `onnxruntime-web` 被锁到一个 **dev 版本**（`1.26.0-dev.20260416-b7804b056c`），而不是稳定版 1.27.0 `[S4]`。这是 transformers.js 4.2.0 的依赖声明，不是我的配置。

**首次加载与编码（`Xenova/multilingual-e5-small`，`dtype: 'q8'` = 112.8 MB ONNX）：**

| 指标 | COLD（首次，含下载）| WARM（已缓存）|
| --- | --- | --- |
| `pipeline()` 返回 | **613.0 s** | **0.43 s** |
| 磁盘缓存 | 129.1 MB | 129.1 MB |
| 编码 1 条中文短 query | 3 ms | 3 ms |
| 编码 1 条英文 passage | 6 ms | 6 ms |
| 编码 16 条英文 passage（batch）| 50 ms | 48 ms |
| 进程 RSS | 683 MB | 742 MB |
| 输出维度 | 1×384 | 1×384 |

**怎么读这两个数字（重要）：**

- **613 秒不是「transformers.js 很慢」，是本机带宽。** 129.1 MB / 613 s ≈ **0.21 MB/s**，这个沙箱的下行被限速了。**用户侧的首次加载耗时 = 模型体积 ÷ 用户带宽 + 约 0.4 秒初始化**——本文给不出一个有普适性的「首次加载耗时」数字，只能给这个公式和实测的初始化开销。
- **真正稳定、可复用的数字是 WARM 的 0.43 秒**：模型落到本地缓存之后，每次启动 pipeline 只要**不到半秒**。这是打包应用日常路径上的实际成本，很低。
- **编码延迟对 384 维小模型是毫秒级**（单条 3–6 ms，16 条 batch 50 ms）。**bge-m3（1024 维、560M 参数，约为 mE5-small 的 4.7 倍参数）的编码延迟本次未实测**（见文末「明确没有回答的问题」）。
- **RSS 接近 700 MB**——注意这是**跑 112.8 MB 小模型**时的常驻内存。ONNX Runtime 自身的开销不小。**bge-m3 int8（543 MB）下的内存占用未实测。**

---

## 问题 2 — bge-m3 的体积与量化，以及更小的多语言候选

### 2.1 bge-m3 是什么量级：实测文件大小

bge-m3 是 XLM-RoBERTa-large 架构（模型卡自述：`bge-m3-retromae` 是「extend the max_length of xlm-roberta to 8192」）、1024 维、序列长度 8192、MIT 许可 `[S20][S21]`。下面是 HuggingFace Hub API 返回的**实测字节数**（非估算），换算为 MiB：

| 仓库 / 文件 | 大小 | 说明 |
| --- | --- | --- |
| `BAAI/bge-m3` `pytorch_model.bin` | **2165.9 MB** | fp32 原始权重 `[S21]` |
| `BAAI/bge-m3` `onnx/model.onnx_data` | **2161.8 MB** | 官方仓库自带的 ONNX（外部权重文件）`[S21]` |
| `Xenova/bge-m3` `onnx/model_fp16.onnx` | **1081.5 MB** | fp16 `[S22]` |
| `Xenova/bge-m3` `onnx/model_q4f16.onnx` | **667.5 MB** | 4-bit 权重 + fp16 `[S22]` |
| `Xenova/bge-m3` `onnx/model_quantized.onnx`（= int8） | **543.3 MB** | int8 动态量化 `[S22]` |
| `Xenova/bge-m3` `onnx/model_uint8.onnx` / `model_int8.onnx` | **542.1 MB** | 同上 `[S22]` |
| `gpustack/bge-m3-GGUF` `bge-m3-FP16.gguf` | **1104.0 MB** | llama.cpp 路线 `[S23]` |
| `gpustack/bge-m3-GGUF` `bge-m3-Q8_0.gguf` | **605.2 MB** | `[S23]` |
| `gpustack/bge-m3-GGUF` `bge-m3-Q4_K_M.gguf` | **417.5 MB** | `[S23]` |
| `gpustack/bge-m3-GGUF` `bge-m3-Q4_0.gguf` | **402.0 MB** | `[S23]` |

**为什么 GGUF 比 ONNX int8 小这么多（402 MB vs 543 MB）：** bge-m3 的 5.6 亿参数里有很大一块是 **XLM-RoBERTa 的 25 万词表 embedding 矩阵**（250,002 × 1024 ≈ 2.56 亿参数，占总参数的近一半）。ONNX 的 int8 动态量化通常不量化这张表，GGUF 的 K-quant 会。这是我从两组实测文件大小推出的分析，**不是任何一手来源的明说**。

**打包现实性判断（我的分析）：** 543 MB（ONNX int8）或 402 MB（GGUF Q4_0）**不适合塞进安装包**，但**适合首次运行时按需下载**。ADR-0006 说的是「核心循环不依赖服务器」，不是「安装包里必须自带全部权重」——一次性下载后缓存到应用数据目录，之后离线可用，仍然满足 local-first。真正被这个体积挡死的是**手机端**（见 §1.5）。

### 2.2 跨语言（zh query → en passage）的公开数据

**这是本文最重要的一张表。** BGE-M3 模型卡把 MIRACL / MKQA / MLDR 结果全部放成图片、正文没有数字 `[S20]`，arXiv 本次不可达，因此我改用 **MTEB 官方结果仓库 `embeddings-benchmark/results`** 的逐任务 JSON `[S24]`——这是 MTEB 项目自己维护的一手结果存档，每个文件带 `mteb_version` 和 `dataset_revision`。

下面三项都是**同一个 dataset revision** 下的对比（Belebele `75b39939`、MIRACL-HardNegatives `95c8db7d`、MLQA `397ed406`），指标为 **nDCG@10**：

| 模型 | 参数量级 | Belebele `zho_Hans→eng_Latn`（**中文问 / 英文文档**） | Belebele `zho_Hans→zho_Hans` | Belebele `eng→eng` | MIRACL-HN `zh` (dev) | MLQA `zho→eng` (test) |
| --- | --- | --- | --- | --- | --- | --- |
| **BAAI/bge-m3** | ~560M | 0.8980 | 0.9390 | 0.9563 | **0.6364** | 0.6040 |
| **google/embeddinggemma-300m** | ~300M | **0.9524** | 0.9547 | 0.9644 | **0.6491** | **0.7063** |
| **Qwen/Qwen3-Embedding-0.6B** | ~600M | 0.9257 | 0.9310 | 0.9589 | 0.5922 | 0.6506 |
| intfloat/multilingual-e5-large | ~560M | 0.9137 | 0.9523 | 0.9650 | 无数据（该文件 zh 子集为空） | 0.5973（另一 revision）|
| intfloat/multilingual-e5-base | ~278M | 0.8549 | 0.9410 | 0.9579 | 0.5309 | 0.5069 |
| **intfloat/multilingual-e5-small** | ~118M | **0.7963** | 0.9263 | 0.9482 | **0.4837** | **0.4198** |

来源：`[S24]`，各行对应 `results/<model>/<revision>/{BelebeleRetrieval,MIRACLRetrievalHardNegatives,MLQARetrieval}.json`。

**⚠️ 诚实标注：** 各模型跑的 `mteb_version` 不同（bge-m3 与 mE5-base 是 1.12.75，embeddinggemma 是 1.34.7，Qwen3 是 1.38.9，mE5-small 是 1.38.3 / 2.1.17）。**dataset_revision 相同**，所以数据集侧可比；评测框架侧的版本差异我无法排除。这不是一次严格受控的同版本对比，把它当作**量级信号**而不是排名判决。

**MIRACL：** MTEB 官方存档里 `MIRACLRetrieval.json`（非 HardNegatives 版）对 bge-m3 只跑了 `ru/fa/th` 三个子集、对 Qwen3 只跑了 `th`，**都没有 zh**。有 zh 的是 `MIRACLRetrievalHardNegatives`（上表）。**bge-m3 论文里那张 MIRACL 全语言表在本次检索环境中无法获取（arXiv 不可达、模型卡是图片），属于「无公开数据（本次不可达）」。**

### 2.3 从这张表能读出的三件事

1. **multilingual-e5-small 在跨语言这一轴上明显掉队。** 0.7963 vs bge-m3 的 0.8980（Belebele zh→en），MIRACL-HN zh 0.4837 vs 0.6364，MLQA zho→eng 0.4198 vs 0.6040 `[S24]`。注意它的**单语**成绩并不差（zh→zh 0.9263、en→en 0.9482），**掉的正好是跨语言那一项**——这恰恰是 PDF Studio 的硬需求。**「用 mE5-small 换体积」这条路，在本用例上被一手数据否掉了。**
2. **embeddinggemma-300m 在三项跨语言指标上全面优于 bge-m3**，而且参数量只有一半 `[S24]`。它的 ONNX q4 只有 **187.6 MB**、q4f16 **167.3 MB**、fp16 **588.8 MB**、fp32 **1177.3 MB** `[S25]`——比 bge-m3 int8 的 543 MB 小 3 倍。这是本次研究里**唯一一个「更小且跨语言更好」**的候选。
3. **代价在许可与分发：** `google/embeddinggemma-300m` 在 HF 上是 `gated: manual`（需手动申请 + 接受 Gemma Terms of Use），license tag 是 `license:gemma`，**不是 MIT/Apache** `[S26]`。相比之下 bge-m3 是 `license:mit`、`gated: false`，multilingual-e5 系列是 `license:mit`，Qwen3-Embedding-0.6B 是 `license:apache-2.0`，全部非 gated `[S26]`。社区转换版 `onnx-community/embeddinggemma-300m-ONNX` 本身 `gated: false`（可直接下载）`[S25]`，但 Gemma 使用条款仍然适用于权重——**打包分发前需要法务确认**，这不是技术问题，我不给结论。

### 2.4 其他候选的量化文件大小（实测）

| 模型 | fp32 | fp16 | int8 / quantized | q4 / q4f16 |
| --- | --- | --- | --- | --- |
| `onnx-community/embeddinggemma-300m-ONNX` | 1177.3 MB | 588.8 MB | 294.6 MB | **187.6 MB** / **167.3 MB** `[S25]` |
| `Xenova/bge-m3` | 2161.8 MB | 1081.5 MB | 543.3 MB | 1190.4 MB / 667.5 MB `[S22]` |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 1996.5 MB | 1144.3 MB | 585.1 MB | 871.8 MB / 541.2 MB `[S27]` |
| `Xenova/multilingual-e5-small` | 448.5 MB | 224.4 MB | **112.8 MB** | 380.2 MB / 195.3 MB `[S28]` |
| `Xenova/multilingual-e5-base` | 1058.6 MB | 529.5 MB | 265.7 MB | 785.3 MB / 413.0 MB `[S29]` |
| `Xenova/multilingual-e5-large` | 2131.8 MB | 1066.4 MB | 535.7 MB | 无 q4 文件 `[S30]` |

注意 bge-m3 的 `model_q4.onnx`（1190.4 MB）**比 fp16 还大**——4-bit 权重量化在这个模型上产出了更大的文件（很可能是那张 25 万词表 embedding 没被量化、又额外引入了量化元数据）。**bge-m3 在 ONNX 路线上，唯一有意义的压缩点是 int8（543 MB）或 q4f16（667 MB）。**

**没有可靠数据的点：**
- **量化后的检索质量损失**：`Xenova/*` 与 `onnx-community/*` 仓库**没有发布任何量化前后的基准对比**，MTEB 官方结果存档里的成绩全部基于**原始 fp32 权重**，没有量化版本的条目 `[S24][S22][S25]`。所以「int8 之后 zh→en 掉多少」——**无公开数据**。这一条只能靠自己的 eval 回答。
- **bge-m3 蒸馏版**：任务里提到的「bge-m3 蒸馏版」，BAAI 官方在 HF 上发布的相关仓库只有 `bge-m3-unsupervised`（2165.9 MB，与 bge-m3 同尺寸，是训练中间产物不是蒸馏小模型）`[S31]`。**没有找到 BAAI 第一方的 bge-m3 蒸馏小模型**。

---

## 问题 3 — 本地 SQLite、FTS5、中文 trigram 与 sqlite-vec hybrid

本节的结论**大部分是本机实测**（Node v24.18.0 / macOS arm64 / 2026-08-13），不是文档转述。测试脚本与原始输出保留在会话 scratchpad。

### 3.1 三个候选：node:sqlite / better-sqlite3 / libsql

| 轴 | `node:sqlite`（内置） | `better-sqlite3` | `libsql`（Turso 的 better-sqlite3 兼容层）|
| --- | --- | --- | --- |
| npm 包名 / 版本 | 无（Node 内置） | `better-sqlite3` **13.0.3** `[S32]` | `libsql` **0.5.29** / `@libsql/client` **0.17.4** `[S33][S34]` |
| 稳定性 | **Stability: 1.2 — Release candidate** `[S35]` | 生产成熟 | — |
| 许可 | Node 自身（MIT） | MIT `[S32]` | MIT `[S33]` |
| GitHub star / 最近 push | —（nodejs/node） | 7,432 / 2026-08-10 `[S36]` | 335（libsql-js）/ 2026-06-18；libsql 本体 17,131 / 2026-08-11 `[S37][S38]` |
| 原生编译 | **不需要**（Node 二进制自带） | **不需要**（预编译 `prebuilds/`，见下） | 不需要（`@libsql/*` 平台包，napi-rs） |
| 捆绑 SQLite 版本 | **3.53.1**（本机实测） | **3.53.4** `[S39]`（本机实测确认） | 无公开数据（未实测） |
| **FTS5 是否默认编译进去** | **是**（见 §3.2） | **是** `[S39]` | 无公开数据（未实测） |
| 加载 SQLite 扩展 | **是**，`new DatabaseSync(path, { allowExtension: true })` + `db.loadExtension()` `[S35]` | 是（README 列 "user-defined functions, aggregates, virtual tables, and **extensions**"）`[S40]` | better-sqlite3 兼容 API `[S33]` |

**`sqlite3`（TryGhost/node-sqlite3）已被排除**：GitHub 仓库状态是 **archived**（2026-08-13 实测 `"archived": true`）`[S41]`，且 npm 上有 `install` / `rebuild` 脚本、依赖 `prebuild-install` + 可选 `node-gyp` `[S42]`。不要新用。

**better-sqlite3 不需要在用户机器上编译。** 本机实测 `npm install better-sqlite3` 耗时 **32 秒**、**零编译**，安装后 `node_modules/better-sqlite3/prebuilds/` 里是 **8 个平台的预编译 `.node`**：`darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`linuxmusl-arm64`、`linuxmusl-x64`、`win32-arm64`、`win32-x64`，每个约 1.9–2.4 MB，整包 29 MB。打包时只需要保留目标平台那一个（约 2 MB）。

### 3.2 FTS5 与中文 trigram —— 本机实测

**node:sqlite 的 `pragma compile_options` 实测包含 `ENABLE_FTS5`**（同时有 `ENABLE_FTS3`、`ENABLE_FTS3_PARENTHESIS`，但**没有** `ENABLE_FTS4`）。完整实测输出里的相关项：

```
ENABLE_COLUMN_METADATA, ENABLE_DBSTAT_VTAB, ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS,
ENABLE_FTS5, ENABLE_GEOPOLY, ENABLE_MATH_FUNCTIONS, ENABLE_PERCENTILE,
ENABLE_PREUPDATE_HOOK, ENABLE_RBU, ENABLE_RTREE, ENABLE_SESSION
```

**这一点在 Node 官方文档里查不到** —— `nodejs.org/docs/latest/api/sqlite.md` 全文**没有出现过 "FTS"、"full-text" 或 "fts5" 字样** `[S35]`。也就是说 FTS5 可用是**实测事实**，不是 Node 的文档承诺；理论上未来某个 Node 版本改了捆绑配置不会违反任何文档约定。这是选 `node:sqlite` 的一个真实风险。better-sqlite3 相反——它在 `docs/compilation.md` 里**白纸黑字列出** `SQLITE_ENABLE_FTS5`（连同 FTS3/FTS4）作为 bundled configuration `[S39]`。

**中文 trigram 实测（node:sqlite，SQLite 3.53.1）：**

测试文档：`本文提出了一种新的注意力机制用于神经网络检索`（中文）与 `We propose a new attention mechanism for neural retrieval`（英文）。

| 场景 | 结果 |
| --- | --- |
| `unicode61`（默认）+ 中文查询 `检索` | **[] 空** — 印证 ADR-0004 的判断 |
| `unicode61` + 整句中文精确短语 | 命中 |
| `unicode61` + 英文 `attention` | 命中 |
| `trigram` + 中文 **2 字** `检索` | **[] 空** |
| `trigram` + 中文 **3 字** `注意力` | 命中 |
| `trigram` + 中文 **4 字** `注意力机制` | 命中，`bm25` = -1.236e-6 |
| `trigram` + 英文 `attention` | 命中 |
| `trigram` + 英文大写 `ATTENTION` | 命中（trigram 默认大小写不敏感）|
| `trigram` + 英文子串 `tent` | 命中（子串匹配，非词匹配）|
| `trigram case_sensitive 1` 建表 | 成功 |
| `porter unicode61` 建表 + 词干查询 `retrieve` | 命中 |
| `fts5vocab` | 可用 |

**结论（ADR-0004 的 trigram 假设在本地成立，但有一条硬边界）：trigram 对中文查询有 3 字下限。** 中文里大量高频检索词是 **2 个字**（「检索」「模型」「梯度」「注意」），这些查询在 trigram 索引上**返回空**——不是排序差，是零召回。这是 SQLite 官方文档明写的规则的直接后果（trigram "treats each contiguous sequence of three characters as a token"），但在中文语境下的严重性没有任何一手来源讨论过。**这是我这次研究里认为最需要决策者知道的一条。**

可行的缓解（我的分析，无一手来源背书）：① 在 query 侧对 <3 字的中文词做扩展（补上下文字符）；② 靠向量检索兜住短查询（§3.3 的 hybrid）；③ 自己实现 FTS5 custom tokenizer 做中文分词——但 `node:sqlite` 与 `better-sqlite3` 的公开 API 里**都没有注册 FTS5 自定义 tokenizer 的入口**（`fts5_api` 需要 C 层 `sqlite3_prepare` + `fts5_api_ptr`），实测未验证，按「无公开数据」处理。

### 3.3 sqlite-vec：与 FTS5 做 hybrid 的现实性

| 轴 | 事实 |
| --- | --- |
| npm 包名 / 版本 | `sqlite-vec` **0.1.9** `[S43]` |
| 许可 | `MIT OR Apache`（npm 元数据字段原文）；GitHub 仓库 SPDX 为 **Apache-2.0** `[S43][S44]` |
| GitHub star / 最近 push | **8,008** / 2026-05-18 `[S44]` |
| 成熟度 | README 顶部有醒目告示：**"`sqlite-vec` is a pre-v1, so expect breaking changes!"** `[S45]` |
| 背书 | **Mozilla Builders 项目**，另有 Fly.io / Turso / SQLite Cloud / Shinkai 赞助 `[S45]` |
| 实现 | "Written in pure C, no dependencies, runs anywhere SQLite runs (Linux/MacOS/Windows, in the browser with WASM, Raspberry Pis, etc.)" `[S45]` |
| 打包代价 | **极小**。npm 主包 unpackedSize **4,004 字节**（纯 loader），平台二进制走 optionalDependencies：`sqlite-vec-darwin-arm64` / `-darwin-x64` / `-linux-x64` / `-linux-arm64` / `-windows-x64` `[S43]`。本机实测 `sqlite-vec-darwin-arm64` 目录 **168 KB**，其中 `vec0.dylib` **161,896 字节**。 |
| 原生编译 | **不需要**（预编译 `.dylib`/`.so`/`.dll`）|

**本机实测（Node v24.18.0，macOS arm64）：**

- `sqlite-vec` 在 **`node:sqlite`（`allowExtension: true` + `sqliteVec.load(db)`）与 `better-sqlite3` 两边都成功加载**，`select vec_version()` 返回 `v0.1.9`。
- **可以和 FTS5 共存在同一个 `.db` 文件里**，用一条 SQL（CTE + `row_number()` 做 RRF 式融合）同时查 `vec0` 和 `fts5` 表并 join 结果——hybrid 不需要第二个进程、第二套存储、第二份数据。

**实测性能（内存库，5,000 条 1024 维 float32 向量 + 5,000 条 trigram FTS5 行）：**

| 操作 | 耗时 |
| --- | --- |
| 插入 5,000 条 1024 维向量（单事务）| 263.0 ms |
| 插入 5,000 条 trigram FTS5 行（单事务）| 15.8 ms |
| `vec0` KNN top-10 | **1.6 ms** |
| FTS5 trigram top-10 | **2.2 ms** |
| hybrid（两路 top-60 + RRF 融合 + join）| **4.2 ms** |

**实测落盘体积（10,000 条向量，含索引开销）：**

| 向量类型 | 10,000 行落盘 | KNN top-10 |
| --- | --- | --- |
| `float[1024]`（bge-m3 / mE5 维度） | **40.3 MB** | 8.4 ms |
| `float[768]`（embeddinggemma 默认维度） | **30.3 MB** | 6.3 ms |
| `float[384]`（mE5-small / Matryoshka 截断） | **15.3 MB** | 3.3 ms |

对照：单篇论文切成几百块，1 万条向量≈几十篇论文的知识库。**在这个规模上 sqlite-vec 是暴力全扫（无 ANN 索引），毫秒级，完全够用。** README 自称 "fast enough"，**没有发布任何规模/延迟基准**，超过 10 万条向量后的表现——**无公开数据**。

**实测踩到的两个坑（如实报告）：**

1. **`vec0` 表的 `rowid` 必须绑定为 BigInt。** 用普通 JS `number` 插入会报 `Only integers are allows for primary key values on <table>`（错误信息里的拼写错误是 sqlite-vec 0.1.9 原文）——**在 `node:sqlite` 和 `better-sqlite3` 上都会触发**。改成 `BigInt(i)` 即可。这是 pre-v1 软件的典型粗糙面，不是阻断问题，但会让第一次接的人卡住。
2. **`int8[N]` / `bit[N]` 列的写入不接受同字节数的 `Buffer`**：实测报 `Inserted vector for the "embedding" column is expected to be of type int8, but a float32 vector was provided.` README 声称支持 float/int8/binary 三种 `[S45]`，但正确的 JS 侧绑定方式在 npm 包文档里没写清楚——**我只实测验证了 `float[N]`**。int8/bit 的压缩收益（理论上 4x / 32x）**本次未能验证**。

---

## 问题 4 — 各路线的包名 / 版本 / star / 维护 / 许可 / 原生编译

全部为 2026-08-13 实测（npm registry `latest` 元数据 + GitHub REST API）。「原生编译」一列区分三种情况：**不需要**（纯 JS / Node 自带）、**预编译**（下载平台二进制，无需本机工具链）、**可能编译**（有源码编译回退路径）。

### 4.1 Embedding 运行时

| npm 包 | 版本 | 许可 | GitHub star | 最近 push | 原生编译 | 安装体积 |
| --- | --- | --- | --- | --- | --- | --- |
| `@huggingface/transformers` | 4.2.0 | Apache-2.0 | 16,253 | 2026-08-13 | **预编译**（经 `onnxruntime-node` postinstall）| **343 MB**（实测 `node_modules`，见 §1.6）|
| `onnxruntime-node` | 1.27.0（transformers.js 4.2.0 实际锁 **1.24.3**）| MIT | 21,370（onnxruntime）| 2026-08-14 | **预编译**（`postinstall`）| 216 MB（实测）|
| `onnxruntime-web` | 1.27.0（实际锁 `1.26.0-dev.20260416-b7804b056c`）| MIT | 同上 | 同上 | 不需要（WASM）| 138 MB（实测）|
| `node-llama-cpp` | 3.20.0 | MIT | 2,153 | 2026-08-11 | **可能编译**（无预编译时 cmake 从源码构建）| 未实测 |
| `onnxruntime-react-native` | 1.24.3 | MIT | 21,370 | 2026-08-14 | 原生（RN 链接）| 未实测 |
| `llama.rn` | 0.13.0-rc.0 | MIT | 1,021 | 2026-08-13 | 原生（RN 链接）| 未实测 |
| `react-native-executorch` | npm 本次不可达 | `NOASSERTION` | 1,686 | 2026-08-14 | 原生（RN 链接）| 未实测 |
| `cactus-react-native` | 1.13.1 | MIT | 无公开数据 | — | 原生（RN 链接）| 未实测 |
| ~~`fastembed`~~ | 2.1.0 | MIT | 177 | 2025-12-15 | 预编译 | **仓库已 archived，排除** |
| ~~`@xenova/transformers`~~ | 2.17.2 | Apache-2.0 | 同 transformers.js | — | — | **旧包名，用 `@huggingface/transformers`** |

### 4.2 本地存储

| npm 包 | 版本 | 许可 | GitHub star | 最近 push | 原生编译 | FTS5 |
| --- | --- | --- | --- | --- | --- | --- |
| `node:sqlite`（内置）| Node 24.18.0 内置 SQLite **3.53.1** | MIT（Node）| — | — | **不需要** | **实测有**（`ENABLE_FTS5`），**但文档无承诺** |
| `better-sqlite3` | 13.0.3 | MIT | 7,432 | 2026-08-10 | **预编译**（8 平台 `prebuilds/`，实测零编译）| **文档明写有** `[S39]` |
| `libsql` | 0.5.29 | MIT | 335（libsql-js）/ 17,131（libsql）| 2026-06-18 / 2026-08-11 | 预编译（`@libsql/*` napi 平台包）| 未实测 |
| `@libsql/client` | 0.17.4 | MIT | 同上 | — | 同上 | 未实测 |
| `@sqlite.org/sqlite-wasm` | 3.53.0-build1 | Apache-2.0 | 1,040 | 2026-07-13 | 不需要（WASM）| 未实测 |
| `node-sqlite3-wasm` | 0.8.60 | MIT | 93 | 2026-08-12 | 不需要（WASM）| 未实测 |
| ~~`sqlite3`~~ | 6.0.1 | BSD-3-Clause | 6,418 | 2026-06-27 | 预编译 + `node-gyp` 回退 | **仓库已 archived，排除** |
| `@op-engineering/op-sqlite`（移动端）| 17.2.0 | MIT | 1,031 | 2026-08-13 | 原生（RN 链接）| **README 明列 "FTS5 plugin"**、"sqlite-vec plugin"、"Custom tokenizers"、iOS/Android/macOS/web `[S46]` |
| `expo-sqlite`（移动端）| 57.0.1 | MIT | 51,593（expo）| 2026-08-14 | 原生 | 无公开数据（README 未提 FTS5）|

### 4.3 本地向量检索

| npm 包 | 版本 | 许可 | GitHub star | 最近 push | 原生编译 | 打包体积 |
| --- | --- | --- | --- | --- | --- | --- |
| `sqlite-vec` | 0.1.9（**pre-v1**）| `MIT OR Apache`（npm）/ Apache-2.0（GitHub）| **8,008** | 2026-05-18 | **预编译**（平台 optionalDeps）| **主包 4 KB + 单平台 162 KB**（实测 `vec0.dylib` = 161,896 字节）|
| ~~`sqlite-lembed`~~ | — | 无 license 字段 | 263 | **2024-11-24** | — | **近两年未更新，排除** |

---

## 结论 — 推荐路线与备选

### 推荐路线（默认）

> **存储：`better-sqlite3` + FTS5（trigram）+ `sqlite-vec` 单文件 hybrid。
> Embedding：`@huggingface/transformers` 跑 ONNX，模型首次运行时按需下载并缓存，`dtype` 显式指定量化档。
> 桌面上 bge-m3 int8（543 MB）保持 ADR-0003 不变；移动端降级到 FTS5-only 或用户配置的 endpoint（ADR-0005 路线 F）。**

理由，逐条对应一手证据：

1. **存储层几乎没有代价。** `better-sqlite3` 零编译（8 平台预编译，实测 32 秒装好）、FTS5 在其 `docs/compilation.md` 里是**书面承诺**而非侥幸 `[S39]`；`sqlite-vec` 单平台只有 **162 KB**，和 FTS5 共存在同一个 `.db` 文件里，一条 SQL 就能做 hybrid，实测 5,000 条规模下 hybrid 查询 **4.2 ms**。这套组合把 ADR-0004 的「不引入专门向量库」原封不动地搬到了本地——**sqlite-vec 是 SQLite 扩展，不是第二个数据库**。
2. **`better-sqlite3` 比 `node:sqlite` 更适合打包应用**，尽管后者零依赖更诱人：`node:sqlite` 的 Stability 是 **1.2 Release candidate** `[S35]`，且它的 FTS5 可用性**在 Node 文档里没有任何书面保证**（全文无 "FTS" 字样）——我们靠 `pragma compile_options` 实测才知道有。给一个要长期维护的打包应用押这个，风险不对称。
3. **Embedding 层保留 ADR-0003 的 bge-m3**，因为 §2.2 的一手数据确认它在 zh→en 跨语言上确实合格（Belebele 0.8980、MIRACL-HN zh 0.6364），而**唯一「更小」的候选 multilingual-e5-small 在跨语言这一项上明显不合格**（0.7963 / 0.4837 / 0.4198）`[S24]`——换体积要付的质量代价正好落在硬需求上。
4. **transformers.js 而非 node-llama-cpp**：前者无源码编译回退路径（后者有 cmake 回退 `[S12]`），且 ONNX Runtime 的桌面支持矩阵在源码里被明确列出、Mac/Windows 的 CPU 全覆盖 `[S6]`。node-llama-cpp 是一个面向「本地跑 LLM」的完整套件（27 个直接依赖、含 `cmake-js`/`simple-git`/`yargs`），我们只要 embedding 一个函数。

**落地时必须做对的两件事（否则默认行为会咬人）：**
- **必须显式写 `dtype`。** Node 下默认是 `fp32` `[S7]`——不写就是去下 **2.16 GB**，而不是 543 MB。
- **必须在打包配置里排除不用的运行时。** transformers.js 无条件同时 import `onnxruntime-node` 和 `onnxruntime-web` `[S6]`；`onnxruntime-node` 装完是 **216 MB**，其中 **win32 目录 127 MB、linux 53 MB、darwin 35 MB** 全都在（实测）。桌面打包只需保留目标平台那一份，macOS arm64 实际只要 `libonnxruntime.dylib` 35 MB + `onnxruntime_binding.node` 260 KB。

### 备选路线

> **把 embedding 换成 `google/embeddinggemma-300m`（ONNX q4，187.6 MB）。**

它在 §2.2 的三项跨语言指标上**全面优于 bge-m3**（Belebele zh→en **0.9524** vs 0.8980、MIRACL-HN zh 0.6491 vs 0.6364、MLQA zho→eng 0.7063 vs 0.6040）`[S24]`，模型文件小 **3 倍**（187.6 MB vs 543 MB）`[S25][S22]`，768 维还能把 sqlite-vec 的落盘从 40.3 MB/万条降到 30.3 MB/万条（实测）。**这是本次研究里唯一一个「更小且更好」的选项。**

它不是默认，只因为一个非技术原因：`google/embeddinggemma-300m` 是 `gated: manual` + `license:gemma`，不是 MIT/Apache `[S26]`。bge-m3（MIT）在分发上没有任何要澄清的东西。

### 触发切换的条件

| 触发条件 | 切到哪 |
| --- | --- |
| 内部 eval 显示 bge-m3 int8 量化后 zh→en 召回明显掉（§2.4 明确指出**量化质量损失无公开数据**）| embeddinggemma-300m q4，或 bge-m3 提到 q4f16 (667 MB) |
| 543 MB 的首次下载被判定为不可接受的上手成本 | embeddinggemma-300m q4（187.6 MB），**前提是先过法务对 Gemma Terms of Use 的确认** |
| 法务确认 Gemma 条款可接受，且 eval 复现了 §2.2 的差距 | **直接把 embeddinggemma-300m 提为默认**（更小 + 更好，没有理由不换）|
| 中文 2 字查询的零召回（§3.2）成为实际投诉 | 优先靠向量侧兜（hybrid 里提高向量权重）；仍不够再评估自定义 tokenizer——注意 `node:sqlite` / `better-sqlite3` **都没有公开的 FTS5 tokenizer 注册 API** |
| 知识库涨到 10 万条向量以上 | 重新评估 sqlite-vec（README 只自称 "fast enough"，**该规模无公开数据**），届时才考虑 ANN 或专门向量库 |
| 需要真正的移动端本地语义检索 | `@op-engineering/op-sqlite`（FTS5 + sqlite-vec + 自定义 tokenizer，iOS/Android `[S46]`）+ `onnxruntime-react-native` 或 `llama.rn`——**但这三者在本用例上的真机内存/耗时全部无公开数据，必须先做真机 spike** |

### 本文明确没有回答的问题（留给 eval，不要推测）

1. **量化后的检索质量。** 所有模型的 MTEB 成绩都基于 fp32 权重 `[S24]`，`Xenova/*` 与 `onnx-community/*` 没有发布量化前后对比 `[S22][S25]`。int8 / q4 之后 zh→en 掉多少——**无公开数据**。
2. **手机端可行性。** 没有任何一手来源发布过 bge-m3 或 embeddinggemma-300m 级模型在手机上的内存占用与耗时——**无公开数据**。
3. **bge-m3 的 MIRACL 全语言表。** 模型卡是图片、arXiv 本次不可达 `[S20]`；MTEB 官方存档里 `MIRACLRetrieval.json` 对 bge-m3 只有 `ru/fa/th`，**没有 zh** `[S24]`。本文用的是 `MIRACLRetrievalHardNegatives` 的 zh 子集。
4. **libsql / `@sqlite.org/sqlite-wasm` / `expo-sqlite` 的 FTS5 与 trigram 情况**——本次未实测，**无公开数据**。
5. **sqlite-vec 的 int8 / bit 向量**——README 声称支持 `[S45]`，本次实测只验证了 `float[N]`，int8/bit 的 JS 侧绑定方式未跑通。

---

## Sources

- `[S1]` npm registry — `@huggingface/transformers`（4.2.0、Apache-2.0、deps 含 onnxruntime-node/web/sharp、unpackedSize 9,536,375）: https://registry.npmjs.org/@huggingface/transformers
- `[S2]` GitHub API — `huggingface/transformers.js`（16,253 star、push 2026-08-13、Apache-2.0）: https://api.github.com/repos/huggingface/transformers.js
- `[S3]` npm registry — `onnxruntime-node`（1.27.0、MIT、postinstall、unpackedSize 270,827,297）: https://registry.npmjs.org/onnxruntime-node
- `[S4]` npm registry — `onnxruntime-web`（1.27.0、MIT、无 install 脚本）: https://registry.npmjs.org/onnxruntime-web
- `[S5]` GitHub API — `microsoft/onnxruntime`（21,370 star、push 2026-08-14、MIT）: https://api.github.com/repos/microsoft/onnxruntime
- `[S6]` transformers.js 源码 `packages/transformers/src/backends/onnx.js`（同时 import node/web 两套运行时；Node 的 EP 支持矩阵；`defaultDevices = ['cpu']`）: https://raw.githubusercontent.com/huggingface/transformers.js/main/packages/transformers/src/backends/onnx.js
- `[S7]` transformers.js 源码 `packages/transformers/src/utils/dtypes.js`（`DEFAULT_DEVICE_DTYPE = fp32`；仅 wasm 映射 q8；dtype→文件后缀映射）: https://raw.githubusercontent.com/huggingface/transformers.js/main/packages/transformers/src/utils/dtypes.js
- `[S8]` transformers.js 文档 — Using quantized models (dtypes)（dtype 列表、`ModelRegistry.get_available_dtypes()`）: https://raw.githubusercontent.com/huggingface/transformers.js/main/packages/transformers/docs/source/guides/dtypes.md
- `[S9]` npm registry — `node-llama-cpp`（3.20.0、MIT、node>=20、14 个平台 optionalDeps、27 个直接依赖、unpackedSize 38,502,605）: https://registry.npmjs.org/node-llama-cpp
- `[S10]` GitHub API — `withcatai/node-llama-cpp`（2,153 star、push 2026-08-11、MIT）: https://api.github.com/repos/withcatai/node-llama-cpp
- `[S11]` GitHub API — `ggml-org/llama.cpp`（123,837 star、push 2026-08-13、MIT）: https://api.github.com/repos/ggml-org/llama.cpp
- `[S12]` node-llama-cpp README（预编译二进制 + cmake 源码回退、`NODE_LLAMA_CPP_SKIP_DOWNLOAD`、"Embedding and reranking support"、Metal/CUDA/Vulkan）: https://raw.githubusercontent.com/withcatai/node-llama-cpp/master/README.md
- `[S13]` GitHub API — `Anush008/fastembed-js`（**archived: true**、177 star、push 2025-12-15）: https://api.github.com/repos/Anush008/fastembed-js
- `[S14]` npm registry — `fastembed`（2.1.0、MIT、deps onnxruntime-node + @anush008/tokenizers）: https://registry.npmjs.org/fastembed/latest
- `[S15]` npm registry — `@xenova/transformers`（2.17.2、Apache-2.0，v3 前的旧包名）: https://registry.npmjs.org/@xenova/transformers/latest
- `[S16]` GitHub API — `asg017/sqlite-lembed`（263 star、**push 2024-11-24**、license 字段为 null）: https://api.github.com/repos/asg017/sqlite-lembed
- `[S17]` npm registry — `onnxruntime-react-native`（1.24.3、MIT、"ONNX Runtime bridge for react native"）: https://registry.npmjs.org/onnxruntime-react-native/latest
- `[S18]` npm registry — `llama.rn`（0.13.0-rc.0、MIT、"React Native binding of llama.cpp"）: https://registry.npmjs.org/llama.rn/latest
- `[S19]` GitHub API — `mybigday/llama.rn`（1,021 star、push 2026-08-13、MIT）: https://api.github.com/repos/mybigday/llama.rn
- `[S20]` BAAI/bge-m3 模型卡（1024 维 / 8192 序列 / xlm-roberta 血统；MIRACL、MKQA、MLDR 结果**均为图片** `imgs/miracl.jpg` 等，正文无数字）: https://huggingface.co/BAAI/bge-m3/raw/main/README.md
- `[S21]` HuggingFace Hub API — `BAAI/bge-m3`（文件实测字节数：`pytorch_model.bin` 2165.9 MB、`onnx/model.onnx_data` 2161.8 MB；`license:mit`、`gated: false`）: https://huggingface.co/api/models/BAAI/bge-m3?blobs=true
- `[S22]` HuggingFace Hub API — `Xenova/bge-m3`（各量化档实测大小：fp16 1081.5 MB、int8/uint8 542.1 MB、quantized 543.3 MB、q4 1190.4 MB、q4f16 667.5 MB）: https://huggingface.co/api/models/Xenova/bge-m3?blobs=true
- `[S23]` HuggingFace Hub API — `gpustack/bge-m3-GGUF`（FP16 1104.0 MB、Q8_0 605.2 MB、Q4_K_M 417.5 MB、Q4_0 402.0 MB、Q2_K 349.2 MB）: https://huggingface.co/api/models/gpustack/bge-m3-GGUF?blobs=true
- `[S24]` MTEB 官方结果仓库 `embeddings-benchmark/results`（逐任务 JSON，含 `mteb_version` 与 `dataset_revision`；本文用到 `BelebeleRetrieval`、`MIRACLRetrievalHardNegatives`、`MLQARetrieval`、`MIRACLRetrieval`）: https://github.com/embeddings-benchmark/results ；原始文件如 https://raw.githubusercontent.com/embeddings-benchmark/results/main/results/BAAI__bge-m3/5617a9f61b028005a4858fdac845db406aefb181/BelebeleRetrieval.json
- `[S25]` HuggingFace Hub API — `onnx-community/embeddinggemma-300m-ONNX`（fp32 1177.3 MB、fp16 588.8 MB、quantized 294.6 MB、q4 187.6 MB、q4f16 167.3 MB；`gated: false`）: https://huggingface.co/api/models/onnx-community/embeddinggemma-300m-ONNX?blobs=true
- `[S26]` HuggingFace Hub API — 各模型 gating 与 license 字段（`google/embeddinggemma-300m` **gated: manual / license:gemma**；`BAAI/bge-m3` gated: false / license:mit；`intfloat/multilingual-e5-small` license:mit；`Qwen/Qwen3-Embedding-0.6B` license:apache-2.0）: https://huggingface.co/api/models/google/embeddinggemma-300m 等
- `[S27]` HuggingFace Hub API — `onnx-community/Qwen3-Embedding-0.6B-ONNX`（fp32 1996.5 MB、fp16 1144.3 MB、int8 585.1 MB、q4f16 541.2 MB）: https://huggingface.co/api/models/onnx-community/Qwen3-Embedding-0.6B-ONNX?blobs=true
- `[S28]` HuggingFace Hub API — `Xenova/multilingual-e5-small`（fp32 448.5 MB、fp16 224.4 MB、quantized 112.8 MB、q4f16 195.3 MB）: https://huggingface.co/api/models/Xenova/multilingual-e5-small?blobs=true
- `[S29]` HuggingFace Hub API — `Xenova/multilingual-e5-base`: https://huggingface.co/api/models/Xenova/multilingual-e5-base?blobs=true
- `[S30]` HuggingFace Hub API — `Xenova/multilingual-e5-large`: https://huggingface.co/api/models/Xenova/multilingual-e5-large?blobs=true
- `[S31]` HuggingFace Hub API — `BAAI/bge-m3-unsupervised`（2165.9 MB，与 bge-m3 同尺寸，非蒸馏小模型）: https://huggingface.co/api/models/BAAI/bge-m3-unsupervised?blobs=true
- `[S32]` npm registry — `better-sqlite3`（13.0.3、MIT、node>=22、无 install 脚本、unpackedSize 27,302,969）: https://registry.npmjs.org/better-sqlite3/latest
- `[S33]` npm registry — `libsql`（0.5.29、MIT、`@libsql/*` 平台 optionalDeps）: https://registry.npmjs.org/libsql/latest
- `[S34]` npm registry — `@libsql/client`（0.17.4、MIT）: https://registry.npmjs.org/@libsql/client/latest
- `[S35]` Node.js 官方文档 — `node:sqlite`（**Stability: 1.2 - Release candidate**；`allowExtension` / `loadExtension()` / `enableLoadExtension()`；**全文无 "FTS" / "full-text" 字样**）: https://nodejs.org/docs/latest/api/sqlite.md
- `[S36]` GitHub API — `WiseLibs/better-sqlite3`（7,432 star、push 2026-08-10、MIT）: https://api.github.com/repos/WiseLibs/better-sqlite3
- `[S37]` GitHub API — `tursodatabase/libsql-js`（335 star、push 2026-06-18、MIT）: https://api.github.com/repos/tursodatabase/libsql-js
- `[S38]` GitHub API — `tursodatabase/libsql`（17,131 star、push 2026-08-11、MIT）: https://api.github.com/repos/tursodatabase/libsql
- `[S39]` better-sqlite3 `docs/compilation.md`（bundled SQLite **3.53.4**；编译选项列表含 `SQLITE_ENABLE_FTS3/FTS4/FTS5`；自定义 amalgamation 的 `--build-from-source --sqlite3=` 流程）: https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/compilation.md
- `[S40]` better-sqlite3 README（"user-defined functions, aggregates, virtual tables, and extensions"；"Prebuilt binaries are available for major platforms/architectures"）: https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/README.md
- `[S41]` GitHub API — `TryGhost/node-sqlite3`（**archived: true**、6,418 star、push 2026-06-27）: https://api.github.com/repos/TryGhost/node-sqlite3
- `[S42]` npm registry — `sqlite3`（6.0.1、BSD-3-Clause、`install`/`rebuild` 脚本、`prebuild-install` + 可选 `node-gyp`）: https://registry.npmjs.org/sqlite3/latest
- `[S43]` npm registry — `sqlite-vec`（0.1.9、`MIT OR Apache`、unpackedSize **4,004** 字节、5 个平台 optionalDeps）: https://registry.npmjs.org/sqlite-vec/latest
- `[S44]` GitHub API — `asg017/sqlite-vec`（**8,008 star**、push 2026-05-18、Apache-2.0）: https://api.github.com/repos/asg017/sqlite-vec
- `[S45]` sqlite-vec README（**"pre-v1, so expect breaking changes!"**；"pure C, no dependencies, runs anywhere SQLite runs"；float/int8/binary 三种向量；Mozilla Builders 项目）: https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md
- `[S46]` `@op-engineering/op-sqlite` README（iOS/Android/macOS/web；**FTS5 plugin**、**sqlite-vec plugin**、**Custom tokenizers**、Load runtime extensions、libsql/Turso/SQLCipher 编译目标；MIT）: https://raw.githubusercontent.com/OP-Engineering/op-sqlite/main/README.md ；npm https://registry.npmjs.org/@op-engineering/op-sqlite/latest
- `[S47]` GitHub API — `software-mansion/react-native-executorch`（1,686 star、push 2026-08-14、license `NOASSERTION`）: https://api.github.com/repos/software-mansion/react-native-executorch
- `[S48]` npm registry — `cactus-react-native`（1.13.1、MIT、"Run AI models locally on mobile devices"）: https://registry.npmjs.org/cactus-react-native/latest
- `[S49]` npm registry — `@sqlite.org/sqlite-wasm`（3.53.0-build1、Apache-2.0、node>=22）: https://registry.npmjs.org/@sqlite.org/sqlite-wasm/latest ；GitHub `sqlite/sqlite-wasm` 1,040 star、push 2026-07-13
- `[S50]` npm registry — `node-sqlite3-wasm`（0.8.60、MIT）: https://registry.npmjs.org/node-sqlite3-wasm/latest ；GitHub `tndrle/node-sqlite3-wasm` 93 star、push 2026-08-12
- `[S51]` npm registry — `expo-sqlite`（57.0.1、MIT）: https://registry.npmjs.org/expo-sqlite/latest ；GitHub `expo/expo` 51,593 star
- `[S52]` SQLite 官方文档 — FTS5（`unicode61` 默认 tokenizer 规则；`trigram` "treats each contiguous sequence of three characters as a token"，支持子串匹配与索引化 GLOB/LIKE；`bm25()`；`fts5vocab`；全文未提及中文/CJK）: https://sqlite.org/fts5.html
- `[S53]` intfloat/multilingual-e5-small 模型卡（"This model has 12 layers and the embedding size is 384"；`license: mit`；Mr. TyDi 表；MTEB frontmatter 含 BUCC (zh-en) accuracy 89.2575 / f1 88.7923、STS22 (zh-en) cos_sim_spearman 63.7445）: https://huggingface.co/intfloat/multilingual-e5-small/raw/main/README.md
- `[S54]` 本机实测（Node **v24.18.0** / macOS arm64 / 2026-08-13）：`node:sqlite` 的 `sqlite_version()` = 3.53.1 与 `pragma compile_options`；FTS5 / trigram / unicode61 / porter / fts5vocab 中英文查询行为；`npm install better-sqlite3 sqlite-vec` 耗时与 `prebuilds/` 内容；`sqlite-vec` 在 `node:sqlite` 与 `better-sqlite3` 上的加载与 `vec_version()`；vec0 + FTS5 hybrid 查询延迟；vec0 落盘体积；`npm install @huggingface/transformers` 耗时与 `node_modules` 体积。脚本与原始输出保留在本次会话的 scratchpad。

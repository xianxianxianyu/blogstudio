# Embedding 候选复核 — 「中文问题检索英文论文段落」这一个任务上，谁真的更好

- **这不是一份新的候选清单，是对 `research-local-rag-stack.md` §2.2–2.3 的批判性复核。** 上一轮的结论是「embeddinggemma-300m 在三项 zh→en 跨语言指标上全面优于 bge-m3，且 ONNX q4 只有 187.6 MB」。本文去查这三个数字各自测的是什么、能支撑多强的结论，补上被漏掉的维度，加两个候选做交叉验证，最后给一个**可被 `pdfstudio/eval/retrieval/` 证伪的判断**。
- **许可不进入排序。** 本项目开源非商业，Gemma Terms / CC-BY-NC 都不构成阻碍。只按技术比。
- **方法：** 只用一手来源——MTEB 官方任务定义源码与 `descriptive_stats`、MTEB 官方结果存档 `embeddings-benchmark/results` 的逐任务 JSON、MTEB 模型注册表里声明的训练数据、BGE-M3 / EmbeddingGemma / mGTE 三篇论文原文（本次 `arxiv.org` **可达**，与上一轮不同）、HuggingFace Hub API 的实测字节数、模型卡原文、**本机实测**（ONNX 计算图 IO、tokenizer token 数、transformers.js 加载与编码延迟）。没有二手博客数字。
- **检索时间：** 2026-08-14。引用键 `[R1]…` 见 [Sources](#sources)。没有引用键的论断是我的分析，不是一手事实。

---

## 0. 结论先行

**一句话：上一轮那三个数字里，只有一个（MLQA zho→eng）真的在测「中文问题检索英文段落」；另外两个一个是单语中文、一个语料只有 488 篇文档。判断方向不变（embeddinggemma 仍是最可能胜出的），但证据强度比上一轮写的弱得多，而且漏掉了一个体积和成绩都更好看的候选（gte-multilingual-base）。**

| 上一轮的说法 | 复核结果 |
| --- | --- |
| 「三项 zh→en 跨语言指标」 | ❌ **只有一项是跨语言**。MIRACL-HN `zh` 是中文问 + 中文文档的**单语**任务 `[R1]` |
| MIRACL-HN zh 0.6491 vs 0.6364 是有效证据 | ❌ 该数据集是 bge-m3 / embeddinggemma / Qwen3 / gte **四家全部声明过的训练数据** `[R6][R7][R8]`；且差距 0.0127 在 393 条 query 上不可判读 `[R2]` |
| Belebele zh→en 0.9524 vs 0.8980 | ⚠️ 真实，但语料只有 **488 篇文档**、recall@10 已到 0.969/0.989（饱和），差距主要在 top-10 内部排序 `[R2][R3]` |
| MLQA zho→eng 0.7063 vs 0.6040 | ✅ **成立且是三项里唯一相关的**。5,135 query / 4,546 doc，recall@10 0.820 vs 0.739 `[R2][R3]` |
| 「三项都是同一个 dataset revision 下的对比」 | ❌ 对 mE5-small 那一行不成立（MIRACL-HN 用 `d7d94fa4`、MLQA 用 `5bef8b6e`）`[R2]` |
| embeddinggemma q4f16 = 167.3 MB 是最小档 | ❌ **不可用**。模型卡原文：*"EmbeddingGemma activations do not support `fp16` or its derivatives"* `[R11]`。fp16 588.8 MB 同理作废。最小可用是 **q4 187.6 MB** |
| 量化质量损失「无公开数据」 | ⚠️ 一半错：EmbeddingGemma 论文 Table 1 有 int4/int8 的一手数据 `[R9]`——但那是 Google 的 **QAT checkpoint**，不是 onnx-community 那个 q4 文件。对 187.6 MB 这个文件仍然**无公开数据** `[R11][R12]` |
| 候选只有 bge-m3 / embeddinggemma / mE5 / Qwen3 | ❌ 漏了 **gte-multilingual-base**：唯一与 bge-m3 在**同一 mteb_version + 同一 dataset revision** 下跑过 MLQA 和 MIRACL-HN 的候选，MLQA zho-eng **0.6443 > 0.6040**，int8 **324.6 MB < 542.1 MB**，Apache-2.0，8192 上下文 `[R2][R13]` |
| ADR-0003：「bge-m3 是唯一有第一方多语言/中文证据的选项」 | ❌ 已不成立。gte-multilingual-base（mGTE 论文有 MKQA zh_cn 第一方数据 `[R10]`）与 Qwen3-Embedding 都有 |

**我的判断（可证伪，见 §5）：** 在「中文问题 → 英文学术论文段落」上，**embeddinggemma-300m（ONNX q8 294.6 MB，或 q4 187.6 MB）最可能胜出**，gte-multilingual-base（int8 324.6 MB）是最强的第二，bge-m3 排第三。**置信度中等偏低**——干净证据只有一个数据点，而且那个数据点测的是维基百科段落，不是论文段落。

---

## 1. 复核：那三个数字到底测了什么

### 1.1 任务解剖（一手：MTEB 任务定义源码 + 官方 descriptive_stats）

| 任务 / 子集 | 语言方向 | 查询数 | 文档数 | 语料是什么 | 指标 |
| --- | --- | --- | --- | --- | --- |
| `BelebeleRetrieval` `zho_Hans-eng_Latn` (test) | **中文问 → 英文段落** ✅ | **900** | **488**（平均 79 词/段）| FLORES-200 段落（按 `link` 去重）`[R1][R22]` | nDCG@10 |
| `MIRACLRetrievalHardNegatives` `zh` (dev) | **中文问 → 中文段落（单语）** ❌ | **393** | **81,309** | 中文维基，候选集 = BM25 + e5-multilingual-large + e5-mistral-instruct 各取 top-250 池化 `[R1]` | nDCG@10 |
| `MLQARetrieval` `zho-eng` (test) | **中文问 → 英文段落** ✅ | **5,135** | **4,546** | 英文维基百科段落 `[R1]` | nDCG@10 |

> **488 这个数字有第一方确认。** Meta 的 Belebele 数据集卡原文：*"900 questions per language variant"*、*"**488 distinct passages**, there are 1-2 associated questions for each"*、*"Avg. words per passage = 79.1"* `[R22]`。与 MTEB `descriptive_stats` 的 `num_samples = 1388` `[R3]` 完全对上（900 题 + 488 段）。**也就是说：Belebele zh→en 的整个语料是 488 段、每段平均 79 个英文单词。** 我们的目标场景是几十篇论文切成上万块、每块约 600 字符——两个量级完全不同。

**读出来的第一件事：MIRACL-HN `zh` 根本不是跨语言任务。** MTEB 的 `miracl_retrieval.py` 里 `_LANGUAGES = {..., "zh": ["zho-Hans"]}` —— 单元素列表 = 单语 `[R1]`；对照 `mlqa_retrieval.py` 的 `"mlqa.zh.en": ["zho-Hans", "eng-Latn"]` 是双元素 `[R1]`。上一轮把它算进「三项跨语言指标」是一个分类错误。

**第二件事：Belebele 是在 488 篇文档的干草堆里找针。** 我们的真实场景是几十篇论文切成上万块。488 篇语料上的 nDCG@10 差距不能外推到上万块的语料——排序难度随语料规模增长，而 488 篇上所有候选的 recall@10 都已经 0.92–0.99（见 §1.4 表）。

### 1.2 训练数据污染：MIRACL 那一列该直接划掉

MTEB 自己的模型注册表里声明的训练数据（这是 MTEB 维护者根据各模型论文填的，用于 leaderboard 的 zero-shot 判定）：

| 模型 | 声明含 MIRACL？ | 一手出处 |
| --- | --- | --- |
| BAAI/bge-m3 | ✅ `MIRACLRetrieval` / `MIRACLRetrievalHardNegatives` / `MIRACLReranking` | `bge_models.py`，注释标 `# source: https://arxiv.org/abs/2402.03216` `[R6]`。BGE-M3 论文原文亦确认：*"For other languages, we leverage the training data from Mr. Tydi and MIRACL"* `[R4]` |
| google/embeddinggemma-300m | ✅ `MIRACLRetrievalHardNegatives`（经 `GECKO_TRAINING_DATA`）| `google_embeddinggemma.py` + `google_text_embedding.py` `[R7]` |
| Qwen/Qwen3-Embedding-0.6B | ✅ `MIRACLRetrieval` | `qwen3_models.py` `[R8]` |
| Alibaba-NLP/gte-multilingual-base | ✅ `MIRACLRetrieval` / `MIRACLRetrievalHardNegatives` | `gte_models.py`，注释标 `# https://arxiv.org/pdf/2407.19669, Table 11` `[R13]` |

**四个候选全部把 MIRACL 训过。** 这一列衡量的是拟合程度，不是泛化能力，而且它们的训练/评测边界各不相同（有的训 MIRACL 全量、有的训 HardNegatives 版）。**任何基于 MIRACL 的排名对我们都没有决策价值。**

补充两个协议细节：

- `MIRACLRetrievalHardNegatives` 的候选集由 **BM25 + e5-multilingual-large + e5-mistral-instruct** 池化而成 `[R1]`——语料本身由 mE5 家族参与构造，对 mE5 系有结构性影响。
- MTEB 后来加了 `MIRACLRetrievalHardNegatives.v2`，说明文档原文：*"V2 uses a more appropriate prompt rather than the default prompt for retrieval"* `[R1]`——官方承认 v1 的 prompt 配置影响成绩。**但 v2 在官方存档里对所有候选都只有 `ru`/`th`/`es`，没有 `zh` `[R2]`，无法用来交叉验证。**

### 1.3 协议不齐：三项的实际跑法

MTEB 官方结果存档里各模型的实际运行元数据（一手，逐文件读取）：

| 模型 | Belebele mteb / rev | MIRACL-HN mteb / rev | MLQA mteb / rev | `use_instructions` |
| --- | --- | --- | --- | --- |
| bge-m3 | 1.12.75 / `75b39939` | 1.12.75 / `95c8db7d` | 1.12.75 / `397ed406` | **False** |
| embeddinggemma-300m | 1.34.7 / `75b39939` | 1.34.7 / `95c8db7d` | 1.34.7 / `397ed406` | **True** |
| Qwen3-Embedding-0.6B | 1.38.9 / `75b39939` | 1.38.9 / `95c8db7d` | 1.38.9 / `397ed406` | **True** |
| gte-multilingual-base | 无 zh（只跑了 `nld`）| 1.12.75 / `95c8db7d` | 1.12.75 / `397ed406` | **False** |
| multilingual-e5-large | 1.38.3 / `75b39939` | 无 zh 记录 | 1.12.75 / `397ed406` | True |
| jina-embeddings-v3 | 1.18.2 / `75b39939` | 1.18.2 / `95c8db7d` | 1.18.2 / `397ed406` | True |
| multilingual-e5-small | 1.38.3 / `75b39939` | 2.1.17 / **`d7d94fa4`** | 2.1.17 / **`5bef8b6e`** | True |

来源：`[R2]`。三点：

1. **上一轮「三项都是同一个 dataset revision」这句话，对 mE5-small 那一行是错的。** 它的 MIRACL-HN 与 MLQA 跑在两个不同的 dataset revision 上，框架版本也跳到了 2.1.17。而 mE5-small 恰恰是被这两个数字（0.4837 / 0.4198）判死刑的。**结论方向仍然站得住**——Belebele zh→en 0.7963 是同 revision 下跑的，与倒数第二的 jina-v3 0.8964 差 10 个点——但「一手数据否掉了 mE5-small」这句话的证据链要重新表述。
2. **提示词不对称。** bge-m3 与 gte 是 `use_instructions=False`（裸文本进），embeddinggemma / Qwen3 / mE5 / jina 是 `True`（评测时注入各自的任务提示词）`[R2]`。这不是作弊——那是这些模型的设计用法——但它意味着**要复现 embeddinggemma 的成绩，我们的代码里必须一字不差地注入它的前缀**（见 §3.4）。
3. **MTEB 官方存档不含 per-query 分数**（每条记录只有聚合指标与 `nauc_*`）`[R2]`，因此**无法做配对显著性检验**。只能靠 query 数判断：MIRACL-HN zh 393 条上 0.0127 的差距无法判读；MLQA 5,135 条上 0.1023 的差距很难是噪声。

### 1.4 三个数字实际支撑什么（含多截断点，看清饱和）

| 模型 | Belebele zho→eng：nDCG@10 / R@1 / R@10 / R@100 | MLQA zho-eng (test)：nDCG@10 / R@1 / R@10 / R@100 |
| --- | --- | --- |
| **embeddinggemma-300m** | **0.9524** / 0.910 / 0.989 / 0.997 | **0.7063** / 0.594 / **0.820** / 0.946 |
| Qwen3-Embedding-0.6B | 0.9257 / 0.874 / 0.973 / 0.997 | 0.6506 / 0.531 / 0.776 / 0.921 |
| **gte-multilingual-base** | 无公开数据（该模型只跑了荷兰语子集）| **0.6443** / 0.516 / 0.780 / 0.928 |
| multilingual-e5-large | 0.9137 / 0.849 / 0.974 / 0.996 | 0.5973 / 0.458 / 0.750 / 0.914 |
| **BAAI/bge-m3** | 0.8980 / 0.824 / 0.969 / 0.993 | 0.6040 / 0.476 / 0.739 / 0.909 |
| jina-embeddings-v3 | 0.8964 / 0.826 / 0.962 / 0.993 | 0.6036 / 0.478 / 0.737 / 0.907 |
| multilingual-e5-small | 0.7963 / 0.666 / 0.917 / 0.991 | 0.4198 / 0.270 / 0.596 / 0.847 |

全部来自 `[R2]`。（gte 与 mE5-large 的 MLQA 是同 mteb 1.12.75 + 同 revision，与 bge-m3 **完全同协议**；embeddinggemma / Qwen3 是同 revision 但框架版本更新。）

**读法：**

- **Belebele 的 R@100 全在 0.99 以上、R@10 全在 0.92 以上** —— 488 篇语料上，「能不能找到」已经不是问题，比的是 top-10 内部的排序。RAG 里真正决定答案质量的是「喂给 LLM 的 k 块里有没有正确的那块」，也就是 **recall@k**。按 recall@10 看，Belebele 上 embeddinggemma 对 bge-m3 只领先 2 个百分点（0.989 vs 0.969）。**上一轮引用的 nDCG@10 差距 5.4 个点，在这个任务上被语料规模放大了。**
- **MLQA 上的差距是真的：recall@10 0.820 vs 0.739，8.1 个百分点**，语料 4,546 篇、5,135 条 query。这是三项里唯一既跨语言、又没被声明训练过、又有足够 query 数的数据点。
- **gte-multilingual-base 在唯一干净的那一项上排第三**（0.6443），领先 bge-m3 4 个点，落后 embeddinggemma 6 个点——而它的模型比两者都小（见 §3）。

**结论：三个数据点实际只支撑一个量级判断——「在维基百科段落级别的 zh→en 检索上，embeddinggemma-300m 大概率强于 bge-m3，幅度在 recall@10 上是个位数百分点」。** 不支撑「全面优于」，不支撑排名，也不支撑外推到学术论文语料。

---

## 2. 上一轮漏掉的维度

### 2.1 上下文长度：本用例下不是差异点（本机实测）

我们的块约 600 字符。用各模型自己的 tokenizer 实测（transformers.js `AutoTokenizer`，本机 2026-08-14）`[R20]`：

| 样本 | embeddinggemma tokenizer | bge-m3 / gte tokenizer（同为 XLM-R 250k 词表）|
| --- | --- | --- |
| 英文论文段落 616 字符 | **98 token**（6.29 字符/token）| **128 token**（4.81 字符/token）|
| 中文段落 210 字符 | **132 token**（1.59 字符/token）| **141 token**（1.49 字符/token）|

按最差情况外推：600 字符**中文**块 ≈ 400 token；600 字符**英文**块 ≈ 100–130 token。

| 模型 | 上下文上限 | 对 600 字符块够不够 |
| --- | --- | --- |
| multilingual-e5-small / large | 512 `[R2]` | 够（中文块贴边）|
| **embeddinggemma-300m** | **2048** `[R11]` | 够，余量 5× |
| bge-m3 / gte-multilingual-base / jina-v3 | 8192 `[R2]` | 够，余量 20× |
| Qwen3-Embedding-0.6B | 32768 `[R2]` | 够，余量 80× |

**别拿 8192 vs 2048 说事。** 在 600 字符块的设定下，2048 与 8192 的差别是零。更值得注意的反向事实：**EmbeddingGemma 论文自述其 MTEB 评测「大多数任务用 512 token 上下文」** `[R9]`——也就是说榜单成绩本身也没用到长上下文。真正会被 2048 卡住的场景是「整节/整页不切块直接编码」，那是另一个设计（且 ADR 没这么定）。

### 2.2 bge-m3 的 dense + sparse + ColBERT：ONNX 路线上**只有 dense**（本机实测计算图）

这是任务里最该查实的一条。答案是确定的：**拿不到**。

**实测（下载 ONNX 计算图头文件，手写 protobuf 解析器读 `graph.input` / `graph.output`）`[R20]`：**

| 文件 | 图输入 | 图输出 |
| --- | --- | --- |
| `Xenova/bge-m3` `onnx/model.onnx` | `input_ids`, `attention_mask` | **`last_hidden_state`** |
| `Xenova/bge-m3` `onnx/sentence_transformers.onnx` | `input_ids`, `attention_mask` | **`token_embeddings`, `sentence_embedding`** |
| **`BAAI/bge-m3` 官方 `onnx/model.onnx`** | `input_ids`, `attention_mask` | **`token_embeddings`, `sentence_embedding`** |

三个图里 `sparse` / `colbert` 的**字节出现次数均为 0**。原因在仓库结构里也看得到：`BAAI/bge-m3` 的稀疏头与多向量头是两个独立的 **PyTorch pickle** 文件——`sparse_linear.pt`（2 KB）、`colbert_linear.pt`（2.0 MB）`[R5]`——它们**从来没有被导出进任何 ONNX 图**。GGUF 路线同理（llama.cpp 的 embedding 只出池化后的稠密向量）。

理论上可以自己实现：`sentence_transformers.onnx` 输出了 `token_embeddings`，把 `.pt` 里的两个线性层权重转成 JSON/safetensors 再在 JS 里做矩阵乘就能复原 sparse 与 ColBERT。**但没有任何一手来源提供过这条 JS 路径**，且 ColBERT 打分要存每块 N×1024 的多向量，与 ADR-0004「不引入专门向量库」直接冲突。按「不可用」处理。

**那么「拿完整 bge-m3 的榜单成绩来比不公平」这个担心成立吗？——在我们这个任务上，基本不成立。** 用 BGE-M3 论文自己的消融数据量化代价（本次 arXiv 可达，直接读原表）：

| 任务 | Dense（= ONNX 能拿到的）| Sparse | Multi-vec | Dense+Sparse | **All（三路混合）** | **All − Dense** |
| --- | --- | --- | --- | --- | --- | --- |
| MIRACL `zh`，nDCG@10（**单语中文**）`[R4]` Table 1 | 62.7 | 36.1 | 63.7 | 63.5 | **64.9** | **+2.2** |
| MKQA `zh_cn`，Recall@100（**中文问 → 英文维基**）`[R4]` Table 2 | 74.6 | 35.4 | 74.9 | 74.7 | **75.0** | **+0.4** |
| MKQA `zh_cn`，Recall@20 `[R4]` Table 13 | 66.4 | 26.9 | 66.7 | 66.6 | **67.3** | **+0.9** |

**跨语言场景下丢掉 sparse + ColBERT 的代价不到 1 个点**（单语中文场景下是 2.2 点）。道理也直白：sparse 是词面匹配，中文 query 打英文文档时词面几乎无交集——BGE-M3 自己的 Sparse 在 MKQA zh_cn 上只有 35.4 Recall@100，比 dense 低 39 点 `[R4]`。

> **所以上一轮拿 MTEB 存档里的 bge-m3 成绩（dense-only，`SentenceTransformerEncoderWrapper` `[R2]`）去和 embeddinggemma 比，对 zh→en 这个任务是公平的**——而且这恰好也是我们真正会部署的形态。这一条我原本预期会推翻上一轮，结果是证实了它，代价数字写在上面，可复查。

### 2.3 维度与 Matryoshka

| 模型 | 维度 | Matryoshka / 弹性维度 | 一手出处 |
| --- | --- | --- | --- |
| **embeddinggemma-300m** | 768 | ✅ **512 / 256 / 128**（MRL 训练）| 论文 §「EmbeddingGemma provides d=768 dimensional embeddings, additionally supporting 512, 256, and 128 dimensional embeddings via MRL」`[R9]`；模型卡同 `[R11]` |
| Qwen3-Embedding-0.6B | 1024 | ✅ **32–1024** 任意 | 模型卡 `MRL Support: Yes` `[R14]` |
| jina-embeddings-v3 | 1024 | ✅ 32/64/128/256/512/768/1024 | 模型卡 `[R15]` |
| gte-multilingual-base | 768 | ✅ **128–768**（"Elastic Dense Embedding"，CLS 向量直接截断）| 模型卡 `dimension=768 # should be in [128, 768]` `[R16]` |
| **BAAI/bge-m3** | 1024 | ❌ **无** | 模型卡未提；论文未提 `[R4][R5]` |
| multilingual-e5-large / small | 1024 / 384 | ❌ 无 | `[R2]` |

**为什么这条重要：** 上一轮实测过 sqlite-vec 的落盘体积——1024 维 40.3 MB/万条、768 维 30.3 MB/万条、384 维 15.3 MB/万条，KNN 延迟 8.4 / 6.3 / 3.3 ms。**bge-m3 是唯一一个不能降维的候选**，它把我们锁死在 1024 维那一档。

降维要付多少质量代价，只有 embeddinggemma 有一手数据（EmbeddingGemma 论文 Table 6，MTEB Multilingual v2）`[R9]`：

| 维度 | Mean(Task) | **Retrieval** | 相对 768 维的检索损失 |
| --- | --- | --- | --- |
| 768 | 61.2 | **62.5** | — |
| 512 | 60.7 | **61.5** | −1.0 |
| 256 | 59.7 | **58.8** | −3.7 |
| 128 | 58.2 | **55.3** | −7.2 |

**512 维几乎免费（−1.0）**，256 维开始明显掉。其他候选的 MRL 掉分曲线——**无公开数据**。

### 2.4 量化：上一轮的「无公开数据」要修正，但修正后的结论对我们更不利

**(a) `q4f16` 与 `fp16` 对 embeddinggemma 是不可用的。** 官方 ONNX 仓库 README 原文：*"**NOTE**: EmbeddingGemma activations do not support `fp16` or its derivatives. Please use `fp32`, `q8`, or `q4` as appropriate for your hardware."* `[R11]`。上一轮把 **q4f16 167.3 MB** 列为最小档、并写进备选路线，**该数字作废**；`model_fp16` 588.8 MB 同样作废。

**(b) EmbeddingGemma 有量化质量的一手数据，但它不适用于我们会下载的那个文件。** 论文 Table 1（MTEB Multilingual v2）`[R9]`：

| 权重精度 | Mean(Task) | Mean(Type) |
| --- | --- | --- |
| bf16（原始）| **61.15** | 54.31 |
| int8（per-block QAT）| 60.93 | 53.95 |
| Mixed（per-channel QAT）| 60.69 | 53.82 |
| **int4（per-block QAT）** | **60.62** | 53.61 |

int4 只掉 0.53 —— 但论文明说这些是 **quantization-aware training** 产出的 checkpoint `[R9]`，对应 HF 上的 `google/embeddinggemma-300m-qat-q4_0-unquantized` / `-qat-q8_0-unquantized` 两个独立仓库 `[R17]`。而我们要用的 `onnx-community/embeddinggemma-300m-ONNX` 的 `base_model` 是 `google/embeddinggemma-300m`（非 QAT），仓库里也没有 `quantize_config.json` `[R11][R12]`——它是**事后动态量化**。**那个 187.6 MB 文件的检索质量，仍然是「无公开数据」。**

> 可行的改进（我的分析）：如果 eval 显示 ONNX q4 掉太多，可以自己用 Optimum 把 `google/embeddinggemma-300m-qat-q4_0-unquantized` 导成 ONNX，拿到论文 Table 1 那条曲线上的质量。

**(c) 其他所有候选的量化质量：无公开数据。** `Xenova/*` 与 `onnx-community/*` 都没发布量化前后对比；MTEB 存档里的成绩全部基于原始权重 `[R2]`。

### 2.5 ONNX 实际最小可用体积（HF Hub API 实测字节）

| 模型 | ONNX 仓库 | **最小可用档** | 次小 | 坑 |
| --- | --- | --- | --- | --- |
| **embeddinggemma-300m** | `onnx-community/embeddinggemma-300m-ONNX` | **q4 187.6 MB** | q8 294.6 MB | fp16/q4f16 **不可用** `[R11]` |
| **gte-multilingual-base** | `onnx-community/gte-multilingual-base` | **int8 324.6 MB** | q4f16 443.7 MB | `q4` = 832.9 MB，**比 fp16 还大** |
| **BAAI/bge-m3** | `Xenova/bge-m3` | **int8 542.1 MB** | q4f16 667.5 MB | `q4` = 1190.4 MB，比 fp16 还大 |
| Qwen3-Embedding-0.6B | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | **q8 585.1 MB** | q4f16 541.2 MB（README 未列）| README 只推荐 fp32/fp16/q8 `[R18]` |
| jina-embeddings-v3 | `jinaai/jina-embeddings-v3` `onnx/` | **fp16 1094.0 MB** | fp32 2185.2 MB | **没有 int8/q4**；图输入含 `task_id`（见 §3.4）|
| multilingual-e5-large | `Xenova/multilingual-e5-large` | int8 535.7 MB | — | 上下文 512 |

来源 `[R12][R13][R15][R18][R19]`，均为 Hub API `?blobs=true` 的实测字节数。

**bge-m3 与 gte 的 `q4` 都比 fp16 大**——同一个病因：XLM-R 的 25 万词表 embedding 矩阵不被 4-bit 量化、还额外引入量化元数据。**embeddinggemma 没有这个问题**（其 `n_embedding_parameters = 201,326,592`，占 308M 参数的 65% `[R7]`，但 q4 导出把它量化掉了：1177.3 MB → 187.6 MB，压缩比 6.3×）。仓库里还有一个 `model_no_gather_q4`（185.6 MB）`[R12]`，用途未文档化——**无公开数据**。

### 2.6 内存与编码延迟

**本机实测（Node v24.18.0 / macOS arm64 / 2026-08-14，transformers.js 4.2.0，CPU EP）`[R20]`：**

两个候选都实测了。测试文本：中文 query 210 字符、英文 passage 616 字符（同 §2.1 的样本）；embeddinggemma 按官方要求加了 `task: search result | query: ` / `title: none | text: ` 前缀，gte 按官方 CLS 池化、不加前缀。每项取 5 次中位数。

| 指标 | **embeddinggemma-300m** `dtype:'q4'`（187.6 MB）| **gte-multilingual-base** `dtype:'q8'`（324.6 MB）|
| --- | --- | --- |
| COLD 加载（含下载）| 710.0 s | 1186.1 s |
| **WARM 加载（已缓存）** | **1.1 s** | **0.6 s** |
| 磁盘缓存总量 | 213 MB | 352 MB |
| **编码 1 条中文 query** | 11.9 ms | **7.2 ms** |
| **编码 1 条英文 passage** | 27.8 ms | **17.6 ms** |
| **编码 16 条英文 passage（batch）** | 355.5 ms（≈22 ms/条）| **245.6 ms（≈15 ms/条）** |
| **加载后 RSS** | **455 MB** | 892 MB |
| **编码后 RSS** | **482 MB** | 916 MB |
| 输出维度 | 1×768 | 1×768 |

（COLD/WARM 两次运行的编码延迟差异均在 ±2 ms 内，故只列一组；WARM 运行的 RSS 略高，530→570 MB / 1010→1093 MB。）

**怎么读：**

- **COLD 的十几分钟是带宽，不是模型慢**：187.6 MB / 710 s ≈ 264 KB/s、324.6 MB / 1186 s ≈ 274 KB/s，本沙箱下行被限速。用户侧首次加载 = 模型体积 ÷ 用户带宽 + **不到 1.1 秒的初始化**。日常路径上的真实成本是 WARM 的 **0.6–1.1 秒**。
- **两个候选的取舍是反的，而且上一轮完全没看到这一层：gte 编码快 1.4–1.6 倍，但常驻内存是 embeddinggemma 的 1.9 倍。** gte 的模型文件大 1.7 倍（324.6 vs 187.6 MB），RSS 也跟着涨（892 vs 455 MB）——**「模型文件小 1.7 倍」在磁盘上是真的，在内存上也是真的，但在编码速度上是反的**（两边的 `config.json` 解释了原因：embeddinggemma 是 `Gemma3TextModel`、**24 层** / hidden 768 / intermediate 1152 / vocab 262,144 `[R12]`；gte 是 **12 层** / hidden 768 / intermediate 3072 / vocab 250,048 `[R16]`——**gemma 的层数是 gte 的两倍，算力压过了权重体积**；反过来 gte 的 25 万词表 embedding 矩阵在 int8 下没被压掉，撑大了文件与内存）。
- **batch 几乎不摊薄单条成本**（embeddinggemma 22 vs 26 ms/条、gte 15 vs 17 ms/条）——CPU EP 上算力已经吃满，批处理只省调度。**一篇 30 页论文切 300 块的全量编码 ≈ 6.6 秒（gemma）/ 4.6 秒（gte）**，这是我按 batch 单条成本外推的，非实测。
- **RSS 是模型文件的 2.4–2.8 倍。** 对照上一轮跑 112.8 MB 的 mE5-small 时 RSS 683–742 MB——**ONNX Runtime 自身有几百 MB 的固定开销**。这一条对「手机端能不能扛」很关键：省 350 MB 模型文件，省不下同量级的内存。

**bge-m3 int8（542.1 MB）与 Qwen3-Embedding-0.6B（585.1 MB）本轮未实测**（按实测下行 264–274 KB/s，各需约 35 分钟，超出本轮预算）→ **无一手数据**。

可参考的间接一手量：MTEB 模型元数据里的 `memory_usage_mb`（= 原始权重占用，**不是**运行时 RSS）`[R2]`：bge-m3 **2167**、mE5-large 2136、embeddinggemma **1155**、Qwen3-0.6B 1136、jina-v3 1092、gte-multilingual-base **582**、mE5-small 449。

上一轮的实测锚点仍然有效：mE5-small（118M 参数 / q8 112.8 MB）在同一台机器上，WARM 启动 0.43 s、单条编码 3–6 ms、16 条 batch 50 ms、进程 RSS 683–742 MB。**注意那 700 MB RSS 是跑 112.8 MB 模型时的量——ONNX Runtime 自身开销占大头。**

---

## 3. 第三、第四候选：交叉验证

### 3.1 候选全表

| | **embeddinggemma-300m** | **gte-multilingual-base** | **Qwen3-Embedding-0.6B** | BAAI/bge-m3 | jina-embeddings-v3 |
| --- | --- | --- | --- | --- | --- |
| 参数量 | 307.6 M `[R7]` | 305.4 M `[R13]` | 595.8 M `[R2]` | 568 M `[R2]` | 572 M `[R2]` |
| 维度 / MRL | 768 / **512·256·128** | 768 / **128–768** | 1024 / **32–1024** | 1024 / **无** | 1024 / 32–1024 |
| 上下文 | 2048 | 8192 | 32768 | 8192 | 8192 |
| 池化 / 用法 | mean + 两层 Dense 投影（已融合进 ONNX 图），**必须加任务前缀** | **CLS**（`pooling_mode_cls_token: true` `[R16]`），无前缀 | **last_token**，query 侧加 Instruct | **CLS**（`pooling_mode_cls_token: true` `[R5]`），无前缀 | mean，需 `task_id` |
| 许可 | `gemma`（`google/` 仓库 `gated: manual`；`onnx-community/` 镜像 `gated: false`）`[R11][R12]` | **Apache-2.0** `[R16]` | **Apache-2.0** `[R14]` | **MIT** `[R5]` | CC-BY-NC-4.0 `[R15]` |
| ONNX 最小可用 | **187.6 MB** | **324.6 MB** | 585.1 MB | 542.1 MB | 1094.0 MB |
| transformers.js | ✅ 官方仓库带 JS 示例 `[R11]` | ⚠️ 有 `onnx-community` 转换，但 **README 用法有误 + 架构未被 transformers.js 4.2.0 正式支持（回退路径），见 §3.4** `[R19][R20]` | ✅ 官方 JS 示例 `[R18]` | ✅ `Xenova/bge-m3` | ⚠️ **无 transformers.js 仓库**，ONNX 需额外 `task_id` 输入 `[R15]` |
| 权重最近更新 | 2025-09-25（ONNX 2025-09-04）| 2025-07-05（ONNX 转换 **2024-10-08**）| **2026-04-20**（ONNX 2026-04-03）| **2024-07-03**（约两年未更新）| 2026-04-08 |
| MLQA zho-eng nDCG@10 | **0.7063** | 0.6443 | 0.6506 | 0.6040 | 0.6036 |
| Belebele zho→eng nDCG@10 | **0.9524** | 无公开数据 | 0.9257 | 0.8980 | 0.8964 |

日期与 gated 状态来自 HF Hub API 实测 `[R11]–[R19]`；成绩来自 `[R2]`。

**关于 bge-m3 的维护：BAAI 已经约两年没有更新 bge-m3，也没有发布同量级的多语言继任者**（`bge-multilingual-gemma2` 是 9B 级，不在本讨论范围）`[R19]`。这不是致命问题（模型权重是静态资产），但对一个要长期维护的打包应用是一个真实的信号。

### 3.2 交叉验证：MKQA（真正的 zh→en，英文维基语料）

MTEB 存档之外，还有一个和我们任务形态完全对齐的公开基准：**MKQA cross-lingual —— 中文 query 检索英文维基百科段落**。两篇论文都报了它。

**MKQA `zh_cn`，Recall@100**（BGE-M3 论文 Table 2 `[R4]`）：

| BM25 | mDPR | mContriever | **mE5-large** | E5-mistral-7b | OpenAI-3-large | **M3 Dense** | M3 Sparse | M3 Multi-vec | M3 All |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 31.0 | 63.7 | 68.1 | **56.6** | 69.3 | 70.7 | **74.6** | 35.4 | 74.9 | **75.0** |

**MKQA `zh_cn`，Recall@20**（BGE-M3 论文 Table 13 `[R4]` 与 mGTE 论文 Table 19 `[R10]`）：

| | M3 Dense | M3 All | **mGTE Dense（= gte-multilingual-base）** | mGTE D+S |
| --- | --- | --- | --- | --- |
| Recall@20 | 66.4 | 67.3 | **68.2** | 68.4 |

**三件事：**

1. **gte-multilingual-base 的 dense 单路（68.2）在 zh→en 上赢过 bge-m3 的三路全功能混合（67.3）** `[R10]`。这与 MLQA 上的排序一致（gte 0.6443 > bge-m3 0.6040），两个独立来源互相印证。
2. **诚实标注：这不是受控 head-to-head。** 我逐位比对过——mGTE 论文 Table 19 里的 M3 各列与 BGE-M3 论文 Table 13 **完全相同**，说明 Alibaba 是**照抄** BGE-M3 的公开数字，不是重跑。两篇论文都声明用 BEIR 提供的英文维基语料，但预处理细节无法核对。当作跨论文对照，不当作判决。
3. **embeddinggemma 在 MKQA 上无公开数据。** 更要紧的是——**EmbeddingGemma 论文的跨语言证据里没有中文**：它报的是 XOR-Retrieve（84.14）与 XTREME-UP（47.72）`[R9]`，而 XOR-TyDi 的 7 种语言是 **Arabic, Bengali, Finnish, Japanese, Korean, Russian, Telugu**（论文原文列举 `[R21]`）——**没有中文**；XTREME-UP 按 gemma 论文自述是「20 种代表性不足的印欧语言」`[R9]`，也没有中文。**embeddinggemma 的中文跨语言能力，除了 MTEB 存档那两个数字之外，没有第一方证据。**

### 3.3 一个反向证据：Google 自己的论文里，Qwen3-0.6B 更强

EmbeddingGemma 论文 Table 5（MTEB Multilingual v2，同一张表、同一次评测）`[R9]`：

| | **EmbeddingGemma** | GTE Multilingual Base | mE5 Large Instruct | **BGE-M3** | Jina v3 | **Qwen3 Emb 0.6B** |
| --- | --- | --- | --- | --- | --- | --- |
| 参数量 | 308M | 305M | 560M | 568M | 572M | 595M |
| Mean(Task) | 61.15 | 58.24 | 63.22 | 59.56 | 58.37 | **64.34** |
| **Retrieval** | 62.49 | 56.50 | 57.12 | 54.60 | 55.76 | **64.65** |

**Google 自己的论文承认 Qwen3-Embedding-0.6B 在多语言检索上比 EmbeddingGemma 高 2.2 个点。** EmbeddingGemma 的「SOTA」限定词是「**under 500M parameters**」`[R9]`——Qwen3-0.6B 是 595M，不在那个区间里。上一轮把 embeddinggemma 写成「更小且更好」时，没有区分「同尺寸最好」和「绝对最好」。**Qwen3-Embedding-0.6B 的代价是 585 MB（比 bge-m3 的 542 MB 还大），这才是它出局的真实理由，不是质量。**

（注意这张表与 MLQA 的排序矛盾：MLQA zho-eng 上 embeddinggemma 0.7063 > Qwen3 0.6506，但 MTEB Multilingual 整体 Retrieval 上 Qwen3 反超。前者是单一 zh→en 任务，后者是 100+ 任务聚合。**这个矛盾正是我把置信度定为「中等偏低」的原因。**）

### 3.4 落地陷阱：四个会让榜单成绩跑不出来的坑

1. **embeddinggemma 必须注入任务前缀。** 官方 ONNX README 原文 `[R11]`：
   ```js
   const prefixes = { query: "task: search result | query: ", document: "title: none | text: " };
   ```
   它的 MTEB 成绩是在 `use_instructions=True` 下跑的 `[R2]`。**如果我们的 `encode()` 对 query 和 passage 用同一条路径、不加前缀，§1.4 那张表的成绩就不成立。** 掉多少——无公开数据，必须自己测（这是 §5 的推翻条件 3）。
2. **gte-multilingual-base 用 CLS 池化，且 `onnx-community` 的 README 是错的。** 官方 `1_Pooling/config.json` 是 `pooling_mode_cls_token: true` `[R16]`，模型卡示例用 `outputs.last_hidden_state[:, 0]`，且 MTEB 元数据 `use_instructions=False` `[R13]`。但 `onnx-community/gte-multilingual-base` 的 README 示例写的是 `{ pooling: 'mean' }` **并且**加了一句 bge 风格的前缀 `'Represent this sentence for searching relevant passages: '` `[R19]`——**两处都与官方用法矛盾**。照抄这个 README 会得到一个和榜单成绩无关的模型。
   **另外，本机实测：transformers.js 4.2.0 不认识这个架构**，加载时打印 `[resolve_model_type] Architecture(s) not found in MODEL_TYPE_MAPPING: [NewModel, NewForTokenClassification] for model type 'new'. Falling back to EncoderOnly` + `Unknown model class "new", attempting to construct from base class` `[R20]`。它**能跑**（回退到通用 EncoderOnly 路径），但这是一条未受官方支持的路径，将来 transformers.js 升级时没有兼容性承诺。相比之下 embeddinggemma 与 Qwen3 的 ONNX 仓库都由 `onnx-community` 官方维护并带 JS 示例。
3. **embeddinggemma 的 Dense 投影已经融合进 ONNX 图，不用额外处理。** `google/embeddinggemma-300m` 的 sentence-transformers 结构里有 `2_Dense` / `3_Dense` 两层（各 9 MB）`[R12]`，但 `onnx-community` 的导出图直接输出 `sentence_embedding`（图内可见 3072 维中间层痕迹）`[R20]`——用 `model(inputs).sentence_embedding` 就是最终向量，与参考实现对齐。（注：`google/` 仓库是 `gated: manual`，`modules.json` / `1_Pooling/config.json` 在未认证时读不到，池化方式的直接确认只能靠论文 Table 3「mean pooling 最优」`[R9]` 与 ONNX 图 IO。）
4. **jina-embeddings-v3 在 transformers.js 上基本不可用。** 其 ONNX 图输入是 `['input_ids', 'attention_mask', 'task_id']`（本机实测 `[R20]`，图里 `lora` 字样出现 396 次）——五个任务 LoRA 靠 `task_id` 选。transformers.js 的 `feature-extraction` pipeline 只喂前两个输入；HF 上也没有任何 `library_name: transformers.js` 的 jina-v3 仓库 `[R15]`。加上没有 int8/q4（最小 fp16 1094 MB），**这个候选出局**。

---

## 4. 复核后的排序

| 排名 | 候选 | 最小可用体积 | 支持它的一手证据 | 反对它的一手证据 |
| --- | --- | --- | --- | --- |
| **1** | **embeddinggemma-300m**（ONNX q8 294.6 MB / q4 187.6 MB）| **187.6 MB** | MLQA zho-eng 0.7063（唯一干净数据点上第一）；Belebele zh→en 0.9524；MRL 512 维几乎免费；QAT 量化曲线已知；**实测 RSS 455–570 MB，比 gte 低 1.9 倍**（§2.6）| 中文跨语言无第一方证据（XOR/XTREME-UP 均无中文）；MTEB Multilingual Retrieval 整体输给 Qwen3；**那个 187.6 MB 文件不是 QAT 产物，质量无公开数据**；强依赖任务前缀 |
| **2** | **gte-multilingual-base** | **324.6 MB** | MKQA zh_cn Recall@20 68.2，**赢过 bge-m3 三路混合**；MLQA 0.6443 在**与 bge-m3 完全同协议**下领先 4 点；Apache-2.0；8192 上下文；CLS 池化**无 prompt 依赖**（工程上最稳）；权重最小（582 MB fp32）；**实测编码快 1.4–1.6 倍**（§2.6）| Belebele zh→en 无公开数据；ONNX 转换 2024-10-08 后未更新；社区 README 用法错误；**实测 RSS 892–1093 MB，接近 embeddinggemma 的两倍**；**架构 `NewModel` 未进 transformers.js 4.2.0 的 `MODEL_TYPE_MAPPING`，走回退路径（实测能跑，但无兼容性承诺）** |
| **3** | BAAI/bge-m3 | 542.1 MB | MIT；MKQA zh_cn Dense 74.6 R@100 是硬数据；ADR-0003 现状 | 两项跨语言指标上都在中下游（Belebele 第 5/7、MLQA 第 4/7，见 §1.4）；ONNX 拿不到 sparse/ColBERT（zh→en 代价 <1 点，但确实拿不到）；**无 MRL，锁死 1024 维**；两年未更新 |
| 4 | Qwen3-Embedding-0.6B | 585.1 MB | Google 论文里 MTEB Multilingual Retrieval 第一（64.65）；Apache-2.0；MRL 32–1024；维护最活跃 | 体积比 bge-m3 还大，与 local-first 目标冲突；MLQA 落后 embeddinggemma 5.6 点 |
| — | jina-embeddings-v3 | 1094.0 MB | — | 无 int8/q4；transformers.js 不可用（`task_id`）；成绩与 bge-m3 持平 |
| — | multilingual-e5-small | 112.8 MB | 体积最小 | MLQA zho-eng 0.4198、MKQA zh_cn 上 mE5-large 也只有 56.6 R@100——**mE5 家族在 zh→en 上确实弱**，这一条上一轮的方向是对的 |

---

## 5. 可证伪的判断

### 5.1 判断

> **在「中文问题 → 英文学术论文段落」上，`embeddinggemma-300m`（先用 ONNX **q8 294.6 MB**，不是 q4）最可能给出最高的 recall@k；`gte-multilingual-base`（int8 324.6 MB）差距在 3 个百分点以内；`bge-m3` int8（542.1 MB）在质量和体积上都不占优，ADR-0003 应当被 eval 结果重新审视。**

**为什么默认档从 q4 改成 q8：** q4 那 187.6 MB 是事后动态量化、质量无公开数据；q8 294.6 MB 只多 107 MB，而 EmbeddingGemma 论文里 int8 相对 bf16 只掉 0.22（QAT 条件下）`[R9]`。**先用 q8 建立基线，再用 eval 决定能不能降到 q4** ——反过来做会分不清「模型不行」和「量化不行」。

**置信度：中等偏低。** 干净的证据只有 MLQA 一个数据点，而 MLQA 的语料是维基百科段落——句式规整、实体密集、长度均匀。我们的语料是 PDF 抽出来的论文块——有断行噪声、公式残片、双栏错序、术语密度极高。**这两种分布的差距，可能比模型之间的差距还大。**

### 5.2 什么结果会推翻或削弱这个判断

写成 `pdfstudio/eval/retrieval/` 可以直接判定的形式：

| # | 观察到的结果 | 结论 |
| --- | --- | --- |
| **1** | embeddinggemma q8 的 **recall@k 不比 bge-m3 int8 高出 ≥3 个百分点**（k = 实际喂给 LLM 的块数）| **判断被削弱**为「二者无实质差别」。此时按体积和 MRL 选，仍选 embeddinggemma，但**理由从质量换成体积**，ADR 的措辞要跟着改 |
| **2** | **不加** `task: search result \| query: ` / `title: none \| text: ` 前缀时，embeddinggemma 掉到 bge-m3 之下 | **判断被推翻**：榜单差距主要来自 prompt 而非模型。若我们的 `encode()` 不能可靠区分 query/passage 两条路径，改选 **gte-multilingual-base**（CLS、无 prompt 依赖）|
| **3** | ONNX **q4 相对 q8 的 recall@k 掉 >2 个点** | 187.6 MB 那一档作废，默认停在 q8 294.6 MB；若仍想要 187 MB，改走「自行导出 `google/embeddinggemma-300m-qat-q4_0-unquantized`」这条路 `[R17]` |
| **4** | **gte-multilingual-base 追平或超过 embeddinggemma** | 切 gte。有先验支持（MKQA Recall@20 上 gte dense 68.2 > bge-m3 All 67.3 `[R10]`），且 Apache-2.0 + 8192 上下文 + 无 prompt 依赖，工程上更省心 |
| **5** | 三个候选的 recall@k **都在 ±2 点以内**，但 FTS5 侧 hybrid 后差距进一步收敛到 ±1 点 | **整条比较失去决策价值**。改按体积选最小可用档（embeddinggemma q4 187.6 MB），把精力转到分块策略与 hybrid 权重上——那才是主导因素 |
| **6** | Qwen3-Embedding-0.6B 领先 ≥3 个点，且 585 MB 被判定可接受 | 切 Qwen3。EmbeddingGemma 论文 Table 5 自己支持这个方向 `[R9]` |
| **7** | 中文 query 里高频出现英文术语/作者名/公式符号，且这些 query 在 FTS5 侧已被 trigram 兜住 | 向量侧的模型差距被 hybrid 抹平 → 回到 #5 |
| **8** | 首次建索引的耗时成为体验瓶颈（实测外推：300 块 ≈ 6.6 s（gemma）/ 4.6 s（gte），§2.6）| 在质量差距 <2 点时改按编码吞吐选 → **gte**；但要先确认 892 MB RSS 在目标机器上可接受 |

### 5.3 这个 eval 必须满足的五个条件（否则上面判不了）

1. **query 数 ≥ 150–200。** 参照：MIRACL-HN zh 只有 393 条，就已经让 0.0127 的差距无法判读；MTEB 存档还不给 per-query 分数 `[R2]`。**我们自己的 eval 要保留 per-query 结果**，才能做配对检验（paired bootstrap / t-test），这是 MTEB 给不了而我们能给的东西。
2. **主指标用 recall@k，不用 nDCG@10。** k 取实际喂给 LLM 的块数。§1.4 已经展示了 nDCG@10 和 recall@10 会讲出不同强度的故事（Belebele 上 nDCG 差 5.4 点、recall@10 只差 2.0 点）。
3. **语料规模要接近真实规模**（几十篇论文 ≈ 上万块）。**不要在几百块的语料上比**——Belebele 488 篇的教训就在 §1.4。
4. **每个模型跑四种配置的笛卡尔积**：{带官方前缀 / 不带} × {最小量化档 / int8 或 fp32}。这四格正好对应推翻条件 #2 和 #3。**这是本轮所有「无公开数据」的缺口里，唯一能靠我们自己补上的。**
5. **同时记录 RSS 与编码吞吐**（§2.6 已给出 embeddinggemma 与 gte 的实测基线，bge-m3 / Qwen3 待补），对应推翻条件 #8。

### 5.4 对 ADR 的影响（本文不替它做决定）

- **ADR-0003 的理由句「唯一有第一方多语言/中文证据」已被证伪**：gte-multilingual-base 有 mGTE 论文的 MKQA zh_cn 第一方数据 `[R10]`，Qwen3-Embedding 有 Apache-2.0 与第一方多语言评测 `[R14]`。ADR-0003 是否更换默认模型，应当由 §5.2 的 eval 结果决定，**不应当由本文决定**。
- ADR-0004（FTS5 + trigram，不引入专门向量库）**不受影响**——本文所有候选走的都是单路 dense，与之相容；反倒是 bge-m3 的 ColBERT 多向量若要用，会与 ADR-0004 冲突，而 §2.2 已证明 ONNX 路线上根本拿不到。

---

## 6. 本文明确没有回答的问题

1. **embeddinggemma / gte / bge-m3 在真实论文块上的 recall@k** —— 这正是 eval 要做的事。
2. **除 embeddinggemma 之外，所有候选的量化质量损失** —— 无公开数据。
3. **gte-multilingual-base 的 Belebele zh→en** —— MTEB 官方存档里该模型只跑了荷兰语子集 `[R2]`，无公开数据。
4. **embeddinggemma 的 MKQA / 任何中文跨语言第一方数据** —— 无公开数据（XOR-Retrieve 与 XTREME-UP 都不含中文 `[R9][R21]`）。
5. **bge-m3 int8 与 Qwen3-Embedding-0.6B 在本机的编码延迟与 RSS** —— 本轮带宽不足（实测 264–274 KB/s，各需约 35 分钟），未实测。embeddinggemma q4 与 gte int8 已实测，见 §2.6。
6. **`model_no_gather_q4`（185.6 MB）与 `model_q4`（187.6 MB）的区别** —— 仓库无文档，无公开数据。
7. **MIRACL-HN `.v2`（带正确 prompt）下的 zh 排序** —— 官方存档里 v2 对所有候选都只有 `ru`/`th`/`es`，无 `zh` `[R2]`。

---

## Sources

- `[R1]` MTEB 任务定义源码（任务形态、语言方向、split、hard-negative 构造方式、v2 的 prompt 说明）：
  `https://raw.githubusercontent.com/embeddings-benchmark/mteb/main/mteb/tasks/retrieval/multilingual/belebele_retrieval.py`（`_EVAL_SPLIT="test"`；语料按 `row["link"]` 去重；注释 `# number of languages * 900`）；
  `.../miracl_retrieval.py`（`_LANGUAGES = {"zh": ["zho-Hans"]}` **单语**；HardNegatives 描述原文 *"pooling the 250 top documents per query from BM25, e5-multilingual-large and e5-mistral-instruct"*；`.v2` 描述 *"V2 uses a more appropriate prompt rather than the default prompt for retrieval"*）；
  `.../mlqa_retrieval.py`（`"mlqa.zh.en": ["zho-Hans", "eng-Latn"]`；`main_score="ndcg_at_10"`）
- `[R2]` MTEB 官方结果存档 `embeddings-benchmark/results`，逐任务 JSON（本文所有 nDCG@10 / recall@k、`mteb_version`、`dataset_revision`、`evaluation_time`，以及 `model_meta.json` 里的 `n_parameters` / `embed_dim` / `max_tokens` / `license` / `use_instructions` / `memory_usage_mb` / `model_prompts`）：`https://github.com/embeddings-benchmark/results`，例如 `https://raw.githubusercontent.com/embeddings-benchmark/results/main/results/BAAI__bge-m3/5617a9f61b028005a4858fdac845db406aefb181/MLQARetrieval.json`。已核验记录中**不含 per-query 分数**。
- `[R3]` MTEB 官方 `descriptive_stats`（各子集 `num_samples` / `num_queries` / `num_documents`）：`https://raw.githubusercontent.com/embeddings-benchmark/mteb/main/mteb/descriptive_stats/Retrieval/{BelebeleRetrieval,MLQARetrieval,MIRACLRetrievalHardNegatives,MIRACLRetrieval}.json`
- `[R4]` BGE-M3 论文（arXiv 2402.03216v4，**本次可达**）：Table 1 MIRACL nDCG@10（zh：Dense 62.7 / Sparse 36.1 / Multi-vec 63.7 / D+S 63.5 / All 64.9）；Table 2 MKQA Recall@100（zh_cn：M3 Dense 74.6 / Sparse 35.4 / Multi-vec 74.9 / All 75.0；mE5-large 56.6）；Table 13 MKQA Recall@20（zh_cn：Dense 66.4 / All 67.3）；训练数据原文 *"For other languages, we leverage the training data from Mr. Tydi and MIRACL"*：`https://arxiv.org/html/2402.03216v4`
- `[R5]` HuggingFace Hub API — `BAAI/bge-m3`（`sparse_linear.pt` 2 KB、`colbert_linear.pt` 2.0 MB 为 **PyTorch 文件**；`onnx/model.onnx` + `onnx/model.onnx_data`；`license:mit`、`gated:false`、`lastModified 2024-07-03`）：`https://huggingface.co/api/models/BAAI/bge-m3?blobs=true`
- `[R6]` MTEB 模型注册表 `bge_models.py`（`bge_m3_training_data` 含 `MIRACLRetrieval` / `MIRACLRetrievalHardNegatives` / `MIRACLReranking`）：`https://raw.githubusercontent.com/embeddings-benchmark/mteb/main/mteb/models/model_implementations/bge_models.py`
- `[R7]` MTEB `google_embeddinggemma.py`（`n_parameters=307_581_696`、`n_embedding_parameters=201_326_592`、`embed_dim=768`、`max_tokens=2048`、`use_instructions=True`、`training_datasets=GECKO_TRAINING_DATA`）与 `google_text_embedding.py`（`GECKO_TRAINING_DATA = {"NQHardNegatives","FEVERHardNegatives","HotpotQAHardNegatives","MIRACLRetrievalHardNegatives"}`）：`https://raw.githubusercontent.com/embeddings-benchmark/mteb/main/mteb/models/model_implementations/google_embeddinggemma.py` / `.../google_text_embedding.py`
- `[R8]` MTEB `qwen3_models.py`（`training_data` 含 `MIRACLRetrieval`；`q3e_instruct_loader` + `apply_instruction_to_passages=False`）：`https://raw.githubusercontent.com/embeddings-benchmark/mteb/main/mteb/models/model_implementations/qwen3_models.py`
- `[R9]` EmbeddingGemma 论文（arXiv 2509.20354v1）：MRL 原文 *"EmbeddingGemma provides d=768 dimensional embeddings, additionally supporting 512, 256, and 128 dimensional embeddings via MRL"*；Table 1 量化（bf16 61.15 / int8 60.93 / Mixed 60.69 / int4 60.62，均为 **QAT** checkpoint）；Table 5 跨模型对比（Retrieval：gemma 62.49 / gte 56.50 / mE5-large-inst 57.12 / bge-m3 54.60 / jina-v3 55.76 / **Qwen3-0.6B 64.65**；XOR-Retrieve 84.14；XTREME-UP 47.72）；Table 6 MRL 掉分（768/512/256/128 → Retrieval 62.5/61.5/58.8/55.3）；评测上下文原文 *"We use a context length of 512 tokens for most evaluation tasks"*：`https://arxiv.org/html/2509.20354v1`
- `[R10]` mGTE 论文（arXiv 2407.19669v1）Table 19 MKQA Recall@20（zh_cn：mGTE Dense **68.2** / D+S 68.4；M3 各列与 `[R4]` Table 13 **逐位相同**，系照抄非重跑）：`https://arxiv.org/html/2407.19669v1`
- `[R11]` `onnx-community/embeddinggemma-300m-ONNX` README（*"EmbeddingGemma activations do not support `fp16` or its derivatives. Please use `fp32`, `q8`, or `q4`"*；前缀 `task: search result | query: ` / `title: none | text: `；`base_model: google/embeddinggemma-300m`；上下文 2048；MRL 768/512/256/128）：`https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/raw/main/README.md`
- `[R12]` HuggingFace Hub API + `config.json` — `onnx-community/embeddinggemma-300m-ONNX`（fp32 1177.3 MB、fp16 588.8 MB、quantized 294.6 MB、q4 **187.6 MB**、q4f16 167.3 MB、no_gather_q4 185.6 MB；`gated:false`、`license:gemma`、`lastModified 2025-09-04`；**无 `quantize_config.json`**；`config.json`：`architectures: ["Gemma3TextModel"]`、`num_hidden_layers: 24`、`hidden_size: 768`、`intermediate_size: 1152`、`vocab_size: 262144`、`max_position_embeddings: 2048`、`use_bidirectional_attention: true`、`sliding_window: 512`）与 `google/embeddinggemma-300m`（`gated: manual`、含 `2_Dense`/`3_Dense`）：`https://huggingface.co/api/models/onnx-community/embeddinggemma-300m-ONNX?blobs=true`、`https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX/raw/main/config.json`
- `[R13]` MTEB `gte_models.py`（`gte_multi_training_data` 含 `MIRACLRetrieval` / `MIRACLRetrievalHardNegatives`，注释 `# https://arxiv.org/pdf/2407.19669, Table 11`；`n_parameters=305_368_320`、`memory_usage_mb=582`、`embed_dim=768`、`max_tokens=8192`、`license=apache-2.0`、`use_instructions=False`）：`https://raw.githubusercontent.com/embeddings-benchmark/mteb/main/mteb/models/model_implementations/gte_models.py`
- `[R14]` `Qwen/Qwen3-Embedding-0.6B` 模型卡（`license: apache-2.0`；Context 32K；Embedding Dimension 1024、*"supports user-defined output dimensions ranging from 32 to 1024"*；`MRL Support: Yes`、`Instruction Aware: Yes`；*"not using an `instruct` on the query side can lead to a drop in retrieval performance by approximately 1% to 5%"*）：`https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/raw/main/README.md`
- `[R15]` `jinaai/jina-embeddings-v3` 模型卡与 Hub API（`license: cc-by-nc-4.0`；8192 token；5 个任务 LoRA；Matryoshka 32–1024；`onnx/model.onnx_data` 2185.2 MB、`model_fp16.onnx` 1094.0 MB，**无 int8/q4**；HF 上无 `library_name: transformers.js` 的 v3 仓库）：`https://huggingface.co/jinaai/jina-embeddings-v3/raw/main/README.md` / `https://huggingface.co/api/models/jinaai/jina-embeddings-v3?blobs=true`
- `[R16]` `Alibaba-NLP/gte-multilingual-base` 模型卡与配置（*"Elastic Dense Embedding"*、`dimension=768 # should be in [128, 768]`、`outputs.last_hidden_state[:, 0]`；8192 token；305M；`license: apache-2.0`；`1_Pooling/config.json` = `pooling_mode_cls_token: true`；`config.json` `max_position_embeddings: 8192`、`vocab_size: 250048`）：`https://huggingface.co/Alibaba-NLP/gte-multilingual-base/raw/main/README.md` 等
- `[R17]` HuggingFace Hub — Google 的 QAT checkpoint 仓库 `google/embeddinggemma-300m-qat-q4_0-unquantized` 与 `-qat-q8_0-unquantized`（与 `onnx-community` 的 ONNX 导出**不是同一批权重**）：`https://huggingface.co/api/models?author=google&search=embeddinggemma`
- `[R18]` `onnx-community/Qwen3-Embedding-0.6B-ONNX` README 与 Hub API（JS 示例：`pooling: "last_token"` + `Instruct: {task}\nQuery:{query}`；dtype 选项只列 `fp32/fp16/q8`；int8/quantized 585.1 MB、q4f16 541.2 MB、q4 871.8 MB；`lastModified 2026-04-03`）：`https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX/raw/main/README.md`
- `[R19]` `onnx-community/gte-multilingual-base` README 与 Hub API（int8/quantized **324.55 MB**、q4 832.85 MB、q4f16 443.65 MB、fp16 598.9 MB；`lastModified 2024-10-08`；**README 示例用 `pooling: 'mean'` 并加前缀 `Represent this sentence for searching relevant passages: `，与 `[R16]` 的官方 CLS 用法矛盾**）；以及 `BAAI` 作者页按 `lastModified` 排序（`BAAI/bge-m3` 停在 2024-07-03）：`https://huggingface.co/onnx-community/gte-multilingual-base/raw/main/README.md`、`https://huggingface.co/api/models?author=BAAI&search=bge&sort=lastModified`
- `[R20]` **本机实测**（macOS arm64 / Node v24.18.0 / `@huggingface/transformers` 4.2.0 / 2026-08-14）：① 下载 `Xenova/bge-m3` 的 `onnx/model.onnx`、`onnx/sentence_transformers.onnx`、`BAAI/bge-m3` 的 `onnx/model.onnx`、`onnx-community/embeddinggemma-300m-ONNX` 的 `onnx/model.onnx`、`jinaai/jina-embeddings-v3` 的 `onnx/model.onnx`，用自写的最小 protobuf 解析器读 `GraphProto.input/output` 得到各图的 IO 名，并统计 `sparse`/`colbert` 字节出现次数（均为 0）；② `AutoTokenizer` 实测 616 字符英文段落与 210 字符中文段落的 token 数；③ transformers.js 加载与编码延迟、进程 RSS（见 §2.6）。脚本与原始输出保留在本次会话 scratchpad。
- `[R22]` Meta `facebook/belebele` 数据集卡（*"900 questions per language variant"*；*"488 distinct passages, there are 1-2 associated questions for each"*；*"Avg. words per passage = 79.1 (std = 26.2)"*；*"900 x 122 = 109,800 total questions"*）：`https://huggingface.co/datasets/facebook/belebele/raw/main/README.md`
- `[R21]` XOR-TyDi QA 论文（arXiv 2010.11856v3）语言列举原文：*"Arabic, Bengali, Finnish, Japanese, Korean, Russian and Telugu."*（**无中文**）：`https://arxiv.org/html/2010.11856v3`

# RAG 栈研究 — 问文档（chat）的 embedding、向量存储与切块

- **范围：** PDF Studio 单文档问答（问文档）的三块机制决策：① 检索用的 embedding 模型；② 向量存储（Cloudflare Vectorize vs D1 + FTS5 vs 外部 pgvector / Pinecone）；③ 学术 PDF（双栏、公式、图、表）的切块策略。答案来自「全文检索 + 读者贴进对话的摘录和图片」（见 `pdfstudio/CONTEXT.md` 的 chat 词条）；本文只研究「全文检索」这条路径，摘录/图片是读者显式贴入、已经是上下文，不需要检索或向量化。
- **方法：** 仅用一手来源——厂商官方文档、模型仓库的一手模型卡、源码仓库 README、第一方 API 文档（`developers.cloudflare.com`、`docs.voyageai.com`、`developers.openai.com` 的 markdown 镜像、`sqlite.org`、`github.com/pgvector`、`neon.com`、`supabase.com`、`docs.pinecone.io`、`docs.unstructured.io`、`docs.langchain.com`、Anthropic 的 `anthropic.com/news` 一手工程帖）。没有第三方博客总结，没有第三方基准聚合站。
- **检索时间：** 2026-08-13。除注明外，价格为每 1M token 的美元价（向量存储另按各自单位）。
- **引用键：** `[S1]…[S37]` 对应 [Sources](#sources) 里的 URL。没有引用的论断是我自己的分析，不是一手来源事实。

> ⚠️ 环境说明：模型格局已超出任务里提到的名字。Cloudflare Workers AI 当前托管的是 bge 系列 + `qwen3-embedding-0.6b` + `embeddinggemma-300m`（任务里说的「text-embeddings」在现目录里是任务类别名「Text Embeddings」，具体模型是 bge 系列）；Voyage 当前产品线是 **voyage-4 / 4-large / 4-lite**（任务里提的 voyage-3 / voyage-3-large 已列在「Older models」）；OpenAI 仍是 text-embedding-3-small / large + 遗留的 ada-002。本文报告各厂商文档**现在**怎么说，并锚定到仍存在的具名模型。

---

## 问题 1 — 检索 embedding 模型

### 1.1 Cloudflare Workers AI（在 Cloudflare 边缘跑，不出网）

现目录里「Text Embeddings」任务下的模型 `[S1]`：

| 模型 | 维度 | 最大输入 | 语言 | 价格 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `@cf/baai/bge-m3` | 1024（CF 页未标，见模型卡 `[S8]`） | 8,192 tokens（模型卡 `[S8]`；CF 页标「60,000 tokens 上下文窗口」，见 §1.5 差异） | 100+ 语言 `[S8]` | **$0.012** `[S7]` | 多语言/多功能/多粒度 `[S1][S2]` |
| `@cf/qwen/qwen3-embedding-0.6b` | 1024（模型卡 `[S9]`；CF 页未标） | 32k（模型卡 `[S9]`；CF 页标 8,192） | 100+ 语言，含中文 `[S9]` | **$0.012** `[S7]` | 中文优先训练，instruction-aware `[S9]` |
| `@cf/baai/bge-large-en-v1.5` | 1,024 `[S3]` | 512 tokens `[S3]` | **仅英文**（"English model" `[S8]`） | $0.204 `[S7]` | 不能用于中文 |
| `@cf/baai/bge-base-en-v1.5` | 768 `[S4]` | 512 tokens `[S4]` | 仅英文 | $0.067 `[S7]` | 同上 |
| `@cf/baai/bge-small-en-v1.5` | 384 `[S1]` | — | 仅英文 | $0.020 `[S7]` | 同上 |
| `@cf/google/embeddinggemma-300m` | CF 页未标 `[S5]` | CF 页未标 | 100+ 语言（"trained with data in 100+ spoken languages"）`[S5]` | — | 300M 参数，Google 出品 |
| `@cf/pfnet/plamo-embedding-1b` | — | — | **日语** `[S1]` | $0.019 `[S7]` | 不相关 |
| `@cf/baai/bge-reranker-base` | — | — | reranker（非 embedding） | $0.003 `[S7]` | 可做二次排序 |

要点：

- **bge-m3 是这里唯一同时满足「多语言 + 长输入 + 便宜」的通用选择**：模型卡自称 "Multi-Linguality: It can support more than 100 working languages"、1024 维、序列长度 8192，并同时支持 dense / sparse / multi-vector（ColBERT）三种检索 `[S8]`。BAAI 在模型卡里发布了自己的多语言 MIRACL 与 MLDR（13 语言长文档检索）评测结果 `[S8]`——但这是**自报**基准，不是第三方验证。
- **qwen3-embedding-0.6b 是第二个严肃选择**，而且它发布了**显式的中文基准**：模型卡里的 C-MTEB（MTEB Chinese）表给出 0.6B 版本的 C-MTEB Mean(Task) = 66.33（同为自报）`[S9]`。模型卡另称 "support for over 100 languages"、32k 上下文、1024 维（支持 32–1024 的 MRL 自定义维度）`[S9]`。
- 定价走 Workers AI 的 Neuron 模型：**$0.011 / 1,000 Neurons，每天 10,000 Neurons 免费额度**；embedding 表里 bge-m3 与 qwen3-embedding-0.6b 各 1,075 neurons / M input tokens（即 $0.012）`[S7]`。
- **运行位置是 Cloudflare 自己的边缘网络**（"Cloudflare-hosted" `[S2][S5][S6]`），在 Worker 里通过 `env.AI.run()` 调用，与 Vectorize / D1 同网，**无跨云 egress、无外部 API 往返** `[S20][S21]`。

### 1.2 Voyage AI（外部 API）

当前文本 embedding 产品线 `[S10]`：

| 模型 | 上下文 | 维度（默认/可选） | 描述 | 价格 `[S11]` |
| --- | --- | --- | --- | --- |
| `voyage-4-large` | 32,000 | 1024 / 256,512,2048 | "best general-purpose and **multilingual** retrieval quality" | $0.12 |
| `voyage-4` | 32,000 | 1024 / 256,512,2048 | "general-purpose and multilingual retrieval quality" | $0.06 |
| `voyage-4-lite` | 32,000 | 1024 / 256,512,2048 | "latency and cost" | $0.02 |
| `voyage-4-nano` | 32,000 | 1024 / 256,512,2048 | 开源权重（HF） | — |

旧模型（"Older models"）：`voyage-3-large`（$0.18）、`voyage-3.5`（$0.06）、`voyage-3`（$0.06）、`voyage-3-lite`（$0.02）、`voyage-multilingual-2`（$0.12）`[S10][S11]`。任务里点名的 voyage-3 / voyage-3-large 已不在推荐位。

- 文档里对语言只有「multilingual」这一个词，**没有语言清单、没有中文/zh 的任何质量数字** `[S10]`。FAQ 推荐 voyage-4-large（质量）/ voyage-4（均衡）/ voyage-4-lite（延迟成本）`[S12]`。
- 关键操作特性：`input_type=query|document` 会自动加检索指令前缀；embedding **归一化到长度 1**（cosine 与 dot-product 等价、与 Euclidean 排名一致）`[S12]`；支持 int8/uint8/binary 量化与降维 `[S10]`；Batch API 打 33% 折 `[S11]`；新账号 voyage-4 系列 2 亿 token 免费额度 `[S11]`。
- **外部 API**（`api.voyageai.com`），从 Cloudflare Worker 调用要走公网，加一次跨云往返与 egress。**没有公开的每请求延迟数字**（只有「voyage-4-lite 为低延迟」这类相对说法 `[S12]`）。

### 1.3 OpenAI（外部 API）

- 现目录只有 3 个 embedding 模型：`text-embedding-3-large`、`text-embedding-3-small`、遗留的 `text-embedding-ada-002` `[S16]`。
- `text-embedding-3-small`：默认 **1536 维**、最大输入 **8192 tokens**、MTEB 62.3%、约 62,500 页 / 美元；`text-embedding-3-large`：默认 **3072 维**、8192 tokens、MTEB 64.6%、约 9,615 页 / 美元；都支持 `dimensions` 参数无损缩短 `[S13]`。
- 价格：text-embedding-3-small **$0.02**、text-embedding-3-large **$0.13**、ada-002 $0.10 `[S14]`。
- 语言：模型页只说 text-embedding-3-large 是 "our most capable embedding model for both **english and non-english** tasks" `[S15]`。**文档里没有中文/zh 的质量数字，也没有语言清单**（MTEB 数字也不按语言拆）`[S13][S15]`。
- 外部 API，同样跨云往返。free 档限 40,000 TPM / 2,000 RPD / 100 RPM `[S15]`。

### 1.4 对比（一手，每 1M token）

| 轴 | CF bge-m3 | CF qwen3-embedding-0.6b | Voyage voyage-4 / 4-large | OpenAI te3-small / large |
| --- | --- | --- | --- | --- |
| 文档化的多语言/中文证据 | 100+ 语言 + 自报 MIRACL/MLDR `[S8]` | **100+ 语言 + 自报 C-MTEB（中文）** `[S9]` | 只写 "multilingual" `[S10]` | 只写 "english and non-english" `[S15]` |
| 价格 | **$0.012** | **$0.012** | $0.06 / $0.12（lite $0.02） | $0.02 / $0.13 |
| 维度 | 1024 | 1024 | 1024（可 256/512/2048） | 1536 / 3072 |
| 最大输入 | 8,192 | 32,000 | 32,000 | 8,192 |
| 运行位置 | **Cloudflare 边缘，不出网** | 同左 | 外部 API | 外部 API |
| 延迟 | 无公开数字；同网免跨云往返 | 同左 | 无公开数字 | 无公开数字 |
| reranker 配套 | bge-reranker-base $0.003 `[S7]` | —（Qwen 有 reranker，CF 未托管） | rerank-2.5 $0.05 / 2.5-lite $0.02 `[S11]` | — |

### 1.5 一手来源里的两个坑（如实报告）

1. **Cloudflare 模型页的「Context Window」字段与模型卡矛盾。** bge-m3 页标「60,000 tokens」`[S2]`，但 BAAI 模型卡写序列长度 8,192 `[S8]`；bge-base-en-v1.5 页同页既标「Context Window 153,600」又标「Maximum Input Tokens 512」`[S4]`；qwen3-embedding 页标 8,192 `[S6]`，Qwen 模型卡写 32k `[S9]`。可操作的约束应以**模型卡的序列长度**为准（bge-m3 = 8,192；qwen3-embedding = 32k）。CF 的「Context Window」字段对 embedding 模型不可靠。
2. **bge-m3 的稀疏/多向量模式在 Vectorize 里用不上。** bge-m3 本身支持 sparse + ColBERT 多向量 `[S8]`，但 Cloudflare Vectorize 是**稠密**向量库（每个 ID 一条向量、最大 1,536 维 `[S18][S20]`），所以在这套栈里只有 dense 模式可用。（这是两个一手来源拼出来的结论，不是任何一方明说。）

### 1.6 建议 — 问题 1：**用 Cloudflare Workers AI 的 `@cf/baai/bge-m3`；`qwen3-embedding-0.6b` 作并列候选**

在「文档化的中文质量」这个轴上，**只有 bge-m3 和 qwen3-embedding-0.6b 有第一手的多语言/中文证据**（自报基准 + 语言覆盖声明），Voyage 和 OpenAI 的文档都只有「multilingual / non-english」一个词、没有中文数字 `[S8][S9][S10][S15]`。在成本与部署上，两个 CF 模型都是 $0.012/M 且**在 Cloudflare 边缘本地跑**（无 egress、与 Vectorize/D1 同网），比 Voyage（$0.06–0.12）和 OpenAI（$0.13 large）便宜约一个数量级 `[S7][S11][S14]`。三者都没有公开延迟数字，但 CF 模型避免了跨云往返，结构上延迟更低。

在 bge-m3 与 qwen3-embedding-0.6b 之间没有一手来源能分出胜负（两者都是自报强多语言）：bge-m3 多语言口碑更久、8,192 输入、有 CF 上的 bge-reranker-base 配套 `[S7][S8]`；qwen3-embedding 有**中文 C-MTEB 数字**、32k 输入、instruction-aware `[S9]`。**默认选 bge-m3**（最稳的多语言 + reranker 配套 + 8,192 输入对论文切块足够）；如果中文检索质量是决定性指标，用一小批真实摘录做内部 eval 在两者间二选一——这是唯一站得住的收口方式，因为一手来源没有那个决定性数字（与 OCR 引擎研究结论同构）。

已排除：三个 `bge-*-en-v1.5`（英文 only，不能做 en↔zh）`[S8]`；plamo（日语）`[S1]`；Voyage 与 OpenAI 作为**默认**（外部调用 + 无中文质量证据 + 更贵），但保留在「质量不满意时换 Voyage voyage-4-large」的退路里。

---

## 问题 2 — 向量存储

### 2.1 Cloudflare Vectorize

- 定位：Cloudflare 自己的「globally distributed vector database」，与 Workers AI / Workers 同平台，做 RAG 的语义搜索 `[S17][S32]`。Vectorize 里「database 与 index 是同一个概念」`[S17]`。
- 距离度量：**cosine / euclidean / dot-product**，建索引时固定、不可改 `[S20]`。查询 `query()` 支持 `topK`、metadata 过滤、namespace，以及「高精度打分 vs 近似打分」开关 `[S21]`。
- 硬限制：**每个向量最多 1,536 维（float32）**、每向量 metadata 10 KiB、带 metadata 的 topK 最多 50、每索引最多 2,000 万向量、每账号 5 万索引 `[S18]`。（含义：OpenAI te3-large 的 3072 维必须缩到 ≤1536 才能入 Vectorize；bge-m3/qwen3 的 1024 维没问题 `[S13][S18]`。）
- 价格：按**被查询的向量维度 + 被存储的向量维度**计费。Workers Free 30M 查询维度/月 + 5M 存储维度；Workers Paid 首 50M 查询维度 + 每 1M 加 $0.01，存储首 10M + 每 1 亿加 $0.05。**不收 egress** `[S19]`。

### 2.2 D1 + FTS5 全文检索

- D1 是 Cloudflare 的 serverless SQL 数据库（SQLite 语义），支持 read replication，scale-to-zero 计费 `[S22][S32]`。**D1 明确支持 SQLite 的 FTS5 模块做全文检索（含 `fts5vocab`）** `[S23]`。
- 价格：读 5M 行/天免费（Paid 首 25B 行/月 + 每 1M $0.001）、写 100k 行/天（首 50M + 每 1M $1.00）、存储首 5 GB + $0.75/GB·月；不收 egress `[S24]`。
- 限制：单库 **10 GB（Paid）/ 500 MB（Free）**；**单库单线程**（1 ms 查询约 1000 QPS）；每 Worker 调用 6 个并发连接；单查询 30 秒上限 `[S25]`。2 MB 单行上限 `[S25]`。

**FTS5 对双语（en↔zh）的实际情况（关键）**：FTS5 默认 `unicode61` tokenizer 把「L（字母）/N（数字）类字符」当作 token 字符、其余为分隔符，**「连续的一段 token 字符 = 一个 token」** `[S26]`。英文靠空格分词没问题；但**中文词之间没有空格，连续汉字会被当成一个巨 token**，词/短语查询会失效——这是从 tokenizer 规则直接推出的后果（SQLite 文档本身**只字不提中文/CJK**，也没有内置中文分词）。文档给出的唯一通用补救是 **trigram tokenizer**（"treats each contiguous sequence of three characters as a token, allowing FTS5 to support more general **substring matching**"），可对 ≥3 字符的子串做子串匹配，并支持索引化的 GLOB/LIKE `[S26]`。排名用内置 `bm25()` `[S26]`。也就是说：**D1+FTS5 做英文关键词检索直接可用；做中文要么 trigram 子串匹配（能用但无语义、bm25 对 trigram 的排名意义不同），要么上 embedding 做语义检索。**

### 2.3 外部：pgvector（Supabase / Neon）与 Pinecone

- **pgvector** 是 Postgres 的开源向量扩展：HNSW / IVFFlat 近似索引；`vector` ≤2,000 维、`halfvec` ≤4,000、`bit` ≤64,000、`sparsevec` ≤1,000 非零；L2 / 内积 / cosine / L1 / Hamming / Jaccard 距离 `[S27]`。开源（README 自称 "Open-source vector similarity search for Postgres"）`[S27]`，SQL 可移植、锁定低。
  - **Neon**（serverless Postgres）：pgvector 在**所有套餐免费可用**、无附加费 `[S28]`；Free 套餐 $0（100 CU-hours/月、0.5 GB 存储、5 GB egress、5 分钟无活动 scale-to-zero），Launch $0.106/CU-hour + $0.35/GB·月，超额 egress $0.10/GB `[S29]`；有 Data API（HTTP 查询），其 serverless driver 走 HTTP/WebSocket，能在 Workers 里用 `[S29]`。
  - **Supabase**：pgvector 以 `create extension vector` 启用，`vector(n)` 类型 + `<->`/`<#>`/`<=>` 算子 `[S30]`。**注意：PostgREST 不支持 pgvector 相似度算子**，官方指南要求把向量查询包成 Postgres 函数、再从客户端 `rpc()` 调用 `[S30]`——比 Neon 的 HTTP driver 更绕。
  - 集成成本：两者都在 Cloudflare 之外，Worker 要跨云连 Postgres（egress + 连接建立延迟）。Cloudflare 自己的定位页把「外部 Postgres/MySQL」交给 **Hyperdrive** 来加速连接 `[S32]`。
- **Pinecone**：全托管 serverless 向量库（pod 型已对 2025 年 8 月后的新客户停用），Starter 免费档、Builder 固定 $20/月、Standard/Enterprise 按读/写 unit 用量计费；命名空间做多租户；支持 BM25（全文）+ dense + sparse 的 hybrid 检索 `[S31]`。同样**在 Cloudflare 之外**，纯外部 API。

### 2.4 规模适配（我的分析，非来源断言）

- **单 PDF 的 chunks 很小**：一份论文切成「几百 token / 块」大约是几百到小几千块（§3）。无论哪个方案，这都在免费额度里：Vectorize 的 5M 存储维度 ≈ 5,000 条 1024 维向量、30M 查询维度 ≈ 3 万次查询/月 `[S19]`；D1 的 5M 行读/天对全文检索绰绰有余 `[S24]`。
- **跨 PDF 知识库更大但仍小**：即便几千篇论文、每篇上千块，也远低于 Vectorize 2,000 万向量/索引 `[S18]` 与 D1 10 GB/库 `[S25]` 的上限。
- 这个规模下，**外部 pgvector / Pinecone 的容量优势（单库 >10 GB、亿级向量）用不上**，却引入跨云 egress + 连接管理 + 第二套计费。

### 2.5 建议 — 问题 2：**D1（已在栈里）+ FTS5 起步；需要语义检索时加 Vectorize；不引入外部 pgvector / Pinecone**

**单 PDF 规模不需要专用向量库。** 问文档的「全文检索」若是关键词检索，D1 + FTS5 足够，且 D1 本来就是这套栈的既有依赖（Drizzle/D1），零新增成本、零新系统。真正的缺口在中文：FTS5 对中文要用 **trigram tokenizer** 做子串匹配（文档化的唯一内置办法 `[S26]`），否则中文词检索失效。

**如果要把「全文检索」升级成语义检索**（对双语论文的跨语言/同义召回，或知识库跨 PDF 检索），在 Cloudflare 平台上加 **Vectorize** 而不是出网：与 Workers AI（bge-m3 1024 维）同网直连、免费额度覆盖当前规模、无 egress `[S18][S19][S21]`。锁定低——它就是 Cloudflare 的原生存储，数据也在本平台。

**pgvector（Neon/Supabase）与 Pinecone 留作「明确需要完整 Postgres 或亿级向量」时的退路**，当前没有触发条件。若日后知识库大到需要，Neon（HTTP driver + pgvector 免费可用 `[S28][S29]`）比 Supabase（要 RPC 包一层 `[S30]`）和 Pinecone（纯外部 + 按量）更贴合 Workers。

一句话：**D1 + FTS5（trigram）先行；Vectorize 是按需增量的语义层；不必为「一个 PDF」的规模引入专用/外部向量库。**

---

## 问题 3 — 学术 PDF（双栏、公式、图、表）的切块策略

### 3.1 一手来源**确实**说了什么（可引用的通用指导）

1. **切块的目的与粒度**：切块是为了「让每一块能单独被检索、且不超过 embedding 模型的上下文窗口」`[S35]`；Anthropic 的语境检索帖把标准 RAG 步骤写成「把知识库切成小块，**通常一块不超过几百 token**」`[S36]`。Unstructured 明确说「max characters 设多少，去看你要用的 embedding 模型的文档」`[S33]`——即切块上限由模型上下文决定（本栈 bge-m3 = 8,192 token `[S8]`，几百 token 的块远在其内）。
2. **按结构切，而不是硬切**：LangChain 推荐首选 `RecursiveCharacterTextSplitter`，按「段落 → 句子 → 词」层级递归切，尽量保持大单元完整，配 `chunk_size` / `chunk_overlap` `[S35]`；也支持按文档结构切（Markdown 标题、HTML 标签、代码块）`[S35]`。
3. **尊重章节/页面边界**：Unstructured 的 **by-title**（遇标题就开新块，保证一块不跨两个 section）与 **by-page**（一块不跨两页）策略 `[S33]`。学术论文天然有 section 标题，这是最相关的开关。
4. **表要单独成块**：Unstructured 规定**表永远作为独立 chunk**、不与其他元素合并；超长表**按行切**成 `TableChunk` `[S33]`。
5. **重叠保留上下文**：Unstructured 的 overlap 把上一块末尾若干字符复制到下一块开头 `[S33]`；LangChain 的 `chunk_overlap` 同义 `[S35]`。
6. **语义/上下文增强（可选的二次手段）**：Unstructured 有 **by-similarity**（用 `sentence-transformers/multi-qa-mpnet-base-dot-v1` 把相似元素并成一块）`[S33]` 与 **contextual chunking**（给每块前面加一小段「这一块在全文里的位置」说明，`Prefix:…; Original:…`）`[S33]`。后者源自 Anthropic 的 Contextual Retrieval：**Contextual Embeddings 让 top-20 检索失败率降 35%，再加 Contextual BM25 降 49%，再加 rerank 降 67%** `[S36]`。
7. **双栏/图/表的结构问题属于「分区（partitioning）」而非「切块」**，必须先于切块解决：Unstructured 对 PDF 的分区策略里，**High Res** 能产出元素 bounding box 坐标、**VLM** 做页面级理解；表在 High Res/VLM 下输出「文本 + HTML 表示」；非拉丁文字（如日文假名）在 Fast/High Res 下输出会「不可用」，只有 VLM 能处理好 `[S34]`。这正是双栏 PDF 的第一步——先把栏序还原成线性文本。

### 3.2 一手来源**没**说什么（如实标注的空白）

- **没有一家**（Cloudflare、OpenAI、Voyage、LangChain、Unstructured、pgvector/Pinecone、Anthropic）发布过针对「**双栏学术 PDF + 公式 + 图 + 表**」的检索质量切块指引或数字。Cloudflare 的 Vectorize 入门页只示范 `--dimensions=768`，**没有任何切块建议** `[S37]`。
- **公式**：所有一手来源对「数学公式如何切块/如何检索」**只字未提**——没有哪家文档化「公式应独立成块 / 与上下文合并 / 转 LaTeX 后怎么处理」。
- **图**：分区来源把图当作**图像元素**（不是文本块）——Unstructured 的 Fast 直接跳过图、High Res 需另配 image description、VLM 输出图片摘要 `[S34]`；切块文档明确「Image 元素不进入切块输出」`[S33]`。没有来源讨论「图注 + 图的检索」。
- **双栏**：没有任何来源明确给出「双栏阅读顺序」的切块规则；最接近的是「用 bounding box 坐标（High Res）做布局感知」`[S34]`——它只保证能拿到坐标，不保证栏序还原正确。Cloudflare 生态里对应的事实是 pdf.js 的 `TextItem.transform` 提供逐项坐标（PDF Studio 上一份 OCR 研究已确认），**栏序还原逻辑要自己写**。

### 3.3 建议 — 问题 3（哪些是一手来源支持的、哪些是我自己的综合，分开标注）

**一手来源支持的切块做法**（可直接照做）：

1. 切块上限对齐 embedding 模型：bge-m3 8,192 token `[S8]`，块取「几百 token」量级 `[S36]`，留足余量。
2. 按结构递归切：section 标题优先、段落 → 句子 → 词 `[S35]`；用 by-title 语义保证一块不跨 section `[S33]`。
3. 重叠：块间 overlap 保留边界上下文 `[S33][S35]`。
4. **表独立成块、超长按行切** `[S33]`。
5. 可选的上下文增强：给每块前置「论文标题 + section 标题」的 Prefix（contextual chunking），Anthropic 报告能显著降检索失败率 `[S33][S36]`。

**我自己的综合（无直接来源，明确标注为分析）**：

6. **双栏：切块前先做布局感知的栏序还原。** 用已有 pdf.js 逐项坐标（`TextItem.transform`）按 y 轴分栏、按栏序拼接，或等效的分区步骤（Unstructured High Res 的 bounding box `[S34]`）；**这一步错了，后面任何切块策略都救不回来**。来源只保证「能拿到坐标」，不保证栏序正确，需要自测。
7. **公式：并入所在段落的文本流**（用 PDF Studio OCR 管线产出的 LaTeX 文本），不单独成块也不删除；并在内部 eval 里专门盯公式相关问题的召回。**没有任何来源给出公式的切块规则，这里是空白。**
8. **图：图本身不进文本切块** `[S33]`；把「图注 + 所在 section」作为文本块的一部分（图的视觉内容若要检索，走 PDF Studio 已有的截图/摘录路径，或另配 image description `[S34]`，不在本文范围）。
9. 先落一个最简单的版本（结构递归 + 标题边界 + overlap + 表独立），**用真实论文问题集做内部召回 eval 再迭代**——因为 §3.2 的空白意味着没有一手来源能替我们决定这些参数。

---

## Sources

- `[S1]` Cloudflare Workers AI — Text Embeddings 模型目录（bge-m3 / bge-large / bge-base / bge-small / embeddinggemma / qwen3-embedding / plamo 列表与描述）: https://developers.cloudflare.com/workers-ai/models/embedding/
- `[S2]` Cloudflare — `@cf/baai/bge-m3` 模型页（Cloudflare-hosted、$0.012、"Context Window 60,000"）: https://developers.cloudflare.com/ai/models/@cf/baai/bge-m3/
- `[S3]` Cloudflare — `@cf/baai/bge-large-en-v1.5` 模型页（1024 维、512 最大输入、$0.204）: https://developers.cloudflare.com/ai/models/@cf/baai/bge-large-en-v1.5/
- `[S4]` Cloudflare — `@cf/baai/bge-base-en-v1.5` 模型页（768 维、512 最大输入、"Context Window 153,600"）: https://developers.cloudflare.com/ai/models/@cf/baai/bge-base-en-v1.5/
- `[S5]` Cloudflare — `@cf/google/embeddinggemma-300m` 模型页（300M 参数、100+ 语言）: https://developers.cloudflare.com/ai/models/@cf/google/embeddinggemma-300m/
- `[S6]` Cloudflare — `@cf/qwen/qwen3-embedding-0.6b` 模型页（"Context Window 8,192"、$0.012）: https://developers.cloudflare.com/ai/models/@cf/qwen/qwen3-embedding-0.6b/
- `[S7]` Cloudflare Workers AI Pricing（$0.011/1k Neurons、每日 10k 免费；embedding 与 reranker 定价表）: https://developers.cloudflare.com/workers-ai/platform/pricing/
- `[S8]` BAAI bge-m3 模型卡（1024 维、8192 序列、100+ 语言、dense/sparse/multi-vector、MIRACL/MLDR）: https://huggingface.co/BAAI/bge-m3
- `[S9]` Qwen3-Embedding-0.6B 模型卡（100+ 语言、32k、1024 维/MRL 32–1024、C-MTEB 中文基准表）: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- `[S10]` Voyage AI — Text Embeddings（voyage-4/4-large/4-lite/4-nano 及旧模型表、维度、input_type、量化）: https://docs.voyageai.com/docs/embeddings
- `[S11]` Voyage AI — Pricing（voyage-4 系列价格、免费额度、batch 33% 折、reranker 价格）: https://docs.voyageai.com/docs/pricing
- `[S12]` Voyage AI — FAQ（voyage-4 系列推荐、归一化到长度 1、input_type 指令前缀）: https://docs.voyageai.com/docs/faq
- `[S13]` OpenAI — Embeddings guide（te3-small 1536/8192/62.3%/62,500 页；te3-large 3072/8192/64.6%/9,615 页；dimensions 参数）: https://developers.openai.com/api/docs/guides/embeddings
- `[S14]` OpenAI — Pricing（text-embedding-3-small $0.02 / -large $0.13 / ada-002 $0.10）: https://developers.openai.com/api/docs/pricing
- `[S15]` OpenAI — text-embedding-3-large 模型页（"english and non-english tasks"、rate limits）: https://developers.openai.com/api/docs/models/text-embedding-3-large
- `[S16]` OpenAI — Models index（embedding 模型仅 te3-large/small/ada-002）: https://developers.openai.com/api/docs/models
- `[S17]` Cloudflare Vectorize — "Vector databases"（RAG 工作流、cosine/euclidean/dot、database=index）: https://developers.cloudflare.com/vectorize/reference/what-is-a-vector-database/
- `[S18]` Cloudflare Vectorize — Limits（1536 维、float32、topK 50/100、10KiB metadata、2000 万向量/索引）: https://developers.cloudflare.com/vectorize/platform/limits/
- `[S19]` Cloudflare Vectorize — Pricing（查询/存储维度计费、免费额度、无 egress）: https://developers.cloudflare.com/vectorize/platform/pricing/
- `[S20]` Cloudflare Vectorize — Create indexes（维度、cosine/euclidean/dot-product，创建后不可改）: https://developers.cloudflare.com/vectorize/best-practices/create-indexes/
- `[S21]` Cloudflare Vectorize — Query vectors（query()、topK、metadata 过滤、高精度 vs 近似打分）: https://developers.cloudflare.com/vectorize/best-practices/query-vectors/
- `[S22]` Cloudflare D1 — 首页（serverless SQL、SQLite 语义、read replication）: https://developers.cloudflare.com/d1/
- `[S23]` Cloudflare D1 — SQL statements（支持 FTS5 全文检索模块，含 fts5vocab）: https://developers.cloudflare.com/d1/sql-api/sql-statements/
- `[S24]` Cloudflare D1 — Pricing（读 5M 行/天、写 100k/天、存储 5GB、无 egress）: https://developers.cloudflare.com/d1/platform/pricing/
- `[S25]` Cloudflare D1 — Limits（10GB/库、单线程、6 连接、30s 查询）: https://developers.cloudflare.com/d1/platform/limits/
- `[S26]` SQLite — FTS5（unicode61 tokenizer：L/N 为 token 字符、连续 token 字符为一个 token；trigram 子串匹配；bm25()；全文未提及中文/CJK）: https://sqlite.org/fts5.html
- `[S27]` pgvector README（开源；HNSW/IVFFlat；vector≤2000/halfvec≤4000/bit≤64000/sparsevec；L2/IP/cosine/L1/Hamming/Jaccard）: https://github.com/pgvector/pgvector
- `[S28]` Neon — pgvector 扩展页（所有套餐免费可用、无附加费；HNSW/IVFFlat 维度上限）: https://neon.com/docs/extensions/pgvector
- `[S29]` Neon — Pricing（Free/Launch/Scale、scale-to-zero、egress $0.10/GB、Data API over HTTP）: https://neon.com/pricing
- `[S30]` Supabase — Vector columns（pgvector；`vector(n)`；`<->`/`<#>`/`<=>`；PostgREST 不支持 pgvector 算子 → 需 RPC 函数）: https://supabase.com/docs/guides/ai/vector-columns
- `[S31]` Pinecone — Database limits 与 Upgrade billing plan（serverless 索引、Starter 免费档、Builder $20/月、Standard/Enterprise 按量、read/write units、namespaces）: https://docs.pinecone.io/reference/api/database-limits ；https://docs.pinecone.io/guides/organizations/manage-billing/upgrade-billing-plan
- `[S32]` Cloudflare — Choose a data or storage product（D1=轻量 SQL、Vectorize=向量搜索、Hyperdrive=连外部 Postgres）: https://developers.cloudflare.com/workers/platform/storage-options/
- `[S33]` Unstructured — Chunking（basic/by-title/by-page/by-similarity 策略、max chars、overlap、表独立/按行切、contextual chunking）: https://docs.unstructured.io/concepts/chunking
- `[S34]` Unstructured — Partitioning（PDF 的 Auto/VLM/High Res/Fast 策略、表→HTML、bounding box、多语言仅 VLM 可靠）: https://docs.unstructured.io/concepts/partitioning
- `[S35]` LangChain — Text splitter integrations（RecursiveCharacterTextSplitter 段落→句子→词、chunk_size/chunk_overlap、长度/结构切分）: https://docs.langchain.com/oss/python/integrations/splitters/
- `[S36]` Anthropic — Contextual Retrieval（一手工程帖：块通常「不超过几百 token」；Contextual Embeddings 降 35%、+Contextual BM25 降 49%、+rerank 降 67%）: https://www.anthropic.com/news/contextual-retrieval
- `[S37]` Cloudflare Vectorize — Get started with embeddings（教程只设 `--dimensions=768`，无切块指引）: https://developers.cloudflare.com/vectorize/get-started/embeddings/

# 检索 embedding 用 Cloudflare Workers AI bge-m3

单文档 chat 的检索 embedding 用 Cloudflare Workers AI `@cf/baai/bge-m3`（1024 维），它是唯一有第一方多语言/中文证据（MIRACL/MLDR）、且跑在 edge 无出口流量的选项。Voyage 与 OpenAI 没有中文质量数据且贵 5–10 倍；bge-m3 与 qwen3-embedding 的细微差距留待以后的小型中文 eval，不阻塞。

## 修订（2026-08-14）：立论句被证伪，选型改由自家 eval 定

**原文的理由句「bge-m3 是唯一有第一方多语言/中文证据（MIRACL/MLDR）的选项」已不成立**
（见 `research-embedding-shortlist.md`）：

- `gte-multilingual-base` 有 mGTE 论文的 MKQA zh_cn 第一方数据，Apache-2.0
- `Qwen3-Embedding` 有第一方多语言评测，Apache-2.0
- 而 **MIRACL 这条证据本身作废**：MTEB 的模型注册表声明 bge-m3 / embeddinggemma /
  Qwen3 / gte **四家全部把它训过**（BGE-M3 论文原文亦承认）

另有两条与本 ADR 直接相关的复核结论：

- **MIRACL `zh` 不是跨语言任务**。MTEB 源码里它的 `eval_langs` 是单元素 `["zho-Hans"]`
  ——中文问中文文档。而我们的用例是**中文问英文论文**，原文把它当跨语言证据是误读。
- **走 ONNX 只拿得到 dense 一路**（实测三个 ONNX 图的 IO，`sparse`/`colbert` 出现
  次数为 0）。好消息是按 BGE-M3 论文自己的消融，zh→en 上三路混合比 dense 只高
  0.4–0.9 点，所以拿 dense-only 比较对这个任务是公平的——但这也意味着 bge-m3
  最大的差异化能力在我们的落地形态下用不上。

**决策改为暂定。** 默认模型不再由公开榜单决定，而由 `pdfstudio/eval/retrieval/` 的
实测决定。`research-embedding-shortlist.md` §5.2 列了 8 条可证伪条件，都写成了这套
eval 能直接判定的形式。

**当前排序（置信度中等偏低）**：`embeddinggemma-300m`（ONNX q8 294.6 MB）>
`gte-multilingual-base`（int8 324.6 MB）> `bge-m3`（int8 542.1 MB）。
干净的证据只有 MLQA 一个数据点，而 MLQA 语料是维基段落——句式规整、长度均匀；
我们的语料是 PDF 抽出来的论文块，有断行噪声、公式残片、双栏错序。**这两种分布的
差距可能比模型之间的差距还大。**

**许可不再是约束**：本项目开源、非商业，Gemma 许可可接受。所以这是纯技术选型。


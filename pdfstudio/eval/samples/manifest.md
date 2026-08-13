# PDF Studio — Cloud Multimodal Model Eval Sample Set (en)

标注样本集，用于评估 cloud multimodal model 在 PDF Studio 用例上的表现：
OCR 公式（→LaTeX）、figure/diagram/table 理解、图文混排区域、以及英文稠密文本段落。

- 来源论文均为公开 arXiv 论文（英文），PDF 保存在 `pdfstudio/eval/papers/`。
- 每张样本由 300 DPI 渲染后按页面坐标（points）裁剪，命名规则：
  `f` = formula，`g` = figure/table，`p` = paragraph，`m` = mixed（图文混排）。
- `expected-output` 一栏留空（或 `—`）：本 eval 以人工对照 PDF 目检为准，manifest 只负责提供
  type + source + page，便于核对，不做自动打分。

| id | type | source (arXiv + page) | 内容说明 | expected-output |
|----|------|-----------------------|----------|-----------------|
| f01 | formula | arXiv:2006.11239 (DDPM), p.2 | 逆向过程联合分布 p_θ(x_0:T) = p(x_T) ∏ p_θ(x_{t-1}|x_t)，含下标 θ、希腊字母 µ/Σ | — |
| f02 | formula | arXiv:2006.11239 (DDPM), p.2 | 前向过程 q(x_{1:T}|x_0) = ∏ q(x_t|x_{t-1})，含连乘 ∏、根号、下标 t、希腊字母 β | — |
| f03 | formula | arXiv:2006.11239 (DDPM), p.3 | 变分下界 L = E_q[...] + Σ D_KL(...)，含期望 E_q、KL 散度、下花括号标注 L_{t-1}/L_0/L_T | — |
| f04 | formula | arXiv:2006.11239 (DDPM), p.3 | L_{t-1} = E_{x_0,ϵ}[ β²/(2σ²α(1-ᾱ)) ‖ϵ − ϵ_θ(·)‖² ]，含范数平方、分式、下标 t | — |
| f05 | formula | arXiv:1706.03762 (Transformer), p.4 | Scaled Dot-Product Attention：Attention(Q,K,V) = softmax(QK^T/√d_k)V，含转置、softmax、根号分式 | — |
| f06 | formula | arXiv:1706.03762 (Transformer), p.5 | MultiHead(Q,K,V) = Concat(head_1,...,head_h)W^O 及 head_i 定义，含下标 i/h、投影矩阵 W^Q/W^K/W^V | — |
| g01 | figure | arXiv:2006.11239 (DDPM), p.1 | Figure 1：CelebA-HQ 与 CIFAR10 生成样本图（含图题） | — |
| g02 | figure | arXiv:1706.03762 (Transformer), p.3 | Figure 1：Transformer 模型架构图（encoder/decoder 方框图，含图题） | — |
| g03 | figure | arXiv:1706.03762 (Transformer), p.4 | Figure 2：Scaled Dot-Product Attention 与 Multi-Head Attention 示意图（含图题） | — |
| g04 | table | arXiv:1706.03762 (Transformer), p.6 | Table 1：各层类型复杂度 / 顺序操作数 / 最大路径长度（含 O(·) 记号） | — |
| g05 | figure | arXiv:1512.03385 (ResNet), p.4 | Figure 3：VGG-19 / 34-layer plain / 34-layer residual 三种架构图（含图题） | — |
| g06 | table | arXiv:1512.03385 (ResNet), p.5 | Table 1：ImageNet 各网络架构表（conv1–conv5、×2/×3 括号块、FLOPs） | — |
| p01 | paragraph | arXiv:2006.11239 (DDPM), p.2 | 摘要/引言段落（英文稠密文本，单栏） | — |
| p02 | paragraph | arXiv:1706.03762 (Transformer), p.2 | Introduction 段落（英文稠密文本，单栏） | — |
| p03 | paragraph | arXiv:1706.03762 (Transformer), p.6 | §4 Why Self-Attention 段落（英文稠密文本，单栏） | — |
| p04 | paragraph | arXiv:1512.03385 (ResNet), p.2 | §2 Related Work 段落（英文稠密文本，双栏左栏） | — |
| m01 | mixed | arXiv:1512.03385 (ResNet), p.4 | 图文混排：左栏 Figure 3 架构图 + 右栏正文段落（双栏同页） | — |
| m02 | mixed | arXiv:1706.03762 (Transformer), p.3 | 图文混排：Figure 1 架构图 + 图题 + 下方正文段落 | — |
| m03 | mixed | arXiv:2006.11239 (DDPM), p.6 | 图文混排：Figure 3/4 样本图 + 图题 + Algorithm 3/4 伪代码块 | — |

## 统计

- 共 **19** 张样本：formula ×6，figure/table ×6（figure ×4 + table ×2），paragraph ×4，mixed ×3。
- 渲染工具链：**poppler**（`pdftoppm`，经 `brew install poppler` 安装，v26.08.0），
  300 DPI 渲染 + Python/Pillow 按页面坐标裁剪；布局坐标由 `pdftotext -bbox-layout` 与
  `pdftohtml -xml` 提取用于定位公式、图、表与段落。

## 已知缺口：zh（中文）来源样本

**中文样本无法取自 arXiv**（arXiv 基本只有英文论文）。本集合仅覆盖 en 来源；
en↔zh 方向的评估还需要 **zh→en** 方向的样本，目前为空白。

后续补充中文学术 PDF 的建议来源：

- 中文期刊/学位论文平台：CNKI（知网）、万方、维普，选择数学/计算机/物理类论文
  （含公式、图、表，例如中文期刊《软件学报》《计算机学报》《数学学报》等）。
- 国内高校/研究所公开的学位论文 PDF（如 arXiv 之外的开放仓储、机构知识库）。
- 中文技术书籍或讲义 PDF（含公式与图表，结构类似学术论文）。
- 需要注意：多数中文平台有版权/访问限制，下载与裁剪流程需单独处理（登录、验证码、
  PDF 可能为扫描版需 OCR 预处理）；建议后续单独建立 `pdfstudio/eval/samples/zh/` 目录，
  命名沿用 `f/g/p/m` 前缀，并在 manifest 中标注 `source` 为具体中文来源与页码。

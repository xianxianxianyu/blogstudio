# PDF Studio — Retrieval Eval 标注问题集

标注问题集，用于评估 `Chat` 内部检索缝（切块 + embedding + 打分）把问题定位到**正确页**的能力。
核心用例是「读者用中文问英文论文」，所以问题以中文为主，英文问题作对照组。

- 来源论文均为公开 arXiv 论文（英文），PDF 保存在 `pdfstudio/eval/papers/`。
- **页码以 `pdftotext -f N -l N <paper>.pdf -` 的输出为准**（即 PDF 物理页，非论文自印页号，两者在这三篇里恰好一致）。
- `答案依据` 一栏是原文片段，**逐字**取自该页的 `pdftotext` 输出；归一化空白后可在该页文本里检索到，
  且在全文范围内只出现在这一页（已逐条核对，见「核对方法」）。
- `en-*` 六条是 `zh-*` 中六条的**逐句对译**（同页、同依据），构成受控对照：同一条依据下
  zh 与 en 的召回差就是跨语言检索的净损失。
- 中文问题**刻意不含任何英文词**。含英文词的中文问题会退化成关键词匹配，测不出跨语言能力
  （现有基线 `search()` 只匹配 `[a-z0-9]{3,}`，见 `pdfstudio/src/chat/chat.ts`）。
- `cl-*` 六条是**摘录题**：问的是公式的写法、图与表的内容。pdf.js 文本层在这几处要么给乱码、
  要么什么都没有，所以它们只有在摘录进检索池时才可能召回。**它们不计入主 recall 与阈值曲线**
  ——`MIN_PEAK_MARGIN` 是在原来那 29 条上标定的，混进新题会让历史数字失去可比性。
  它们单独报一段：同一套题跑 `--clips` 与不跑，差值就是摘录索引的净收益。
- `fu-*` 六条是**追问题**：`前一问 ‖ 追问`，用 `‖` 分隔。它们量的是「读者接着上一句往下
  问」时检索还找不找得到——第二问单独看往往没有任何可检索的名词（「那反向的呢」）。
  runner 会照生产的规则把两轮拼成查询（调 `retrievalQuery`，不自己再实现一遍），
  所以量到的就是读者真实会遇到的行为。**同样不计入主 recall 与阈值曲线。**

  其中 `fu-07`…`fu-09` 是**退化追问**——整句只剩指代（「那它呢」「再详细点」）。
  前六条一开始是照「追问没有主题词」这个假设写的，实测 6/6 全中，因为它们其实都还
  保留着主题词（「训练」「反向」「缩放」）。**假设被数据推翻了**，所以补这三条去找
  真正的失败边界。
- `na-*` 三条是**文档答不了**的问题，页码记 `—`。它们验的是不变量⑤：没有依据必须返回
  `grounding: 'none'`，不许硬凑一段原文当出处。

| id | lang | question | paper | 正确答案所在页 | 答案依据（原文片段，20–40 词） | 备注 |
|----|------|----------|-------|---------------|-------------------------------|------|
| zh-01 | zh | 基础版模型是在什么硬件上训练的？训练一步大约要多久？ | arXiv:1706.03762 (Transformer) | 7 | We trained our models on one machine with 8 NVIDIA P100 GPUs. For our base models using the hyperparameters described throughout the paper, each training step took about 0.4 seconds. | 直述；en-01 对照 |
| zh-02 | zh | 多头注意力一共并行几个头？每个头里键和值的维度各是多少？ | arXiv:1706.03762 (Transformer) | 5 | In this work we employ h = 8 parallel attention layers, or heads. For each of these we use dk = dv = dmodel /h = 64. | 直述；答案是公式里的下标变量，文本层写成 `dk`/`dmodel` 而非上下标 |
| zh-03 | zh | 论文为什么最终选了周期函数形式的位置编码，而不是学出来的那一种？ | arXiv:1706.03762 (Transformer) | 6 | We chose the sinusoidal version because it may allow the model to extrapolate to sequence lengths longer than the ones encountered during training. | 跨段综合；理由散在 §3.5 三段里，只有最后一句给了取舍结论 |
| zh-04 | zh | 编码器由多少个相同的层堆叠而成？每层的第一个子层是什么？ | arXiv:1706.03762 (Transformer) | 3 | The encoder is composed of a stack of N = 6 identical layers. Each layer has two sub-layers. The first is a multi-head self-attention mechanism | 直述 |
| zh-05 | zh | 注意力打分时为什么要先按维度开根号做缩放？不缩放会出什么问题？ | arXiv:1706.03762 (Transformer) | 4 | We suspect that for large values of dk , the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients | 公式相关；同页有公式 (1)，理由在正文；en-02 对照 |
| zh-06 | zh | 消融实验里把正弦形式的位置编码换成可学习的位置嵌入之后，结果有什么变化？ | arXiv:1706.03762 (Transformer) | 9 | In row (E) we replace our sinusoidal positional encoding with learned positional embeddings [9], and observe nearly identical results to the base model. | 表格解读；答案句在 Table 3 下方正文，与 p.6 的同主题段落构成干扰对 |
| zh-07 | zh | 在层类型对比表里，受限自注意力这一行的最大路径长度是多少？ | arXiv:1706.03762 (Transformer) | 6 | Sequential Operations O(1) O(n) O(1) O(1) Maximum Path Length O(1) O(n) O(logk (n)) O(n/r) | **表格**；表体被文本层拆成按列排布的短行，片段短于 20 词属预期；p.7 正文另有 `O(n/r)` 的复述，是最近干扰项 |
| zh-08 | zh | 多个残差网络集成后在图像分类测试集上的错误率是多少？拿到了什么名次？ | arXiv:1512.03385 (ResNet) | 1 | An ensemble of these residual nets achieves 3.57% error on the ImageNet test set. This result won the 1st place on the ILSVRC 2015 classification task. | 直述（摘要）；p.2、p.6 有同数字的复述，属可接受的近似命中；en-03 对照 |
| zh-09 | zh | 作者把堆叠层要拟合的目标改写成了什么形式？改写后原来的映射变成什么？ | arXiv:1512.03385 (ResNet) | 3 | So rather than expect stacked layers to approximate H(x), we explicitly let these layers approximate a residual function F(x) := H(x) − x. The original function thus becomes F(x)+x. | 公式；p.2 引言里有一段几乎同义的表述，是最近干扰项 |
| zh-10 | zh | 在大规模图像分类上训练时，批大小取多少？学习率如何衰减？总共训练多少次迭代？ | arXiv:1512.03385 (ResNet) | 4 | We use SGD with a mini-batch size of 256. The learning rate starts from 0.1 and is divided by 10 when the error plateaus, and the models are trained for up to 60 × 104 iterations. | 直述；与 zh-12（小图数据集上的另一套训练配置）成对，考的是能不能分开两套超参 |
| zh-11 | zh | 架构表里，层数最多的那一个网络的浮点运算量是多少？ | arXiv:1512.03385 (ResNet) | 5 | average pool, 1000-d fc, softmax 1.8×109 3.6×109 3.8×109 7.6×109 11.3×109 | **表格**；Table 1 的 FLOPs 行，行标题 `FLOPs` 被文本层丢掉，只剩裸数字；p.7 正文有 `11.3 billion FLOPs` 的复述 |
| zh-12 | zh | 在那个小图分类数据集上，学习率分别在第几万次迭代下调？训练到多少次迭代停止？ | arXiv:1512.03385 (ResNet) | 7 | We start with a learning rate of 0.1, divide it by 10 at 32k and 48k iterations, and terminate training at 64k iterations, which is determined on a 45k/5k train/val split. | 直述；与 zh-10 互为干扰项 |
| zh-13 | zh | 层数超过一千的那个网络为什么测试结果反而不如一百多层的？作者归因于什么？ | arXiv:1512.03385 (ResNet) | 8 | The 1202-layer network may be unnecessarily large (19.4M) for this small dataset. Strong regularization such as maxout [10] or dropout [14] is applied to obtain the best results | 跨段综合 + **双栏读序断裂**：完整因果句被分在左右两栏，`pdftotext` 输出里右栏先于左栏，句子被切开 |
| zh-14 | zh | 更深的那种瓶颈残差块用了三层卷积，其中两层一乘一的卷积负责做什么？ | arXiv:1512.03385 (ResNet) | 6 | The three layers are 1×1, 3×3, and 1×1 convolutions, where the 1×1 layers are responsible for reducing and then increasing (restoring) dimensions, leaving the 3×3 layer a bottleneck with smaller input/output dimensions. | 直述；同页混着 Table 3/4/5 与 Fig. 5，是全篇文本噪声最重的一页 |
| zh-15 | zh | 在无条件的小图生成任务上，模型拿到的两个生成质量分数分别是多少？ | arXiv:2006.11239 (DDPM) | 1 | On the unconditional CIFAR10 dataset, we obtain an Inception score of 9.46 and a state-of-the-art FID score of 3.17. On 256x256 LSUN, we obtain sample quality similar to ProgressiveGAN. | 直述（摘要）；p.5 的 Table 1 有同两个数字但只以裸数字形式存在；en-05 对照 |
| zh-16 | zh | 实验里扩散过程一共设了多少步？前向过程的方差是按什么规律取值的？ | arXiv:2006.11239 (DDPM) | 5 | We set T = 1000 for all experiments so that the number of neural network evaluations needed during sampling matches previous work [53, 55]. We set the forward process variances to constants increasing linearly from β1 = 10−4 to βT = 0.02. | 跨段综合；两个事实在同一段的首尾，中间隔了一整句解释 |
| zh-17 | zh | 逆过程用的是什么骨干网络？时间步的信息是通过什么方式告诉网络的？ | arXiv:2006.11239 (DDPM) | 5 | To represent the reverse process, we use a U-Net backbone similar to an unmasked PixelCNN++ [52, 48] with group normalization throughout [66]. Parameters are shared across time, which is specified to the network using the Transformer sinusoidal position embedding [60]. | 直述；与 zh-16 同页，检验能否在同页内部选对块 |
| zh-18 | zh | 逆过程的协方差是学出来的还是固定的？作者实验里试了哪两种取值？ | arXiv:2006.11239 (DDPM) | 3 | First, we set Σθ (xt , t) = σt2 I to untrained time dependent constants. Experimentally, both σt2 = βt and | 公式；该页公式密度最高，`ϵ` 在文本层被整体丢弃（`ϵθ` 抽出来只剩 `θ`），可用词面极少 |
| zh-19 | zh | 用真正的变分下界训练和用简化后的目标训练，两者各自更擅长什么？ | arXiv:2006.11239 (DDPM) | 6 | We find that training our models on the true variational bound yields better codelengths than training on the simplified objective, as expected, but the latter yields the best sample quality. | 跨段综合；结论句在 §4.1 末，被 Fig. 3/4 与 Algorithm 3/4 的伪代码块夹在中间；en-06 对照 |
| zh-20 | zh | 在隐空间做插值再解码回来时，人脸的哪些属性会平滑变化？哪一项不会？ | arXiv:2006.11239 (DDPM) | 8 | The reverse process produces high-quality reconstructions, and plausible interpolations that smoothly vary attributes such as pose, skin tone, hairstyle, expression and background, but not eyewear. | 直述；答案末尾的否定项（eyewear）容易被截断丢掉 |
| en-01 | en | What hardware were the base models trained on, and how long did a single training step take? | arXiv:1706.03762 (Transformer) | 7 | We trained our models on one machine with 8 NVIDIA P100 GPUs. For our base models using the hyperparameters described throughout the paper, each training step took about 0.4 seconds. | 对照组，zh-01 的对译 |
| en-02 | en | Why are the dot products scaled by the square root of the key dimension before the softmax? | arXiv:1706.03762 (Transformer) | 4 | We suspect that for large values of dk , the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients | 对照组，zh-05 的对译 |
| en-03 | en | What error rate does the ensemble of residual nets reach on the ImageNet test set, and what did it win? | arXiv:1512.03385 (ResNet) | 1 | An ensemble of these residual nets achieves 3.57% error on the ImageNet test set. This result won the 1st place on the ILSVRC 2015 classification task. | 对照组，zh-08 的对译 |
| en-04 | en | Why does the 1202-layer network perform worse on the test set than the 110-layer one? | arXiv:1512.03385 (ResNet) | 8 | The 1202-layer network may be unnecessarily large (19.4M) for this small dataset. Strong regularization such as maxout [10] or dropout [14] is applied to obtain the best results | 对照组，zh-13 的对译 |
| en-05 | en | What Inception score and FID does the model obtain on unconditional CIFAR10? | arXiv:2006.11239 (DDPM) | 1 | On the unconditional CIFAR10 dataset, we obtain an Inception score of 9.46 and a state-of-the-art FID score of 3.17. On 256x256 LSUN, we obtain sample quality similar to ProgressiveGAN. | 对照组，zh-15 的对译 |
| en-06 | en | Which training objective gives better codelengths, and which gives better sample quality? | arXiv:2006.11239 (DDPM) | 6 | We find that training our models on the true variational bound yields better codelengths than training on the simplified objective, as expected, but the latter yields the best sample quality. | 对照组，zh-19 的对译 |
| cl-01 | zh | 缩放点积注意力的计算式里，softmax 的分母上放的是什么？ | arXiv:1706.03762 (Transformer) | 4 | Attention(Q, K, V ) = softmax( QKT √dk )V | **摘录题**：公式本身。pdf.js 文本层在这里给的是散落的字符，LaTeX 只有摘录里有 |
| cl-02 | zh | 多头注意力的输出是怎么把各个头拼起来再变换的？ | arXiv:1706.03762 (Transformer) | 5 | MultiHead(Q, K, V ) = Concat(head1, ..., headh)W O | **摘录题**：公式本身 |
| cl-03 | zh | 前向扩散过程是怎么按时间步连乘定义的？ | arXiv:2006.11239 (DDPM) | 2 | q(x1:T |x0) := TY t=1 q(xt|xt−1) | **摘录题**：公式本身，含条件概率竖线 |
| cl-04 | zh | 那张模型结构图里，左右两侧各画的是什么，中间靠什么连起来？ | arXiv:1706.03762 (Transformer) | 3 | Figure 1: The Transformer - model architecture. | **摘录题**：图的内容只在图里，文本层只有图题 |
| cl-05 | zh | 那张对比不同层类型的表里，比较了哪几个指标？ | arXiv:1706.03762 (Transformer) | 6 | Table 1: Maximum path lengths, per-layer complexity and minimum number of sequential operations | **摘录题**：表格内容 |
| cl-06 | zh | 残差网络那张结构对比图里，从上到下堆的是什么样的卷积块？ | arXiv:1512.03385 (ResNet) | 4 | Figure 3. Example network architectures for ImageNet. | **摘录题**：图的内容 |
| fu-01 | zh | 基础版模型是在什么硬件上训练的？ ‖ 那训练了多久？ | arXiv:1706.03762 (Transformer) | 7 | We trained our models on one machine with 8 NVIDIA P100 GPUs ... The big models were trained for 300,000 steps (3.5 days). | **追问题**：第二问「那训练了多久」单独看没有任何主题词 |
| fu-02 | zh | 多头注意力一共并行几个头？ ‖ 每个头的维度是多少？ | arXiv:1706.03762 (Transformer) | 5 | In this work we employ h = 8 parallel attention layers, or heads. For each of these we use dk = dv = dmodel /h = 64. | **追问题**：第二问只有「维度」，主题词在上一轮 |
| fu-03 | zh | 注意力打分时为什么要先按维度开根号缩放？ ‖ 不缩放会怎样？ | arXiv:1706.03762 (Transformer) | 4 | We suspect that for large values of dk, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients | **追问题**：第二问「不缩放会怎样」没有可检索的名词 |
| fu-04 | zh | 编码器由多少个相同的层堆叠而成？ ‖ 每层里面有哪两个子层？ | arXiv:1706.03762 (Transformer) | 3 | The encoder is composed of a stack of N = 6 identical layers. Each layer has two sub-layers. | **追问题**：第二问的「每层」指代上一轮 |
| fu-05 | zh | 前向加噪过程是怎么定义的？ ‖ 那反向的呢？ | arXiv:2006.11239 (DDPM) | 2 | The joint distribution p_theta(x_0:T) is called the reverse process, and it is defined as a Markov chain with learned Gaussian transitions | **追问题**：第二问「那反向的呢」四个字，全靠上一轮 |
| fu-06 | zh | 作者把堆叠层要拟合的目标改写成了什么？ ‖ 这样做为什么更容易优化？ | arXiv:1512.03385 (ResNet) | 3 | We hypothesize that it is easier to optimize the residual mapping than to optimize the original, unreferenced mapping | **追问题**：第二问的「这样做」指代上一轮 |
| fu-07 | zh | 基础版模型是在什么硬件上训练的？ ‖ 那要多久？ | arXiv:1706.03762 (Transformer) | 7 | The big models were trained for 300,000 steps (3.5 days). | **退化追问**：整句只剩「多久」，没有任何可检索的名词 |
| fu-08 | zh | 多头注意力一共并行几个头？ ‖ 那它呢？ | arXiv:1706.03762 (Transformer) | 5 | In this work we employ h = 8 parallel attention layers, or heads. | **退化追问**：整句只有指代 |
| fu-09 | zh | 编码器由多少个相同的层堆叠而成？ ‖ 再详细点 | arXiv:1706.03762 (Transformer) | 3 | The encoder is composed of a stack of N = 6 identical layers. Each layer has two sub-layers. | **退化追问**：整句不含任何实词 |
| tg-01 | zh | 读懂了的那段讲了什么？ | arXiv:1512.03385 (ResNet) | 2 | (or unable to do so in feasible time). In this paper, we address the degradation problem | **标签题**：**退化问句**，除了标签名没有任何主题词。ResNet 里 green 只有 p04 一条，无歧义 |
| tg-02 | zh | 我标成读懂了的地方是什么内容？ | arXiv:2006.11239 (DDPM) | 2 | This paper presents progress in diffusion probabilistic models | **标签题**：DDPM 里 green 只有 p01 一条，无歧义 |
| tg-03 | zh | 标成读懂了的那段说了什么？ | arXiv:1706.03762 (Transformer) | 2 | Recurrent neural networks, long short-term memory | **标签题**：Transformer 里 green 只有 p02 一条，无歧义 |
| tg-04 | zh | 标成要点的那些图表都在说什么？ | arXiv:1512.03385 (ResNet) | 4 | VGG-19 / 34-layer plain / 34-layer residual 结构对比图 | **标签题**：yellow 三条里两条在 p.4 |
| na-01 | zh | 这个模型在语音识别任务上的词错误率是多少？ | arXiv:1706.03762 (Transformer) | — | — | 文档答不了。全文无 `speech` / `word error`；结论只把 audio 列为未来工作，是设计好的近似诱饵 |
| na-02 | zh | 这些网络在语义分割数据集上的平均交并比是多少？ | arXiv:1512.03385 (ResNet) | — | — | 文档答不了。全文只把 COCO segmentation 作为比赛名次提了一句，无任何分割指标；`IoU` 仅作检测阈值出现（`mAP @ IoU = 0.5`），是设计好的近似诱饵 |
| na-03 | en | What FID does the model achieve on class-conditional ImageNet 128×128 generation? | arXiv:2006.11239 (DDPM) | — | — | 文档答不了。全文 0 次提及 ImageNet；但满页都是 FID 表格，最易诱发假出处 |

## 统计

- 共 **29** 条：可答 **26** 条（中文 20 + 英文 6），答不了 **3** 条（中文 2 + 英文 1）。
- 按论文：Transformer 9 条（zh 7 + en 2）+ 1 条答不了；ResNet 9 条（zh 7 + en 2）+ 1 条答不了；
  DDPM 8 条（zh 6 + en 2）+ 1 条答不了。
- 按难度：原文直述 12 条，跨段综合 5 条，公式相关 4 条，表格 2 条，其余 3 条为对照组重复难度。
- 六条 `en-*` 与 `zh-01 / zh-05 / zh-08 / zh-13 / zh-15 / zh-19` 一一对应，同页同依据。

## 核对方法

抽文本：`pdftotext -f N -l N <paper>.pdf -`（poppler，`brew install poppler`，v26.08.0）。

每条 `答案依据` 都用脚本核对过两件事：

1. **在标注页存在**——把片段与该页 `pdftotext` 输出都归一化空白（`\s+` → 单空格）后做子串匹配，20/20 命中；
2. **在全文唯一**——同一片段在该论文其余各页均不命中，所以 recall@1 的判定不会因为原文复述而含糊。

三条 `na-*` 用整篇 `pdftotext | grep -i` 反查确认关键事实确实不存在（见各条 `备注`）。

**纪律**：任何无法逐字核对的候选题一律删掉，不入表。宁可条目少，不可条目错。

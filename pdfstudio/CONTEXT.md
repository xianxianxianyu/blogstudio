# PDF Studio

一个 PDF 阅读与理解工具（以学术论文和电子书为主）。读者阅读原始 PDF；每一次 AI 动作——OCR、翻译、chat、写 claim——都由读者显式触发，绝不在后台运行。

## Language

**摘录 (Clip)**:
PDF Studio 的原子单元。读者对 PDF 的某个区域截图；摘录持有双语 markdown——逐字的原文、其译文、从区域抠出的图、以及作为地面真值的整块区域截图——外加一个指回页面的锚点和一条可选笔记。
_Avoid_: 批注（批注只是摘录的笔记）、划词（文字选择）、highlight、卡片

**原文 (Source text)**:
被截取区域的逐字文本。只允许修正 OCR 识别错误——绝不改写。
_Avoid_: 内容、body、正文

**译文 (Translation)**:
摘录原文的翻译。可自由编辑。**可能没有**——纯图摘录没有原文自然没有译文；读者没有为翻译配模型时也不会有。

**截图 (Screenshot)**:
创建摘录的手势：框选一个区域，然后识别它、译出译文。文字区和图片区共用同一个手势（底层两条路由，对读者不可见）。
_Avoid_: 划词（原生文字选择仅用于复制/查词，不进入理解主流程）

**路由 (Route)**:
一个被截取的区域走哪条路被识别：文字区直接读 PDF 的文本层，图片与公式区交给视觉模型。**对读者不可见**——同一个手势，读者不需要知道走了哪条。
_Avoid_: 引擎（这个词已从术语表退休，它同时指过路由和模型来源，两边都容易误会）

**本地模型 (Local model)**:
下载到读者本机、由应用管理的模型权重。与「读者自己配的一个端点地址」不同：本地模型是应用负责下载、存放和启动的那一份。
_Avoid_: 内置模型（不随应用分发，是按需下载的）、离线模型

**锚点 (Anchor)**:
页码 + 坐标，用于在 PDF 内定位一个摘录，让摘录的标签能跳回原文。

**书架 (Bookshelf)**:
读者的 PDF 列表——上传、浏览、打开。与知识库是两回事。
_Avoid_: 库、library、知识库

**知识库 (Knowledge base)**:
跨 PDF 的 context 聚合，由 PDF Studio 产出、Blog Studio 消费。
_Avoid_: 书架、library

**入库 (Promote)**:
把摘录变成 context 的动作：其原文成为 evidence，补上 claim 和 stance（stance 由读者标，claim 由 AI 按需补），进入知识库供 Blog Studio 消费。
_Avoid_: 保存、export、导出

**chat (问文档)**:
单文档问答：答案来自全文检索，加上读者贴进对话的摘录和图片。绝不跨 PDF。
_Avoid_: 对话、RAG（那是机制，不是概念）

**context (Context Item)**:
与 Blog Studio 共享：一条带来源的 claim——`{ source, claim, evidence, stance, status }`。PDF Studio 通过入库产出它；Blog Studio 把它当作素材消费。
_Avoid_: 材料、material、source

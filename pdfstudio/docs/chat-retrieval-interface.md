# Chat + Retrieval 接口（定稿）

## 起因

`Recognizer` 定稿后，按 `architecture.md` 的加深顺序轮到 `Chat` + `Retrieval`。这里有一个比 Recognizer 更根本的问题要先答：

**`Retrieval`（全文索引 + 搜索）到底是不是一个独立模块？**

因为今天只有 `Chat` 调它。按 codebase-design 的 seam 纪律——**一个 adapter = 假想缝**——它可能只是 `Chat` 的内部实现；也可能要独立成模块，给将来的知识库（跨 PDF 检索）、书架（全文搜索）复用。这就是「内部缝」三个字的来历：它问的是"这条缝该不该对外开"。

## 经过（谁干了什么）

派了 3 个 subagent，各给一个相反的约束，押不同方向：

| 谁 | 约束 | 产出 | 立场 |
|---|---|---|---|
| Agent 1 | 接口最小 | `design-chat-retrieval-minimal.md` | Chat = 一个 `ask` + 一个模型端口；Retrieval 降为**内部缝**；回答带 `grounding` 诚实字段；索引首次 ask 懒加载 |
| Agent 2 | 最大复用 | `design-chat-retrieval-reusable.md` | Retrieval 提为**一等模块**（`openIndex`+`Index`）；`IndexSource` union（PDF 字节｜已定位文本）让知识库/书架复用同一套索引 |
| Agent 3 | 最顺默认 | `design-chat-1-common-caller.md` | `createChat` 绑定单文档（类型层面保证）+ 复用 Recognizer 的 `ModelClient` 端口 + 引用出处 |

主 agent（我）读三分，按深度 / 局部性 / 缝位置对比。

## 结果

- **Agent 1 与 Agent 3 独立收敛到同一件事**：Retrieval 是内部缝，不是独立模块。Agent 2 是唯一主张独立的，理由是"知识库/书架是会来的第二个调用方"。
- **判 Agent 1 胜**：知识库和服务器在路线图里都是「后面的事」，为一个还没发生的调用方开外部缝，正是 seam 纪律要删的 indirection。Agent 1 还留好了提级路径——内部 `index`/`search` 签名照旧，将来真出现第二个调用方时原样提级、测试照搬，接口不变。
- 掺两味：① **复用 Recognizer 的 `ModelClient` 端口**（Agent 3 的点子，全应用一个模型端口，HTTP + mock 两个 adapter 已存在）；② **记下 Agent 2 的 `IndexSource` union 作为提级时的形状**，现在不付税。

## 定稿接口（具体，不抽象）

```ts
// —— 共享模型契约 ——
// ModelMessage / ModelImage / ModelRequest / ModelResponse / ModelChunk / ModelClient
// 统一见 ADR-0009；Chat 使用 model.streamComplete(request)，最终化后返回 Answer。
// 贴入的 ClipSnapshot / Screenshot 在 Chat 内部转换为 ModelRequest。

// —— 一个 Chat 实例绑定一个文档（单文档是类型层面保证，不可能串文档）——
interface Chat {
  ask(turns: Turn[]): Promise<Answer>;
  reindex(): Promise<void>;          // rare 逃生口：OCR 修正 / 换切块策略后重建
}
function createChat(deps: { document: PDFDocumentProxy; docId: string; model: ModelClient }): Chat;

// —— 一轮对话：文字 + 可选贴入的摘录/图（快照）——
interface Turn { role: 'user' | 'assistant'; parts: Part[] }
type Part =
  | { kind: 'text'; text: string }
  | { kind: 'clip'; snapshot: ClipSnapshot }
  | { kind: 'image'; image: Screenshot };

interface ClipSnapshot {          // 贴入时刻的深拷贝，此后编辑不回写
  clipId: string;
  sourceText: string;            // 原文快照
  translation?: string;
  image?: Screenshot;
  page: number;
  note?: string;
}

// —— 回答：正文 + 结构化出处 + 诚实字段 ——
interface Answer {
  text: string;
  citations: Citation[];
  grounding: 'retrieved' | 'pasted' | 'none';   // 无依据必须 'none'，禁止编造
}
interface Citation {
  kind: 'chunk' | 'clip';        // 来自全文检索块 还是 贴入摘录
  page: number;                  // 可跳回 PDF 页
  snippet?: string;              // 仅 kind='chunk'
  clipId?: string;               // 仅 kind='clip'
}
```

**用法（真实流程）：**

```ts
const chat = createChat({ document: pdfDoc, docId: 'paper-1512', model: modelClient });

// 打开 PDF → 问（第一问内部自动：读序→分块→embed→FTS5，索引懒加载）
const a = await chat.ask([
  { role: 'user', parts: [{ kind: 'text', text: '这篇的方法用了什么数据集？' }] },
]);
// a.grounding === 'retrieved'；a.citations → [{ kind:'chunk', page:3, snippet:'…' }, …]

// 贴摘录 + 图 + 问（同一个入口，快照直接拼进上下文，不进索引）
const a2 = await chat.ask([
  { role: 'user', parts: [
    { kind: 'text', text: '这段公式的假设是什么？' },
    { kind: 'clip', snapshot: clipSnapshot },
    { kind: 'image', image: formulaPng },
  ]},
]);
// a2.grounding === 'pasted'（如果只基于贴入内容）

// 没有依据时：模型不得编造，grounding 标 'none'
```

**藏在 `ask` 后面的（内部缝，调用方永远看不见）：** 双栏阅读顺序还原（pdf.js 坐标）、结构递归切块、bge-m3 embedding + FTS5 hybrid 打分、`ModelRequest` 组装、`streamComplete` 消费与 `ModelChunk` 累积、prompt 组装、citation 解析、`grounding` 判定。

**不变量：** ① 单文档封闭（绝不读写 `docId` 以外的索引）；② 快照语义（贴入是深拷贝）；③ 纯被动无会话状态（历史由调用方传入）；④ 幂等索引（内容哈希只建一次）；⑤ 诚实性（`grounding` 独立于模型输出判定）；⑥ `ask` 只 reject 模型失败或契约违反，其余一律降级成合法 `Answer`。

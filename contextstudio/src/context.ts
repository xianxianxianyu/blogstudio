/**
 * `context (Context Item)` 的**规范定义**。
 *
 * 术语见 `contextstudio/CONTEXT.md`。这个类型跨三个 context 共享：Blog Studio 的领域造出它，
 * PDF Studio 在入库时产出它，知识库存放它并把它连成图。
 *
 * 它住在这里而不是 PDF Studio 里，是因为知识库是第三个系统
 * （`docs/adr/0001-shared-knowledge-base.md`）——PDF Studio 只是产出方之一。
 * `pdfstudio/src/knowledge/context.ts` 目前有一份自己的副本，等 pdfstudio 那条线程
 * 的在途改动落地后应改为从这里导入（见 `.scratch/knowledge-graph/issues/01`）。
 */
/**
 * 一条 context 的出处。
 *
 * **不是字符串。** 之前是 `"page 3"`——在跨 PDF 的知识库里，不带文档名的页码等于没有出处，
 * 而「可回跳」是 context 的硬标准之一。`docs/workflow.md` §2.1 当初设计的就是结构化的，
 * 代码一度把它压扁了。
 */
export interface Source {
  /**
   * 哪份文档。也是 `ContextStore.ingest` 的定域依据——一批导入属于哪个文档，
   * 决定了「库里有、这批没有」的那些算不算来源被删。
   *
   * 泛指一个来源的标识：PDF 用书架里的 docId，将来的网页来源可以直接用 URL。
   */
  docId: string;
  title: string;
  /** 回跳用的定位：页码、章节。 */
  locator: string;
}

export interface Context {
  id: string;
  /** 指回产出它的摘录。摘录被删后 id 仍留着，配合 sourceClipDeleted 说明来源去向。 */
  sourceClipId: string;
  source: Source;
  claim: string | null;
  /** 逐字原文，不允许改写——转述发生在消费端，不在入库端。 */
  evidence: string;
  stance: "support" | "refute" | "neutral" | null;
  status: "pending" | "approved" | "rejected" | "disputed";
  sourceClipDeleted: boolean;
  /**
   * 这条 context 讲的是什么。知识图的边由它产生（`contextstudio/docs/adr/0002`）。
   *
   * **不叫 `tags`**：`tag` 在 PDF Studio 已经指摘录的颜色分类，见 `CONTEXT-MAP.md`
   * 的同名词表。**可以是空数组**——想不出主题不该阻断入库，空主题的 context 就是孤儿。
   */
  topics: string[];
}

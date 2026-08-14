/**
 * `context (Context Item)` —— **跨边界的共享类型**。
 *
 * 按 `CONTEXT-MAP.md`：这个术语起源于 Blog Studio 的领域，PDF Studio 在入库时产出它。
 * 知识库是**第三个系统**，两个产品都不拥有它，都读写它（`docs/adr/0001-shared-knowledge-base.md`）。
 *
 * 所以它不住在 `clip.ts` 里：Clip 是 PDF Studio 的内部概念，而这一条是**交出去的东西**。
 * 放在这里是为了让「改动它会波及另一个产品」这件事在目录结构上就看得见。
 */
export interface Context {
  id: string;
  /** 指回产出它的摘录。摘录被删后 id 仍留着，配合 sourceClipDeleted 说明来源去向。 */
  sourceClipId: string;
  source: string;
  claim: string | null;
  evidence: string;
  stance: "support" | "refute" | "neutral" | null;
  status: "pending" | "approved" | "rejected" | "disputed";
  sourceClipDeleted: boolean;
}

/**
 * PDF Studio 交出 context 的**出站端口**。
 *
 * 知识库本身不在 PDF Studio 范围内——它是第三个系统。PDF Studio 的职责到「交出一条
 * context」为止，怎么存、怎么查、Blog Studio 怎么消费，都在这条缝的另一侧。
 *
 * **尚无实现**，也不该在这里实现：给它写一个 adapter 需要先有知识库。这个声明的作用
 * 是把边界钉在代码里——`Clip` 的 reducer 产出 `Context` 之后，接下来交给谁，一眼可见。
 *
 * `Clip` 保持纯 reducer、无 I/O，所以调用这个端口的是应用层，不是 reducer 自己。
 */
export interface ContextSink {
  publish(context: Context): Promise<void>;
  /** 来源摘录被删时通知知识库——context 本身保留，只标出来源没了（clip-interface.md 的定案）。 */
  markSourceDeleted(contextId: string): Promise<void>;
}

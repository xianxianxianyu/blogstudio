import type { Capability } from "../config/config";

/**
 * 设置项归谁。
 *
 * 这个文件回答一个问题：**哪些设置是三侧共用的，哪些属于某一侧。**
 *
 * 答案分两半，而且第二半是反直觉的那一半：
 *
 * 1. **端点是共用的，而且本来就是共用的。** 「Book 的设置和 Context、Writer 的不
 *    互通」是个错觉——三侧读的一直是同一个 `config.json`。真正的毛病是界面把这一份切开
 *    摆了（外壳左下角一个入口、阅读页顶栏又一个），还漏掉了几个能力（`chat` 在用却没
 *    有入口，`embedding` 有入口却不接线）。所以修法不是「把三份设置合并」，是**让这
 *    一份只有一个说法**。
 * 2. **能力是按任务切的，不是按产品切的**（ADR-0010）。识别、翻译归 Book，写作助手
 *    归 Writer，但它们都配在同一页上、回退到同一个默认组。按产品分栏的话，「同一个
 *    端点、写作换个更大的模型」这种最常见的配法就得把地址和 key 再抄一遍。
 *
 * 剩下的才是真正**属于某一侧**的：标记名和自动清理只作用于摘录（Book），
 * 「这本书的目录」连一侧都不属于——它属于手上这一本书。
 *
 * **这一层不认识任何领域类型**，与 `desk.ts` 同一条规矩（ADR-0003）：它只说「哪一块画
 * 在哪一页」，那一块里面长什么样是各侧自己的事。
 */

/** 设置这一根下面的一页。 */
export type SettingsPage = "model" | "book" | "context" | "writer";

/** 用某个能力的是哪一侧。**「模型」不是一侧**——它是三侧共用的那一份。 */
export type Side = Extract<SettingsPage, "book" | "context" | "writer">;

/** 一页上画的一块。 */
export type SettingsBlock = "endpoints" | "tags" | "retention" | "outline";

export interface PageSpec {
  id: SettingsPage;
  /** 侧栏上写的那几个字。 */
  title: string;
  /**
   * 这一页一块可配项都没有时说的话。**空页面比错页面好，沉默的空页面不行**——
   * 读者会以为是没加载出来，然后反复点它。有可配项的页面不需要这一句。
   */
  empty?: string;
}

/**
 * 四页，**共用的那一页排在最前**——它是其余三页回退的地基，读者第一眼该看见它。
 */
export const SETTINGS_PAGES: PageSpec[] = [
  { id: "model", title: "模型" },
  { id: "book", title: "Book" },
  {
    id: "context",
    title: "Context",
    // 都不是「还没做」，是「不该是旋钮」：库跟着应用数据目录走，模块度是量出来的
    // 结果（`contextstudio/docs/adr/0005`），调阈值只会把不该分开的分开。
    empty: "知识库没有可配的东西。库存在应用数据目录里；聚类是算出来的，不是调出来的。写 claim 用的模型接线之后会出现在「模型」那一页。",
  },
  {
    id: "writer",
    title: "Writer",
    // 写作助手用的端点在「模型」那一页——它是个能力，不是 Writer 的私产。
    empty: "写这一侧还没有自己的设置。写作助手用哪个模型在「模型」那一页配。",
  },
];

/** 此刻手上有什么。设置页要不要画某一块，有时取决于它。 */
export interface At {
  /** 案头上正活着一本书。「这本书的目录」那一块只在这时有的可施。 */
  bookOpen: boolean;
}

/**
 * 谁在用这个能力。
 *
 * **空数组是不允许的**（`settings-map.test.ts` 守着这条）：没人用的能力就是一个点了
 * 不生效、也不报错的旋钮。`embedding` 和 `claim` 在那个位置上待过很久，谁都没发现。
 * 界面拿这份表在每个能力旁边标出「谁在用」——读者改「问文档」之前，得先知道改的是谁。
 */
export function usersOf(capability: Capability): Side[] {
  return USERS[capability];
}

const USERS: Record<Capability, Side[]> = {
  recognition: ["book"],
  translation: ["book"],
  /** 问文档：单文档问答，绝不跨 PDF（`pdfstudio/CONTEXT.md`）。 */
  chat: ["book"],
  /** 写作助手：材料是正在写的稿子 + 从知识库召回的 context，与问文档是两件事。 */
  writing: ["writer"],
};

export function blocksOf(page: SettingsPage, at: At): SettingsBlock[] {
  if (page === "model") return ["endpoints"];
  if (page !== "book") return [];
  return at.bookOpen ? ["tags", "retention", "outline"] : ["tags", "retention"];
}

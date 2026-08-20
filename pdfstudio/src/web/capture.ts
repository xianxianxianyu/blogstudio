import { pageIdOf } from "./page-id";

/**
 * 一条网页摘录的**证据**——锚点找不回去之后还剩下的东西。
 *
 * `docs/research-web-anchoring.md` §5.7 档 2 的那句话是这一整个模块存在的理由：
 *
 * > 它不提高锚定成功率，它降低锚定失败的代价。而既然「成功率没人量过」，
 * > 降低失败代价是比提高成功率更可靠的投资。
 *
 * 这也正是规范给「文档会变」开的药方（`State` / `TimeState`）和 ODU 那篇论文的结论：
 * *"This points to the need for archiving the target of an annotation at the time
 * the annotation is created."*
 *
 * **我们比 Hypothesis 有条件做这件事**：它是 Web 服务，存不起每条标注的截图和快照；
 * 我们是本地应用，截图本来就在存。
 */
export interface WebRecord {
  /** 判定「是不是同一页」用。**不能拿来回跳**——它被归一化过。 */
  pageId: string;
  /** 真正访问到的地址，跟完重定向、一字不改。回跳用这个。 */
  url: string;
  title: string;
  /** 抓取时的视口宽度。`0` = 不知道。响应式重排之后，矩形只有配上它才有意义。 */
  viewportWidth: number;
  at: number;
  /** 当时的正文纯文本。orphan 之后唯一能「在当时的页面里重新搜」的东西。 */
  snapshot: string;
  /** 快照被截断过没有。**明说，不让下游靠长度去猜**。 */
  snapshotTruncated: boolean;
}

/**
 * 快照上限。几十 KB 一页对本地应用可忽略，但**得有个上限**——有些页面（无限滚动的
 * 列表、整本书的单页版）会把正文撑到几 MB，而那时快照已经不再是「这一页」了。
 */
export const MAX_SNAPSHOT = 200_000;

export function recordOf(input: {
  visitedUrl: string;
  /** 跟完重定向之后的地址。短链接把 `visitedUrl` 原样存下来等于没存。 */
  finalUrl: string;
  title: string;
  viewportWidth: number;
  at: number;
  text: string;
}): WebRecord {
  const url = input.finalUrl || input.visitedUrl;
  const width = Number.isFinite(input.viewportWidth) && input.viewportWidth > 0 ? input.viewportWidth : 0;

  return {
    pageId: pageIdOf(url),
    url,
    title: input.title.trim(),
    viewportWidth: width,
    at: input.at,
    snapshot: input.text.slice(0, MAX_SNAPSHOT),
    snapshotTruncated: input.text.length > MAX_SNAPSHOT,
  };
}

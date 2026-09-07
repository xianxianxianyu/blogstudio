import { isDiagram, serial } from "../../src/app/code-preview";

/**
 * 把 ```mermaid 代码块下面那块预览画成图。
 *
 * 这是适配器：**`isDiagram` 和那条队伍在 `src/app/code-preview.ts` 里**，
 * 那两件事不碰 DOM，能在 Node 里测；这里只剩「怎么叫 mermaid」。
 */

/**
 * mermaid 是懒加载的。
 *
 * 它压出来两百多 KB，而**绝大多数稿子里一张图都没有**——跟着编辑器一起加载，等于让每次
 * 打开稿子都为一个多数人不用的功能付钱。写成动态 import 之后它是单独一个 chunk，
 * 第一次真的出现 ```mermaid 才去读。
 *
 * 记住的是 Promise 不是模块：同一拍里三个代码块一起要它，存模块会发三次请求。
 */
let loading: Promise<typeof import("mermaid")> | null = null;

const engine = () => {
  loading ??= import("mermaid").then((mod) => {
    mod.default.initialize({
      startOnLoad: false,
      /**
       * **图里的文字来自稿子，而稿子的内容不一定是读者自己写的**——从网页摘的、Loop
       * 的 agent 生成的，都会落进来。`strict` 关掉 mermaid 对 HTML 标签的解释。
       * （Milkdown 那边还会再过一道 DOMPurify，两道都要，因为这两道谁都可能被换掉。）
       */
      securityLevel: "strict",
      /**
       * 不跟随系统深浅——**要跟随的是代码块**。图是一张画，把画反相不叫配色：
       * 手工染过色的节点（`style A fill:#f9f`）反完就是另一个意思。
       */
      theme: "neutral",
      // 写字面值不写 `var(--sans)`：mermaid 要**先量文字再定节点大小**，量的时候
      // 用的是它自己建的隐藏节点，那儿解析不到稿子上下文里的变量，量出来会偏。
      fontFamily: '-apple-system, "PingFang SC", system-ui, sans-serif',
    });
    return mod;
  });
  return loading;
};

/** 每张图要一个自己的 id，mermaid 拿它当临时节点的名字。 */
let seq = 0;

/**
 * 画一张图，或者说清楚为什么画不出来。
 *
 * **画不出来不能什么都不显示**：正在打的图有一多半时间是语法不完整的，那时候空白会被
 * 读成「坏了」。所以错误也是一种结果，照样交回去显示。
 */
async function draw(source: string): Promise<string> {
  const { default: mermaid } = await engine();
  // 先 parse 再 render：`suppressErrors` 让语法不全的时候拿到 false 而不是抛异常，
  // 而 render 抛出来的那一路会往 document.body 上留一个孤儿节点。
  const ok = await mermaid.parse(source, { suppressErrors: true });
  if (!ok) return oops("这张图还读不通");
  try {
    const { svg } = await mermaid.render(`draft-mermaid-${++seq}`, source);
    return svg;
  } catch (error) {
    return oops(error instanceof Error ? error.message : String(error));
  }
}

const oops = (why: string) =>
  `<p class="diagram-oops">${why.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>`;

/**
 * 全局一条队伍。一次只画一张图。
 *
 * 不按「块」分队，是因为**没有东西能当一块的身份**：Milkdown 每次 watch 跑都新建一个
 * `applyPreview` 闭包传进来，拿它当 key 是永远命中不了的（我先按这个前提写过一版，
 * 那道闸等于没装）。而排队根本不需要身份。
 */
const line = serial();

/**
 * 接给 Milkdown code-block 的 `renderPreview`。它的三种返回值各有意思：
 *
 * - `null` —— 这一块没有预览。预览面板和那个切换按钮都不出现（普通代码块走这一路）。
 * - 字符串 / 元素 —— 立刻显示。
 * - `undefined` —— 异步：先显示 loading，等 `applyPreview` 送结果来。
 */
export function renderDiagram(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): void | null {
  if (!isDiagram(language) || content.trim() === "") return null;
  void line(() => draw(content)).then(applyPreview);
  return undefined;
}

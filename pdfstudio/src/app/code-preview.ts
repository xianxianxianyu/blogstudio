/**
 * 代码块下面那块预览要不要画、画的时候怎么不被自己的上一次盖掉。
 *
 * 放在这一层是因为**这两件事都不碰 DOM，也不认识 mermaid**——真正调 mermaid 的适配器在
 * `app/react/` 里。这一路上的 bug 有大半出在接线而不是算法上，能在 Node 里测的就别留在
 * 视图里（ADR-0013）。
 */

/**
 * 哪些语言画成图。
 *
 * **用查表不用 `language === "mermaid"`**：加第二种图（plantuml、graphviz）时，
 * 三元判断不报错，只是那一种默默不画。这张表跟 `ICON` / `KEPT` / `ROOTS` 同一手。
 */
const DIAGRAM: Record<string, true> = { mermaid: true };

export const isDiagram = (language: string): boolean =>
  // **`=== true` 不能省。** 光写 `DIAGRAM[name]` 的话，`"constructor"`、`"toString"`
  // 这些名字会从 Object 的原型上拿到一个真值——一个叫 constructor 的代码块会被
  // 当成图去渲染，然后 mermaid 在一段 JS 上抛错。查表天生带这个洞。
  DIAGRAM[language.trim().toLowerCase()] === true;

/**
 * 排队：一次只做一件，按调用顺序做完。
 *
 * 为什么需要：预览是**每次按键都重算**的（Milkdown 的 code-block 组件 watch 的是正文与
 * 语言）。mermaid 画一张图要几十毫秒，且跟图的大小有关——**大图开始得早、结束得晚**，
 * 于是「删掉两个节点」的那次会先回来，「原来那张大图」后回来把它盖掉。屏幕上的表现是
 * 图跟正文对不上，再按一个键它又对了，最难查的那一类。
 *
 * 为什么是排队而不是「只认最后一次」：**认最后一次得先认得出「同一块」**，而 Milkdown
 * 每次都新建一个 `applyPreview` 闭包传进来，没有任何东西能当那一块的身份。排队不需要身份
 * ——按顺序做完，结果就不可能倒过来，而且顺带避开了 mermaid 共用一个临时 DOM 节点的重入。
 *
 * `catch(() => {})` 那一下不是吞异常：异常照样从返回的 promise 抛给调用方，这里接的是
 * **队伍自己的那根链**。不接的话一件画不出来的图会让后面所有的图永远停在「渲染中」，
 * 而且一声不吭。
 */
export function serial(): <T>(run: () => Promise<T>) => Promise<T> {
  let line: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const mine = line.then(run);
    line = mine.catch(() => {});
    return mine;
  };
}

/**
 * 文章在去处那边叫什么名字（文件名，也就是 URL 的最后一截）。
 *
 * **不引拼音库。** 那个博客的内容目录里现在全是拼音文件名，那是从 Halo 搬过来时脚本
 * 生成的；而它的静态产物里本来就有 `WSL2搭建cuda-triton开发环境.html` 这种中文名字，
 * 说明中文 URL 在这套东西上是通的。为了让默认值更好看去背一个词典依赖不划算——
 * **而且这个名字只在第一次送出去时用得上**，之后靠记下来的映射走，改也只改一次。
 */

/** 当分隔符看的东西：空白、下划线，以及所有会把名字变成一条路径的记号。 */
const SEPARATOR = /[\s_/\\:*?"<>|#%]+/g;

export function slugOf(title: string): string {
  return (
    title
      .toLowerCase()
    // 路径记号**变成短横而不是删掉**：删掉会把 `a/b` 压成 `ab`，两篇不同的文章可能
    // 因此撞成同一个名字，而撞名的后果是后一篇静悄悄盖掉前一篇。
      .replace(SEPARATOR, "-")
      // 点只在名字中间留着（`v1.2` 这种）。开头的点是隐藏文件，结尾的点在 Windows 上非法。
      // **首尾的空白不用先 trim**：上一行已经把它们变成短横，这一行连着一起去掉了。
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/-{2,}/g, "-")
  );
}

/**
 * 这个名字能不能用来落一个文件。**返回一句人话，不是布尔**——「不行」本身帮不上忙，
 * 界面上要显示的是为什么不行。
 *
 * 与 `draft-store.ts` 的 `fileOf`、`loop-store.ts` 的 `safe` 是同一条规矩：不是防谁，
 * 而是别让一个坏名字静静地写到目录外面去。这里更要紧一点——**那个目录是你的博客仓库**，
 * 写飞了是往别人的源码里落文件，而且跟着就 commit 了。
 */
export function slugProblem(slug: string): string | null {
  if (slug === "") return "名字是空的";
  if (/[/\\]/.test(slug)) return "名字里不能有 / 或 \\——它只是文件名，放哪儿由去处决定";
  if (slug === "." || slug === ".." || slug.startsWith(".")) return "名字不能用点开头";
  if (slug.endsWith(".md")) return "不用写 .md，送出去时自己会接上";
  return null;
}

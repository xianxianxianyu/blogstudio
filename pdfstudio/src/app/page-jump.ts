/**
 * 顶栏那个页码框里输的东西，落到第几页。
 *
 * **这里说的是物理页码**——PDF 里实际的第几页，就是顶栏一直显示的那个数。不是书页上
 * 印的那个（`pdfstudio/CONTEXT.md`：两者差一个偏移，混了整本书的跳转会整体歪掉，
 * 而且不报任何错）。按印刷页码跳是目录那条路的事，不是这个框的事。
 *
 * 两种输入分得很开：
 *
 * - **不是整数就返回 `null`，一步都不动。** 直接算 `Math.min(pages, Math.max(1, Number(text)))`
 *   的话，非数字会得到 NaN，而 NaN **通过**下游所有比较——渲染那侧不报错，只给一片
 *   空白，顶栏还照样显示「NaN / 654」。这一类坏法一点声音都没有。
 * - **超出范围则贴到最近的边界。** 输 9999 的人是想去最后，输 0 的人是想去开头；
 *   两者都不是错误输入，只是没算准。把他送到边界上比什么都不做更接近他要的，
 *   而且这一下是看得见、也随手能改回来的。
 */
export function pageFrom(text: string, pages: number): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const asked = Number(trimmed);
  // `Number.isInteger` 一并挡掉 NaN、Infinity 和 12.7——"12.7 页"没有对应的一页，
  // 截成 12 是我们替他做主，不如不动。
  if (!Number.isInteger(asked)) return null;

  return Math.min(pages, Math.max(1, asked));
}

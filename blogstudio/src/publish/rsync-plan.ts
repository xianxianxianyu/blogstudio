/**
 * 把 `rsync --dry-run --itemize-changes` 的输出读成「这次会新增/改动/删除什么」。
 *
 * **差异问 rsync 自己要，不自己算。** 它就是干这个的；我们的算法跟它不一致的那一刻，
 * 屏幕上说的和磁盘上发生的就是两回事——而这一件事里有一半是**删除**。
 *
 * 输出格式（实测 openrsync 与 GNU rsync 一致的那部分）：
 *
 * ```
 * >f+++++++ blog/新增的.html      第 1 位 `>` = 真的要传；3–9 位全是 `+` = 这是新的
 * >fcst.... blog/改过的.html      同样要传，但不是全新 = 改动
 * .f..t.... blog/没变的.html      第 1 位 `.` = 不传，只对齐属性 —— 不算数
 * cd+++++++ blog/子目录/          第 2 位 `d` = 目录 —— 不算数
 * *deleting blog/要删的.html      删除。**同一条会打两遍**
 * ```
 */

export interface Changes {
  added: string[];
  changed: string[];
  deleted: string[];
}

/** `*deleting ` 后面全是路径（路径里可能有空格）。 */
const DELETING = /^\*deleting {1,2}(.+)$/;
/**
 * 九位状态码 + 一个空格 + 路径。
 *
 * 第 1 位是**动作**（`>` 收下、`.` 只对齐属性、`c` 新建），第 2 位是**类型**
 * （`f` 文件、`d` 目录、`L` 符号链接），后七位是哪些属性变了。
 */
const ITEM = /^([<>.ch])([fdLDS])(.{7}) (.+)$/;

export function parseChanges(output: string): Changes {
  const added: string[] = [];
  const changed: string[] = [];
  const deleting: string[] = [];

  for (const line of output.split("\n")) {
    const gone = DELETING.exec(line);
    if (gone) {
      deleting.push(gone[1]!);
      continue;
    }

    const item = ITEM.exec(line);
    // 看不懂的行直接跳过：rsync 会夹带 `sending incremental file list`、统计行之类，
    // 把它们塞进任何一档都会让数字变成假的。
    if (!item) continue;

    const [, action, kind, attrs, file] = item as unknown as [string, string, string, string, string];
    // **目录不是文件。** 加一篇文章会顺带建出一堆目录，算进去只是噪音。
    if (kind === "d") continue;
    // **第 1 位是 `.` 表示内容没变**，只是把 mtime / 权限对齐一下。Hugo 每次全量
    // 重建都会刷新所有 mtime，算进去的话每次部署都显示「几百个文件改动」，
    // 然后人就不看了。（适配器必须传 `-c`，否则 rsync 判「变没变」只看大小和时间，
    // 这一档会永远是满的。）
    if (action === ".") continue;

    // 3–9 位全是 `+` = 那边根本没有这个文件。
    (attrs === "+++++++" ? added : changed).push(file);
  }

  return { added, changed, deleted: foldDeletions(deleting) };
}

/**
 * 删除清单收干净：去重，并且把「另一条删除项的上级目录」折叠掉。
 *
 * 两件事都是实测逼出来的：
 *
 * 1. **同一条 `*deleting` 会打两遍**（openrsync 干跑时如此）。不去重的话「会删掉 4 个」
 *    而其实是 2 个。
 * 2. 删掉一整个目录时，目录自己和它里面每个文件各来一条。目录那条留着会让数字翻倍，
 *    而且它说的不是「一个文件」。**留文件，因为要回答的是「会删掉哪些文件」。**
 */
function foldDeletions(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((one) => !unique.some((other) => other.startsWith(`${one}/`)));
}

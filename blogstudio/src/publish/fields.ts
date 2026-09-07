/**
 * 改 frontmatter 里的某几个键，**别的一个字都不动**。
 *
 * 这是整个「管理文章」功能的地基：改 tag、上架下架，本质上都是改这里的一行。
 *
 * **不解析 YAML，按行改。** 不是为了省依赖：解析再序列化会把注释、引号风格、键的顺序
 * 全部重排一遍，diff 上就是整块 frontmatter 都变了——而那正是「我到底改了什么」
 * 最需要看清楚的地方。那 92 篇里 47 篇有 `categories`、46 篇有 `tags`，
 * 还有 PaperMod 的 `cover:`（它底下嵌着一个 `title:`）。
 */

/** 顶层的 `key: value`。**行首不能有空白**——缩进的是别的键底下的。 */
const TOP = /^([A-Za-z_][\w-]*)\s*:(.*)$/;

/**
 * 这一行是不是上一个键的**续行**。
 *
 * 两种都是合法 YAML，都要认：
 *
 * ```yaml
 * tags:        tags:
 *   - a        - a
 * ```
 *
 * 认不出来的后果很难查：换掉 `tags:` 那一行之后，`- a` 变成孤儿，YAML 直接坏掉，
 * 而 Hugo 报的错跟这件事看不出关系。
 */
const CONTINUES = (line: string): boolean => /^\s+\S/.test(line) || /^-\s/.test(line);

interface Split {
  before: string[];
  front: string[] | null;
  after: string[];
}

/** 拆成「frontmatter 的那几行」与「其余」。没有 frontmatter 时 `front` 是 null。 */
function split(text: string): Split {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { before: [], front: null, after: lines };
  // **只认第一个收尾的 `---`**：正文里的分隔线不算。
  const end = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
  if (end === -1) return { before: [], front: null, after: lines };
  return { before: [], front: lines.slice(1, end), after: lines.slice(end + 1) };
}

/** 读出顶层那几个键的原始值（**不去引号、不解析**，值原样是什么就是什么）。 */
export function readFields(text: string): Record<string, string> {
  const { front } = split(text);
  const out: Record<string, string> = {};
  for (const line of front ?? []) {
    const hit = TOP.exec(line);
    // 第一次出现的那个算数：同名键在 YAML 里本来就该只有一个。
    if (hit && !(hit[1]! in out)) out[hit[1]!] = hit[2]!.trim();
  }
  return out;
}

/**
 * 写回若干个键。值是**已经序列化好的 YAML 标量**（`"带引号的串"`、`true`、`[a, b]`），
 * 这一层不替你决定怎么写——tags 用行内还是块状是调用方的事。
 */
export function putFields(text: string, fields: Record<string, string>): string {
  const { front, after } = split(text);
  const todo = new Map(Object.entries(fields));

  const kept: string[] = [];
  let dropping = false;
  for (const line of front ?? []) {
    // 正在丢弃某个键的续行。
    if (dropping) {
      if (CONTINUES(line)) continue;
      dropping = false;
    }
    const hit = TOP.exec(line);
    const key = hit?.[1];
    if (key !== undefined && todo.has(key)) {
      kept.push(`${key}: ${todo.get(key)!}`);
      todo.delete(key);
      // 这个键原来可能是块状的（`tags:` 后面跟几行 `- x`），那几行要跟着一起走。
      dropping = true;
      continue;
    }
    kept.push(line);
  }
  // 原来没有的键补在末尾——补在开头会把 `title` 挤到第二行，看着像换了个文件。
  for (const [key, value] of todo) kept.push(`${key}: ${value}`);

  const body = front === null ? ["", ...after] : after;
  return ["---", ...kept, "---", ...body].join("\n");
}

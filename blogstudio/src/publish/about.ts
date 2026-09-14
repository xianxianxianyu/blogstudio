export type AboutLanguage = "zh-cn" | "en";
export interface Direction {
  id: string;
  title: string;
  goal: string[];
  done: string[];
  problem: string[];
  note: string;
}
export interface AboutContent {
  title: string;
  intro: string;
  currentTitle: string;
  current: string[];
  directionsTitle: string;
  directions: Direction[];
  contactTitle: string;
  links: { label: string; text: string; url: string }[];
}
export interface AboutView {
  revision: string;
  content: Record<AboutLanguage, AboutContent>;
}

export function aboutLanguage(value: unknown): AboutLanguage {
  if (value === "zh-cn" || value === "en") return value;
  throw new Error("请选择中文或 English");
}

/** 只接受表单定义的字段；链接限制在公开网页和邮件地址。 */
export function aboutContent(value: unknown): AboutContent {
  const obj = (v: unknown): Record<string, unknown> => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("About 内容格式不正确");
    return v as Record<string, unknown>;
  };
  const str = (v: unknown): string => {
    if (typeof v !== "string" || v.length > 20000) throw new Error("About 字段须为不超过 20000 字的文本");
    return v;
  };
  const list = (v: unknown): unknown[] => {
    if (!Array.isArray(v) || v.length > 100) throw new Error("About 列表最多 100 项");
    return v;
  };
  const lines = (v: unknown) => list(v).map(str);
  const row = obj(value);
  const directions = list(row.directions).map((v) => {
    const d = obj(v);
    const id = str(d.id);
    if (!/^[a-zA-Z][\w-]*$/.test(id)) throw new Error("方向卡片标识无效");
    return { id, title: str(d.title), goal: lines(d.goal), done: lines(d.done), problem: lines(d.problem), note: str(d.note) };
  });
  if (new Set(directions.map(d => d.id)).size !== directions.length) throw new Error("方向卡片标识重复");
  const links = list(row.links).map((v) => {
    const link = obj(v);
    const url = str(link.url).trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) throw new Error();
    } catch { throw new Error("联系方式需要有效的 http、https 或 mailto 链接"); }
    return { label: str(link.label), text: str(link.text), url };
  });
  const title = str(row.title).trim();
  if (!title) throw new Error("About 页面标题不能为空");
  return { title, intro: str(row.intro), currentTitle: str(row.currentTitle), current: lines(row.current),
    directionsTitle: str(row.directionsTitle), directions, contactTitle: str(row.contactTitle), links };
}

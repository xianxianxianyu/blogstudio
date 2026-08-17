/**
 * 标签：颜色即分类。
 *
 * 高亮换颜色不是换皮肤——右栏按颜色筛，颜色本身就是「这段是什么」。
 *
 * **标签是全局的，不是每本书一份**：「存疑」在这篇论文和那篇论文是同一件事，那是
 * 读者的习惯，不是某本书的属性。所以注册表住在书架根上。
 */

/**
 * 五个预设槽位。**闭集**，不是 string——漏一个是 TS 错误，而不是运行时才发现的空样式。
 *
 * 不做连续取色器：荧光笔本来就没有连续色域，而且自由取色一定会有人选到深蓝，
 * 然后压着黑字什么都看不见。
 */
export type TagColor = "yellow" | "green" | "blue" | "pink" | "purple";

export const TAG_COLORS: TagColor[] = ["yellow", "green", "blue", "pink", "purple"];

export interface Tag {
  /** 就是颜色槽——颜色是它的身份，所以不能换色，只能改名。 */
  id: TagColor;
  name: string;
}

/**
 * 首次打开时的五个。名字取自读论文时真会用到的分法，读者可以改。
 *
 * 空表不行：读者第一次点开调色盘看到五个没名字的色块，会以为功能坏了。
 */
export const DEFAULT_TAGS: Record<TagColor, string> = {
  yellow: "要点",
  green: "读懂了",
  blue: "术语",
  pink: "存疑",
  purple: "待查",
};

export function defaultTags(): Tag[] {
  return TAG_COLORS.map((id) => ({ id, name: DEFAULT_TAGS[id] }));
}

/**
 * 补齐成五条，并按固定顺序排。
 *
 * 磁盘上那份是**可以手改的**（ADR-0011 的口径），所以它可能少几条、多几条、乱序，
 * 甚至有个不认识的颜色。读的时候归一，而不是相信它——手改一个字就让调色盘少一格
 * 的话，「文件可以手改」这句话就成了陷阱。
 */
export function normalizeTags(stored: Tag[]): Tag[] {
  return TAG_COLORS.map((id) => {
    const found = stored.find((tag) => tag.id === id);
    const name = found?.name.trim();
    return { id, name: name === undefined || name === "" ? DEFAULT_TAGS[id] : name };
  });
}

export function renameTag(tags: Tag[], id: TagColor, name: string): Tag[] {
  return tags.map((tag) => (tag.id === id ? { ...tag, name: name.trim() || DEFAULT_TAGS[id] } : tag));
}

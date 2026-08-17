import { describe, expect, it } from "vitest";
import { inferOffset, looksLikeToc, parseToc, toSections } from "./toc";
import type { Line } from "../pdf/lines";

/** 造一行。`x0` 是左边界——层级从缩进来，所以它是有意义的输入而不是填充。 */
const line = (text: string, x0 = 72, y = 700): Line => ({ text, x0, x1: x0 + 400, y });

/** 一页中文书的目录，照真实排版：章顶格、节缩进，点线引导符。 */
const CHINESE_TOC: Line[] = [
  line("目录", 72, 760),
  line("第一章 计算机系统漫游 ……………………… 1", 72, 720),
  line("1.1 信息就是位 + 上下文 …………………… 3", 96, 706),
  line("1.2 程序被其他程序翻译成不同的格式 ……… 4", 96, 692),
  line("第二章 信息的表示和处理 ………………… 29", 72, 678),
  line("2.1 信息存储 ……………………………… 32", 96, 664),
  line("2.2 整数表示 ……………………………… 55", 96, 650),
  line("第三章 程序的机器级表示 ……………… 111", 72, 636),
];

describe("认出目录页", () => {
  it("认得出一页中文目录", () => {
    expect(looksLikeToc(CHINESE_TOC)).toBe(true);
  });

  it("正文页不会被当成目录页", () => {
    const body = [
      line("在这一章里我们将介绍计算机系统的整体结构。"),
      line("程序从源代码开始，经过预处理、编译、汇编和链接"),
      line("四个阶段，最终成为可执行目标文件。"),
      line("图 1.1 展示了这一过程。"),
    ];

    expect(looksLikeToc(body)).toBe(false);
  });

  it("条目太少不算——正文里一段带页码的表格会长得很像", () => {
    expect(looksLikeToc(CHINESE_TOC.slice(0, 4))).toBe(false);
  });

  it("目录续页没有「目录」二字，照样认得出", () => {
    // 几百页的书目录常常跨好几页，只有第一页印标题。
    const continued = CHINESE_TOC.filter((l) => l.text !== "目录");

    expect(looksLikeToc(continued)).toBe(true);
  });

  it("空页不是目录页", () => {
    expect(looksLikeToc([])).toBe(false);
    expect(looksLikeToc([line("  "), line("")])).toBe(false);
  });
});

describe("解析目录条目", () => {
  it("拆出标题与印刷页码，引导符不留在标题里", () => {
    const entries = parseToc([CHINESE_TOC]);

    expect(entries[0]).toEqual({ title: "第一章 计算机系统漫游", printedPage: 1, level: 0 });
    expect(entries[1]).toEqual({ title: "1.1 信息就是位 + 上下文", printedPage: 3, level: 1 });
  });

  it("层级从缩进来，不是从编号猜的", () => {
    // **一个字的编号都没有**的目录：按编号判会全给 0，只有看缩进才分得出层级。
    // 拿 CHINESE_TOC 测不到这条——那里缩进与编号恰好一致，两条规则给同一个答案。
    const unnumbered = [
      line("绪论 …………………… 1", 72),
      line("研究背景 ……………… 2", 96),
      line("研究方法 ……………… 5", 96),
      line("实验 …………………… 20", 72),
      line("数据集 ………………… 21", 96),
      line("结论 …………………… 48", 72),
    ];

    expect(parseToc([unnumbered]).map((entry) => entry.level)).toEqual([0, 1, 1, 0, 1, 0]);
  });

  it("以数字结尾但没有页码的行不算条目", () => {
    // 这是这类解析最经典的错法：`第2章IPv6` → 标题「第2章IPv」+ 页码 6。规则是页码前
    // **必须**有空白或引导符。用不带空格的写法才测得到这条——带了空格的话，正则里
    // 那个懒惰的 `.*?` 会自己把边界找对，规则去掉也照样算对。
    const entries = parseToc([[line("第2章IPv6", 72), ...CHINESE_TOC.slice(1)]]);

    expect(entries.map((entry) => entry.title)).not.toContain("第2章IPv");
  });

  it("带空格的标题以数字结尾时也不吃掉最后一位", () => {
    const entries = parseToc([
      [
        line("第 2 章 IPv6 …………… 41", 72),
        line("第 3 章 TCP/IP …………… 77", 72),
        line("第 4 章 HTTP/2 ………… 103", 72),
        line("第 5 章 QUIC …………… 140", 72),
        line("第 6 章 DNS …………… 175", 72),
      ],
    ]);

    expect(entries[0]).toEqual({ title: "第 2 章 IPv6", printedPage: 41, level: 0 });
    expect(entries[2].title).toBe("第 4 章 HTTP/2");
  });

  it("目录没有缩进时才退回按编号判层级", () => {
    // 有些书的目录一列到底。编号形式在中文书里五花八门，所以它只是兜底。
    const flat = [
      line("第一章 绪论 …… 1", 72),
      line("1.1 背景 …… 2", 72),
      line("1.1.1 起源 …… 3", 72),
      line("第二节 方法 …… 9", 72),
      line("第二章 结论 …… 20", 72),
    ];

    expect(parseToc([flat]).map((entry) => entry.level)).toEqual([0, 1, 2, 1, 0]);
  });

  it("跨多页的目录接起来，顺序不乱", () => {
    const second = [line("第四章 处理器体系结构 …… 175", 72), line("4.1 Y86-64 指令集 …… 178", 96)];

    const entries = parseToc([CHINESE_TOC, second]);

    expect(entries.map((entry) => entry.printedPage)).toEqual([1, 3, 4, 29, 32, 55, 111, 175, 178]);
  });

  it("孤零零的页码与页眉不产出条目", () => {
    const noise = [line("目录", 72), line("iv", 300), line("2 计算机系统", 72), ...CHINESE_TOC.slice(1)];

    const titles = parseToc([noise]).map((entry) => entry.title);
    expect(titles).not.toContain("iv");
    expect(titles.every((title) => title.trim() !== "")).toBe(true);
  });
});

describe("推断页码偏移", () => {
  const entries = parseToc([CHINESE_TOC]);
  /** 这本书正文从物理第 9 页开始，也就是印刷页 1 = 物理页 9。 */
  const actual: Record<string, number> = {
    "第一章 计算机系统漫游": 9,
    "第二章 信息的表示和处理": 37,
    "第三章 程序的机器级表示": 119,
  };

  it("三条互相印证就定下来，并交出证据", () => {
    const result = inferOffset(entries, (title) => actual[title] ?? null);

    expect(result?.offset).toBe(8);
    // 证据要能摆给读者看——「请确认」比「请填写」可靠得多。
    expect(result?.evidence).toHaveLength(3);
    expect(result?.evidence[0]).toEqual({
      title: "第一章 计算机系统漫游",
      printedPage: 1,
      actualPage: 9,
    });
  });

  it("只对上一两条不算数——一条对上可能是巧合", () => {
    const result = inferOffset(entries, (title) =>
      title === "第一章 计算机系统漫游" ? 9 : null,
    );

    expect(result).toBeNull();
  });

  it("少数几条对不上时按多数来，不被带偏", () => {
    const withNoise: Record<string, number> = { ...actual, "2.1 信息存储": 999 };

    expect(inferOffset(entries, (title) => withNoise[title] ?? null)?.offset).toBe(8);
  });

  it("负偏移一律丢掉——正文不可能排在目录前面", () => {
    // 三条**一致地**指向 -5：不丢负数的话它就是「多数」，会被当成答案。让三条各投各的
    // 票测不到这条——那样谁都不够票数，加不加守卫都返回 null。
    const shifted: Record<string, number> = {
      "第二章 信息的表示和处理": 29 - 5,
      "2.2 整数表示": 55 - 5,
      "第三章 程序的机器级表示": 111 - 5,
    };

    expect(inferOffset(entries, (title) => shifted[title] ?? null)).toBeNull();
  });

  it("一条都找不到时返回 null，而不是给个 0", () => {
    // 给 0 的话读者会以为「不用偏移」，而真相是「没测出来」。
    expect(inferOffset(entries, () => null)).toBeNull();
  });
});

describe("条目 → 摘录栏用的小节", () => {
  const entries = parseToc([CHINESE_TOC]);

  it("印刷页码加上偏移变成物理页码", () => {
    expect(toSections(entries, 8).map((section) => section.page)).toEqual([9, 11, 12, 37, 40, 63, 119]);
  });

  it("祖先路径现算出来——分组要靠它补出没有摘录的祖先标题", () => {
    const [chapter, section] = toSections(entries, 8);

    expect(chapter.path).toEqual([]);
    expect(section.path).toEqual(["第一章 计算机系统漫游"]);
  });

  it("层级跳级时按实际栈深归一，path 不会缺一层", () => {
    // 解析出来的层级可能是 0 → 2（目录里某一层完全没有条目）。照抄的话 path 只有一项，
    // 而 level 说是 2，分组那边就对不上了。
    const jumped = [
      { title: "第一章", printedPage: 1, level: 0 },
      { title: "1.1.1 细节", printedPage: 3, level: 2 },
    ];

    const [, deep] = toSections(jumped, 0);
    expect(deep.level).toBe(1);
    expect(deep.path).toEqual(["第一章"]);
  });
});

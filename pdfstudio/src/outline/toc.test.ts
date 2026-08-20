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

  it("**层级照抄，不夹**——夹取正是把 4.4.2 从 L2 变成 L1 的那一步", () => {
    // 层级可能跳级（0 → 2，目录里某一层完全没有条目）。这里不做任何归一：数据就是
    // 数据，跳级由渲染那边处理（`outline-rows.ts` 有测试钉着）。
    //
    // 原先这里按祖先栈的深度夹一下，而那个栈只为了填 `Section.path`——一个只被写、
    // 从来没被读过的字段。顺手造成的后果是：前面一条折行碎片被判成 L0，栈就只剩一层，
    // 紧跟的三级标题被夹成了 L1。实测这样毁掉了 8 条。
    const jumped = [
      { title: "第一章", printedPage: 1, level: 0 },
      { title: "1.1.1 细节", printedPage: 3, level: 2 },
    ];

    expect(toSections(jumped, 0).map((one) => one.level)).toEqual([0, 2]);
  });
});

describe("折行的条目要拼回去", () => {
  /**
   * 实测的错法（《分布式系统概念与设计》p.12，用眼睛在原书上确认过）：
   *
   *     4.4.1  IP 组播——组播通信的
   *            实现 ……………… 98        ← 页码印在第二行
   *     4.4.2  组播的可靠性和排序 …… 100
   *
   * 不拼的话一处折行同时造成三种错误：带编号的第一行整条丢掉、剩下的尾巴（`实现`）
   * 没编号所以层级 0、而那个假 L0 又会把下一条的层级夹坏。审 395 条真实目录，
   * 18 条尾巴 + 8 条被带歪 = 26 处，占 6.6%。
   */
  const lines = (texts: string[]): Line[] =>
    texts.map((text, i) => ({ text, x0: 0, x1: 1, y: 1000 - i * 20 }));

  it("有编号没页码 + 有页码没编号 = 同一条", () => {
    const entries = parseToc([
      lines(["4.4.1 IP 组播——组播通信的", "实现 ……………… 98", "4.4.2 组播的可靠性和排序 …… 100"]),
    ]);

    expect(entries).toEqual([
      { title: "4.4.1 IP 组播——组播通信的实现", printedPage: 98, level: 2 },
      { title: "4.4.2 组播的可靠性和排序", printedPage: 100, level: 2 },
    ]);
  });

  it("章标题折行也一样——第21章整章就是这么丢的", () => {
    const entries = parseToc([lines(["第21章 设计：Google", "实例研究 …… 546"])]);

    expect(entries).toEqual([
      { title: "第21章 设计：Google实例研究", printedPage: 546, level: 0 },
    ]);
  });

  it("**书名和页眉不能被拼进去**——它们没编号，不满足前半条件", () => {
    // 右栏顶上就是这两行，紧跟着一条正常条目。
    const entries = parseToc([
      lines(["目录", "Distributed Systems: Concepts and Design", "2.3.3 相关的中间件解决方案 …… 34"]),
    ]);

    expect(entries).toEqual([
      { title: "2.3.3 相关的中间件解决方案", printedPage: 34, level: 2 },
    ]);
  });

  it("**没页码的前置条目不能被吞掉**——「前言」后面跟着的是有编号的第1章", () => {
    const entries = parseToc([lines(["出版者的话", "译者序", "前言", "第1章 分布式系统的特征 …… 1"])]);

    expect(entries).toEqual([{ title: "第1章 分布式系统的特征", printedPage: 1, level: 0 }]);
  });

  it("**上半截没有编号就不是折行**——页眉后面跟一条无编号的正常条目", () => {
    // 不设这条守卫的话，`目录` 会把 `前言` 吞成「目录前言」。两行都没编号，
    // 光靠「下半截无编号」这一条挡不住。
    const entries = parseToc([lines(["目录", "前言 …… 3", "第1章 概述 …… 5"])]);

    expect(entries.map((e) => e.title)).toEqual(["前言", "第1章 概述"]);
  });

  it("**上半截自己带页码就是完整的一条**，不能再去吃下一行", () => {
    // 「1.1 简介 …… 2」已经成条了；`练习` 没编号，但它是独立的一条，不是尾巴。
    const entries = parseToc([lines(["1.1 简介 …… 2", "练习 …… 5"])]);

    expect(entries.map((e) => e.title)).toEqual(["1.1 简介", "练习"]);
  });

  it("后一行自己带编号就不是尾巴，各算各的", () => {
    // 「4.4 组播通信」没有页码（OCR 漏了），下一行是完整的一条。拼起来会造出
    // 一个不存在的条目，而且把 4.4.2 的标题也毁了。
    const entries = parseToc([lines(["4.4 组播通信", "4.4.2 组播的可靠性和排序 …… 100"])]);

    expect(entries).toEqual([
      { title: "4.4.2 组播的可靠性和排序", printedPage: 100, level: 2 },
    ]);
  });

  it("拼接不留引导符和多余空白", () => {
    const entries = parseToc([lines(["4.5.2 Skype：一个覆盖网络的", "  例子 …………… 102  "])]);

    expect(entries[0].title).toBe("4.5.2 Skype：一个覆盖网络的例子");
  });

  it("靠缩进定层级的目录不受影响——拼接只补标题，不动层级来源", () => {
    const withIndent: Line[] = [
      { text: "第1章 概述 …… 1", x0: 0, x1: 1, y: 100 },
      { text: "1.1 简介 …… 2", x0: 20, x1: 1, y: 80 },
      { text: "1.2 很长很长的一个标题", x0: 20, x1: 1, y: 60 },
      { text: "续上 …… 5", x0: 40, x1: 1, y: 40 },
    ];
    const entries = parseToc([withIndent]);

    expect(entries.map((e) => e.title)).toEqual(["第1章 概述", "1.1 简介", "1.2 很长很长的一个标题续上"]);
    // 缩进档位由**拼接之后**剩下的行决定：0 和 20 两档，不该被尾巴那行的 40 撑出第三档。
    expect(entries.map((e) => e.level)).toEqual([0, 1, 1]);
  });
});

describe("一行里挤了好几条（模型幻觉）", () => {
  const lines = (texts: string[]): Line[] =>
    texts.map((text, i) => ({ text, x0: 0, x1: 1, y: 1000 - i * 20 }));

  /**
   * 分辨率不够时模型不是漏行，而是**把几行揉成一行并顺着上一行编号往下编**。
   * 实测（pdf.js 渲染、长边 1200）：
   *
   *   实际  1.7 小结 …… 20 / 练习 …… 20 / 第2章 系统模型 …… 22 / 2.1 简介 …… 22
   *   认成  1.7.1 系统模型 ..... 22.1 简介 ..... 22.2 物理模型 ..... 23
   *
   * 照单全收的话，读者会看到一个编号连贯、页码递增、**完全错误**的目录，而且看不出来。
   */
  it("多组「引导符 + 页码」的行不成条目——缺一条看得见，编一条看不见", () => {
    const entries = parseToc([
      lines([
        "1.7 小结 ..... 20",
        "1.7.1 系统模型 ..... 22.1 简介 ..... 22.2 物理模型 ..... 23",
        "2.3.1 体系结构元素 ..... 24",
      ]),
    ]);

    expect(entries.map((e) => e.title)).toEqual(["1.7 小结", "2.3.1 体系结构元素"]);
  });

  it("正常的一条不会被误伤——标题里的点号不是引导符", () => {
    const entries = parseToc([
      lines(["3.4.4 IPv6 …… 67", "21.5.1 Google 文件系统 ..... 574", "1.2.3 金融交易 ..... 3"]),
    ]);

    expect(entries).toHaveLength(3);
  });

  it("标题里带版本号之类的数字也不误伤", () => {
    const entries = parseToc([lines(["11.6.3 802.11 WiFi 安全 ..... 320"])]);

    expect(entries[0]).toMatchObject({ title: "11.6.3 802.11 WiFi 安全", printedPage: 320 });
  });
});

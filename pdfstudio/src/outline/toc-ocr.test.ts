import { describe, expect, it } from "vitest";
import { parseToc } from "./toc";
import type { Line } from "../pdf/lines";

/**
 * 真实扫描件的 OCR 输出：《分布式系统概念与设计（第五版）》p.11 左栏，
 * 本地 PaddleOCR-VL 按栏切图之后认出来的原样文本（2026-08-19 实测）。
 *
 * **OCR 出来的行没有坐标**，所以 x 一律为 0——`parseToc` 会因此退回按编号定层级。
 * 这个 fixture 存在的意义就是钉住那条退化路径在**中文书的真实编号形式**上成立。
 */
const OCR_LEFT = [
  "出版者的话",
  "译者序",
  "前言",
  "第1章 分布式系统的特征 …… 1",
  "1.1 简介 …… 1",
  "1.2 分布式系统的例子 …… 2",
  "1.2.1 Web 搜索 …… 2",
  "1.2.2 大型多人在线游戏 …… 3",
  "1.2.3 金融交易 …… 3",
  "1.3 分布式系统的趋势 …… 4",
  "1.3.1 泛在联网和现代互联网……5",
  "1.3.2 移动和无处不在计算……5",
  "1.3.3 分布式多媒体系统 …… 7",
];

const asLines = (texts: string[]): Line[] =>
  texts.map((text, i) => ({ text, x0: 0, x1: 1, y: 1000 - i * 20 }));

describe("OCR 文本走 parseToc", () => {
  const entries = parseToc([asLines(OCR_LEFT)]);

  it("没印页码的行不成条目——「出版者的话」「译者序」「前言」都该被丢掉", () => {
    expect(entries.map((e) => e.title)).not.toContain("出版者的话");
    expect(entries.map((e) => e.title)).not.toContain("译者序");
  });

  it("标题连着编号，点线引导符去掉", () => {
    expect(entries[0]).toMatchObject({ title: "第1章 分布式系统的特征", printedPage: 1 });
    expect(entries[1]).toMatchObject({ title: "1.1 简介", printedPage: 1 });
  });

  it("**没有空格的引导符也认**——OCR 常把「…… 5」吐成「……5」", () => {
    const one = entries.find((e) => e.title.startsWith("1.3.1"));
    expect(one).toMatchObject({ title: "1.3.1 泛在联网和现代互联网", printedPage: 5 });
  });

  it("层级靠编号：第N章 → 0，N.N → 1，N.N.N → 2", () => {
    const level = (prefix: string) => entries.find((e) => e.title.startsWith(prefix))?.level;
    expect(level("第1章")).toBe(0);
    expect(level("1.1")).toBe(1);
    expect(level("1.2.1")).toBe(2);
  });

  it("整栏认下来的条目数与人眼一致", () => {
    // 13 行里有 10 行带页码。
    expect(entries).toHaveLength(10);
  });
});

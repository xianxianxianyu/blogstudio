import { describe, expect, it } from "vitest";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { highlightBoxes } from "./coverage";
import { openFixturePdf } from "../../test/fixtures";

describe("高亮的框：把区域内的文字行摊出来", () => {
  it("一行文字给一个框，且被区域裁住", async () => {
    // 标签画成「覆盖真实文字行的高亮」而不是一个大矩形，靠的就是这个（ADR-0016）。
    // 裁住是关键：框选到半句时，高亮也该只盖住那半句，否则读者会以为自己选多了。
    const document = await openFixturePdf("1706.03762.pdf");
    const { items } = await (await document.getPage(1)).getTextContent();
    const text = items.filter((item): item is TextItem => "str" in item);

    // Abstract 的前两行。
    const boxes = highlightBoxes({ x: 140, y: 470, width: 100, height: 20 }, text);

    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(140);
      expect(box.x + box.width).toBeLessThanOrEqual(140 + 100 + 0.001);
    }
  });

  it("区域里没有文字就没有框——公式和图走的是画框那条路", async () => {
    const document = await openFixturePdf("1706.03762.pdf");
    const { items } = await (await document.getPage(1)).getTextContent();
    const text = items.filter((item): item is TextItem => "str" in item);

    // 页面顶部的空白。
    expect(highlightBoxes({ x: 60, y: 740, width: 40, height: 20 }, text)).toEqual([]);
  });

  it("跨两行的区域给出两组框，纵向分开", async () => {
    // 一个矩形一条高亮的话，跨行选择会糊成一整块，连行距都盖住——那就不是荧光笔了。
    const document = await openFixturePdf("1706.03762.pdf");
    const { items } = await (await document.getPage(1)).getTextContent();
    const text = items.filter((item): item is TextItem => "str" in item);

    const boxes = highlightBoxes({ x: 140, y: 440, width: 330, height: 50 }, text);
    const tops = new Set(boxes.map((box) => Math.round(box.y)));

    expect(tops.size).toBeGreaterThan(1);
  });
});

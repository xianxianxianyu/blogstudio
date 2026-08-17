import { describe, expect, it } from "vitest";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { selectionToRegion, type Fragment } from "./selection";

/**
 * 页面几何按真实论文的量级造：ResNet p.8 是 612pt 宽的双栏页，左栏 ~54–286、
 * 右栏 ~308–558，行距 ~11pt。数值取自 `.scratch/pdfstudio-selection/probe-*.mts`。
 */
const PAGE = { left: 0, right: 612 };

function item(text: string, x: number, y: number, width: number): TextItem {
  return {
    str: text,
    dir: "ltr",
    width,
    height: 9,
    transform: [1, 0, 0, 1, x, y],
    fontName: "g_d0_f1",
    hasEOL: false,
  };
}

/** 一页双栏的正文：左右两栏各三行，共享基线网格（真实论文就是这样）。 */
function twoColumnPage(): TextItem[] {
  const rows = [700, 689, 678];
  return rows.flatMap((y, index) => [
    item(`左栏第 ${index + 1} 行的正文文字`, 54, y, 232),
    item(`右栏第 ${index + 1} 行的正文文字`, 308, y, 250),
  ]);
}

/** 一页单栏的正文：每行都横跨中线。 */
function oneColumnPage(): TextItem[] {
  return [700, 689, 678].map((y, index) =>
    item(`单栏第 ${index + 1} 行，从左边距一直排到右边距`, 72, y, 468),
  );
}

function fragment(text: string, x: number, y: number, width: number): Fragment {
  return { text, rect: { x, y, width, height: 9 } };
}

describe("选区片段 → 读序文本与行矩形", () => {
  it("单栏连选三行：按自上而下拼接，一行一个矩形", () => {
    const region = selectionToRegion({
      anchor: { x: 200, y: 700 },
      fragments: [
        fragment("单栏第 1 行", 200, 700, 200),
        fragment("单栏第 2 行", 72, 689, 468),
        fragment("单栏第 3 行", 72, 678, 300),
      ],
      pageItems: oneColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("单栏第 1 行\n单栏第 2 行\n单栏第 3 行");
    expect(region?.lines).toHaveLength(3);
  });

  it("片段顺序错乱也能还原读序——原生选区给的是 DOM 顺序，不是读序", () => {
    const region = selectionToRegion({
      anchor: { x: 200, y: 700 },
      fragments: [
        fragment("单栏第 3 行", 72, 678, 300),
        fragment("单栏第 1 行", 200, 700, 200),
        fragment("单栏第 2 行", 72, 689, 468),
      ],
      pageItems: oneColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("单栏第 1 行\n单栏第 2 行\n单栏第 3 行");
  });

  it("双栏页上在左栏连选，混进来的右栏片段被丢掉", () => {
    // 实测 ResNet p.8 的流顺序里左右栏切换 14 次、DDPM p.4 上 48 次，
    // 两个左栏 item 之间最多夹进 51 个右栏 item——不过滤就会把隔壁栏一起选中。
    const region = selectionToRegion({
      anchor: { x: 60, y: 700 },
      fragments: [
        fragment("左栏第 1 行", 54, 700, 232),
        fragment("右栏第 1 行", 308, 700, 250),
        fragment("左栏第 2 行", 54, 689, 232),
        fragment("右栏第 2 行", 308, 689, 250),
      ],
      pageItems: twoColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("左栏第 1 行\n左栏第 2 行");
    expect(region?.lines).toHaveLength(2);
  });

  it("起点在右栏时，收的是右栏——归栏看起点，不看谁的片段多", () => {
    const region = selectionToRegion({
      anchor: { x: 400, y: 700 },
      fragments: [
        fragment("左栏 A", 54, 700, 232),
        fragment("左栏 B", 54, 689, 232),
        fragment("左栏 C", 54, 678, 232),
        fragment("右栏 A", 308, 700, 250),
      ],
      pageItems: twoColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("右栏 A");
  });

  it("单栏页不做归栏过滤——整页都是一栏，过滤会把半页吃掉", () => {
    const region = selectionToRegion({
      anchor: { x: 100, y: 700 },
      fragments: [
        fragment("左半", 72, 700, 200),
        // 中线右侧，但这一页是单栏，它是同一行的后半截
        fragment("右半", 320, 700, 200),
      ],
      pageItems: oneColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("左半右半");
  });

  it("同一行的多个片段按 x 拼接，并合成一个矩形", () => {
    const region = selectionToRegion({
      anchor: { x: 60, y: 700 },
      fragments: [
        fragment("界", 130, 700, 20),
        fragment("边", 110, 700, 20),
        fragment("行", 90, 700, 20),
      ],
      pageItems: twoColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("行边界");
    expect(region?.lines).toEqual([{ x: 90, y: 700, width: 60, height: 9 }]);
  });

  it("首尾行被端点裁短时，矩形跟着短——外接矩形会把没选中的地方也涂上", () => {
    const region = selectionToRegion({
      anchor: { x: 200, y: 700 },
      fragments: [
        fragment("行尾半截", 200, 700, 86), // 从行中间起
        fragment("整行都在里面", 54, 689, 232),
      ],
      pageItems: twoColumnPage(),
      page: PAGE,
    });

    expect(region?.lines).toEqual([
      { x: 200, y: 700, width: 86, height: 9 },
      { x: 54, y: 689, width: 232, height: 9 },
    ]);
    // 外接矩形仍然是并集：它给 sameRegion 去重和标签命中用，语义不变。
    expect(region?.bounds).toEqual({ x: 54, y: 689, width: 232, height: 20 });
  });

  it("空白片段不产生矩形，也不在文本里留下空行", () => {
    const region = selectionToRegion({
      anchor: { x: 60, y: 700 },
      fragments: [
        fragment("有字", 54, 700, 40),
        fragment("   ", 94, 700, 12),
        fragment("", 106, 700, 0),
      ],
      pageItems: twoColumnPage(),
      page: PAGE,
    });

    expect(region?.text).toBe("有字   ");
    expect(region?.lines).toHaveLength(1);
  });

  it("一个片段都不剩时返回 null——不产生空摘录", () => {
    expect(
      selectionToRegion({
        anchor: { x: 60, y: 700 },
        fragments: [fragment("   ", 54, 700, 12)],
        pageItems: twoColumnPage(),
        page: PAGE,
      }),
    ).toBeNull();
  });
});

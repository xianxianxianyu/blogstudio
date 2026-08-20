import { describe, expect, it } from "vitest";
import { SETTINGS_PAGES, blocksOf, usersOf } from "./settings-map";
import { CAPABILITIES } from "../config/config";

describe("设置项归谁", () => {
  it("「这本书的目录」只在手上真有一本书时才出现", () => {
    // 目录是**这本书的数据**，不是应用的配置。它待在设置里本来就是个折中（重新生成
    // 的入口在摘录栏里只出现一次，之后就找不回来了）。既然是折中，就必须守住它的边界：
    // 没开书时那一块无处可施，画出来只会是一个点了没反应的按钮。
    expect(blocksOf("book", { bookOpen: true })).toContain("outline");
    expect(blocksOf("book", { bookOpen: false })).not.toContain("outline");
  });
});

describe("哪些是共用的", () => {
  it("端点在「模型」这一页，而且不随手上开着什么变", () => {
    // 端点是按**能力**切的，不是按产品切的（ADR-0010）。识别、翻译、问文档、写作助手
    // 落在三侧，配置却是同一份、同一个默认组回退。所谓「三侧的设置不互通」是个错觉
    // ——它们本来就是一份，只是此前界面把这一份切开摆了，还漏掉了几个能力。
    expect(blocksOf("model", { bookOpen: false })).toContain("endpoints");
    expect(blocksOf("model", { bookOpen: true })).toEqual(blocksOf("model", { bookOpen: false }));
  });
});

describe("一块只归一页", () => {
  it("同一块设置不在两页上各画一份", () => {
    // 这次要修的 bug 就是设置散开：同一个「设置」按钮在不同页面给出不同的表，
    // 于是读者无从判断哪些是全局的、哪些只对眼前这一样生效。归属表允许一块不出现，
    // 但**绝不允许一块出现两次**——出现两次的那一刻，两处就会开始各自漂移。
    const everywhere = SETTINGS_PAGES.flatMap((page) => blocksOf(page.id, { bookOpen: true }));

    expect(everywhere).toHaveLength(new Set(everywhere).size);
  });
});

describe("能力归谁用", () => {
  it("每一个能力都得有人在用——没人用的那个位置正是 embedding 待过的地方", () => {
    // `embedding` 在设置里摆了三栏，接线那侧写死了本地模型；`claim` 从来没接过线。
    // 两个都是「点了不生效、也不报错」的旋钮，而这种坏法一点声音都没有。
    // 这条测试守的是那个门：能力表里多一个没人用的，这里当场红。
    for (const capability of CAPABILITIES) {
      expect(usersOf(capability), `${capability} 没有人在用`).not.toEqual([]);
    }
  });

  it("每一侧用的能力，都在「模型」这一页上配，不在各自那一页", () => {
    // 「三侧的设置不互通」是个错觉——它们本来就是一份配置。真正的毛病是界面把这一份
    // 切开摆了，还漏了几个能力。所以答案不是把三份合并，而是让归属这件事只有一个说法。
    const sides = new Set(CAPABILITIES.flatMap(usersOf));

    expect(sides).toEqual(new Set(["book", "writer"]));
    for (const side of sides) {
      expect(blocksOf(side, { bookOpen: true })).not.toContain("endpoints");
    }
  });
});

describe("空的那一页", () => {
  it("一块可配项都没有的页，要能说出为什么——不画一片空白", () => {
    // Context 和 Writer 现在都还没有自己的设置。空页面比错页面好，但**沉默的空页面
    // 不行**：读者会以为是没加载出来，然后反复点它。
    for (const page of SETTINGS_PAGES) {
      if (blocksOf(page.id, { bookOpen: true }).length === 0) {
        expect(page.empty, `${page.id} 是空页却没有说明`).toBeTruthy();
      }
    }
  });
});

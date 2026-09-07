import { describe, expect, it } from "vitest";
import { slugOf, slugProblem } from "./slug";

describe("slugOf", () => {
  it("空格变短横，英文转小写", () => {
    expect(slugOf("KV Cache 笔记")).toBe("kv-cache-笔记");
  });

  it("中文原样留着——博客早就有中文文件名了，不为它引一个拼音库", () => {
    expect(slugOf("摩鱼天尊")).toBe("摩鱼天尊");
  });

  it("路径记号一律变成短横，不是删掉", () => {
    // 删掉会把「a/b」变成「ab」，两篇不同的文章可能撞成同一个名字。
    expect(slugOf("a/b\\c")).toBe("a-b-c");
  });

  it("连着的分隔符收成一个，首尾的去掉", () => {
    expect(slugOf("  a   b  ")).toBe("a-b");
    expect(slugOf("--a--")).toBe("a");
    // 「标题 - 副标题」这种写法：那个短横两边的空格各自变成短横，会连出三个。
    expect(slugOf("KV cache - 笔记")).toBe("kv-cache-笔记");
  });

  it("点开头的名字不留那个点", () => {
    // `.hidden` 在 unix 上是隐藏文件，落进内容目录多半就再也想不起来。
    expect(slugOf(".hidden")).toBe("hidden");
  });

  it("整个名字都没法用就给空串，由上一层拦", () => {
    expect(slugOf("...")).toBe("");
    expect(slugOf("")).toBe("");
  });
});

describe("slugProblem", () => {
  it("好名字没有问题", () => {
    expect(slugProblem("kv-cache-笔记")).toBeNull();
  });

  it("空的不行", () => {
    expect(slugProblem("")).not.toBeNull();
  });

  it("带路径的一律不行", () => {
    // 这不是防谁——名字是自己起的——而是**别让一个坏名字静静地写到内容目录外面去**。
    for (const bad of ["a/b", "a\\b", "..", "../x", "x/../y"]) {
      expect(slugProblem(bad), bad).not.toBeNull();
    }
  });

  it("点开头的不行——`slugOf` 会去掉，但这一栏是可以手打的", () => {
    expect(slugProblem(".hidden")).not.toBeNull();
  });

  it("`.md` 得自己接，名字里不该带", () => {
    expect(slugProblem("题.md")).not.toBeNull();
  });
});

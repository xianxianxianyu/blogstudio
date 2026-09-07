import { describe, expect, it } from "vitest";
import { imagesToUpload } from "./image-target";

describe("imagesToUpload", () => {
  it("只传那边没有的", () => {
    expect(imagesToUpload(["a.png", "b.png", "c.png"], ["b.png"])).toEqual(["a.png", "c.png"]);
  });

  it("那边都有就一张都不传", () => {
    expect(imagesToUpload(["a.png"], ["a.png", "别的.png"])).toEqual([]);
  });

  it("**那边多出来的不算删除**", () => {
    // 跟正文那一侧的 --delete 故意不对称：OSS 上那些是 .cn 唯一的图源，
    // 某篇临时下架就把图删掉，等于把线上页面弄坏。
    expect(imagesToUpload([], ["线上还在用的.png"])).toEqual([]);
  });

  it("一张都不需要时是空数组，不是全部", () => {
    expect(imagesToUpload([], ["a.png"])).toEqual([]);
  });

  it("结果是稳定顺序的——预览里那份清单不该每次刷新都换个排法", () => {
    expect(imagesToUpload(["c.png", "a.png", "b.png"], [])).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("中文名也当普通名字处理", () => {
    expect(imagesToUpload(["截图 1.png"], [])).toEqual(["截图 1.png"]);
  });
});

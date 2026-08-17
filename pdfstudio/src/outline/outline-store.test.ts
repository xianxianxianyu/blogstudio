import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOutlineStore } from "./outline-store";
import type { Section } from "../clip/outline";

const SECTIONS: Section[] = [
  { title: "第一章 计算机系统漫游", page: 9, y: null, level: 0, path: [] },
  { title: "1.1 信息就是位 + 上下文", page: 11, y: null, level: 1, path: ["第一章 计算机系统漫游"] },
  { title: "第二章 信息的表示和处理", page: 37, y: null, level: 0, path: [] },
];

const store = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "outline-"));
  await mkdir(path.join(root, "d1"), { recursive: true });
  return { root, outlines: createOutlineStore(root) };
};

describe("生成的目录落盘", () => {
  it("存进去读出来一模一样", async () => {
    const { outlines } = await store();

    await outlines.save("d1", SECTIONS);

    expect(await outlines.load("d1")).toEqual(SECTIONS);
  });

  it("没生成过是 null，不是空数组", async () => {
    // 空数组是「这本书目录是空的」，null 是「还没生成过」——摘录栏靠这个区别决定
    // 要不要显示「生成目录」那个入口。
    const { outlines } = await store();

    expect(await outlines.load("d1")).toBeNull();
  });

  it("正文是能直接读的大纲，缩进即层级", async () => {
    // 自动识别的目录三项全对只有 57%，**手改是主路径不是逃生口**，
    // 所以它得长得像一份可以直接编辑的大纲（ADR-0011 允许手改）。
    const { root, outlines } = await store();

    await outlines.save("d1", SECTIONS);
    const markdown = await readFile(path.join(root, "d1", "outline.md"), "utf8");

    expect(markdown).toContain("- 第一章 计算机系统漫游");
    expect(markdown).toContain("  - 1.1 信息就是位 + 上下文");
    expect(markdown).toContain("自动识别");
  });

  it("手改坏了退回「没生成过」，不是让书打不开", async () => {
    const { root, outlines } = await store();
    await writeFile(path.join(root, "d1", "outline.md"), "被我改烂了", "utf8");

    expect(await outlines.load("d1")).toBeNull();
  });

  it("删掉之后回到没生成过的状态", async () => {
    const { outlines } = await store();
    await outlines.save("d1", SECTIONS);

    await outlines.remove("d1");

    expect(await outlines.load("d1")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClipStore } from "./clip-store";
import type { Clip } from "./clip";
import type { Region, Screenshot } from "../recognizer/recognizer";

const PNG: Screenshot = {
  mime: "image/png",
  // 不是合法 PNG 也无妨——这里要验的是「存进去什么、取出来什么」，不是解码。
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]),
  width: 332,
  height: 78,
};

const REGION: Region = {
  page: 3,
  rect: { x: 140, y: 303, width: 332, height: 78 },
  pixels: PNG,
};

const CLIP: Clip = {
  id: "c1",
  state: "ready",
  region: REGION,
  content: {
    route: "text",
    anchor: { page: 3, rect: REGION.rect },
    sourceText: "The dominant sequence transduction models",
    images: [PNG],
    screenshot: PNG,
  },
  sourceText: "The dominant sequence transduction models",
  translation: "主流的序列转导模型",
  note: "这段是全文的论点起点",
  label: "dot",
};

const store = async () => createClipStore(await mkdtemp(path.join(tmpdir(), "clipstore-")));

describe("ClipStore — 存取", () => {
  it("存进去再读出来，摘录一模一样，截图字节逐字节相同", async () => {
    const clips = await store();

    await clips.save("paper-1706", CLIP);
    const [loaded] = await clips.listByDoc("paper-1706");

    expect(loaded).toEqual(CLIP);
    // 截图是「地面真值」（CONTEXT.md），不是可以重新渲染的东西——
    // 存取一轮之后必须逐字节一致，否则那个词就不成立。
    expect(Array.from(loaded.content!.screenshot.bytes)).toEqual(Array.from(PNG.bytes));
  });

  it("落盘的是可读的 markdown 加一个 .asset 文件夹", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clipstore-"));
    const clips = createClipStore(root);

    await clips.save("paper-1706", CLIP);

    // 文件是唯一真相，所以它得是人能读、能 grep、能手改的东西（ADR-0011）。
    const folder = path.join(root, "paper-1706", "c1");
    const markdown = await readFile(path.join(folder, "index.md"), "utf8");
    expect(markdown).toContain("The dominant sequence transduction models");
    expect(markdown).toContain("主流的序列转导模型");
    expect(markdown).toContain("这段是全文的论点起点");

    expect(await readdir(path.join(folder, ".asset"))).not.toHaveLength(0);
  });
});

describe("ClipStore — 抠出的图与整块截图不是同一张", () => {
  it("images 与 screenshot 分别存，不能靠数量重建", async () => {
    const cropped: Screenshot = {
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      width: 100,
      height: 50,
    };
    const clips = await store();

    await clips.save("paper-1706", {
      ...CLIP,
      content: { ...CLIP.content!, images: [cropped], screenshot: PNG },
    });
    const [loaded] = await clips.listByDoc("paper-1706");

    // canonical 区分这两者：images 是抠出来给 markdown 用的图，screenshot 是整块区域的
    // ground truth 回显。今天 Recognizer 让它们相等，所以「只存数量、读回来拿 screenshot
    // 填」看着无损——真抠图落地那天就会静默丢数据。
    expect(Array.from(loaded.content!.images[0].bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(loaded.content!.screenshot.bytes)).toEqual(Array.from(PNG.bytes));
  });
});

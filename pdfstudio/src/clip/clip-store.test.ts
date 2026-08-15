import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
  important: false,
};

const store = async () => createClipStore(await mkdtemp(path.join(tmpdir(), "clipstore-")));

/** 需要直接翻磁盘的用例用它——`store()` 拿不到根目录。 */
const storeAt = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clipstore-"));
  return { root, store: createClipStore(root) };
};

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

describe("保留轴落盘（ADR-0012）", () => {
  it("重要标记存进 frontmatter，读回来还在", async () => {
    // **标记的真相必须是文件，不是数据库。** ADR-0011 定了数据库是可重建的缓存；
    // 标记只活在库里的话，某天扫文件夹重建索引就会把它全部丢掉，紧接着回收器
    // 静默删除——一次重建 = 一次数据毁灭。
    const target = await store();
    await target.save("d1", { ...CLIP, id: "important-1", important: true });
    await target.save("d1", { ...CLIP, id: "casual-1", important: false });

    const back = await target.listByDoc("d1");

    expect(back.find((clip) => clip.id === "important-1")!.important).toBe(true);
    expect(back.find((clip) => clip.id === "casual-1")!.important).toBe(false);
  });

  it("旧文件没有这个字段，读成不重要而不是 undefined", async () => {
    // 已经落过盘的摘录都没有这个字段。读成 undefined 的话，回收器那边
    // `!clip.important` 与 `clip.important === false` 会得到不同答案，
    // 而这类差别通常要等到东西被删掉才发现。
    const { root, store: target } = await storeAt();
    await target.save("d1", CLIP);
    const file = path.join(root, "d1", CLIP.id, "index.md");
    await writeFile(file, (await readFile(file, "utf8")).replace(/\s*"important": (true|false),?\n/, "\n"));

    expect((await target.listByDoc("d1"))[0].important).toBe(false);
  });
});

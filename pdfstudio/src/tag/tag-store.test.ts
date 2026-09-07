import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTagStore } from "./tag-store";
import { normalizeTags } from "./tag";

describe("标记表落盘", () => {
  it("书架根不在了也存得住——写之前自己把目录建回来", async () => {
    // `library/` 此前只在 `local-api.ts` 启动那一刻建过一次。目录中途没了的话，
    // 改标记名会一直 ENOENT 到重启为止，而界面上只有一句「保存失败」。
    // **store 的正确性不该依赖调用方在启动时做过什么**——那正是这个 bug 的成因。
    const root = path.join(await mkdtemp(path.join(tmpdir(), "tags-")), "library");
    const tags = createTagStore(root);

    await tags.save([{ id: "yellow", name: "要点" }]);

    expect((await tags.load()).find((tag) => tag.id === "yellow")?.name).toBe("要点");
  });

  it("目录被删掉之后再存一次，照样存得住", async () => {
    // 同一个 store 实例跨越了「目录消失」这件事。建一次就不管了的写法在这里过不去。
    const root = await mkdtemp(path.join(tmpdir(), "tags-"));
    const tags = createTagStore(root);
    await tags.save([{ id: "green", name: "读懂了" }]);

    await rm(root, { recursive: true, force: true });
    await tags.save([{ id: "green", name: "读懂了" }]);

    expect(await tags.load()).toEqual(normalizeTags([{ id: "green", name: "读懂了" }]));
  });
});

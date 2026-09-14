import { describe, expect, it, vi } from "vitest";
import { createWriter } from "./writing";
import type { DraftStore } from "./draft";
import type { Draft } from "./draft";

/** 内存里的 DraftStore，够测这一层的规则。 */
function memoryStore(seed: Draft[] = []) {
  const files = new Map(seed.map((draft) => [draft.id, draft]));
  let fail: string | null = null;
  const store: DraftStore = {
    list: async () =>
      [...files.values()]
        .map((draft) => ({ id: draft.id, title: draft.markdown, excerpt: "", updatedAt: draft.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    load: async (id) => files.get(id) ?? null,
    save: async (draft) => {
      if (fail) throw new Error(fail);
      files.set(draft.id, draft);
    },
    remove: async (id) => void files.delete(id),
  };
  return { store, files, breakIt: (why: string | null) => (fail = why) };
}

const draft = (id: string, markdown = ""): Draft => ({ id, markdown, createdAt: 1, updatedAt: 1 });

function writer(seed: Draft[] = [], settle = 0) {
  const memory = memoryStore(seed);
  let clock = 100;
  return {
    ...memory,
    writer: createWriter({
      store: memory.store,
      newId: () => "new-id",
      now: () => ++clock,
      settle,
    }),
  };
}

describe("写", () => {
  it("新起一篇**先落盘再打开**——只活在内存里的话，关掉窗口就没了", async () => {
    const it_ = writer();

    const id = await it_.writer.create();

    expect(it_.files.has(id)).toBe(true);
    expect(it_.writer.state.openId).toBe(id);
  });

  it("打字之后隔一会儿自己存住", async () => {
    vi.useFakeTimers();
    try {
      const it_ = writer([], 800);
      await it_.writer.open("d1").catch(() => {});
      await it_.writer.create();

      it_.writer.edit("# 标题");
      expect(it_.writer.state.status).toBe("dirty");

      await vi.advanceTimersByTimeAsync(800);
      expect(it_.files.get("new-id")?.markdown).toBe("# 标题");
      expect(it_.writer.state.status).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("**每一键都写盘是不行的**：停手之前只写最后那一版", async () => {
    vi.useFakeTimers();
    try {
      const it_ = writer([], 800);
      await it_.writer.create();
      const save = vi.spyOn(it_.store, "save");

      for (const text of ["一", "一二", "一二三"]) it_.writer.edit(text);
      await vi.advanceTimersByTimeAsync(800);

      expect(save).toHaveBeenCalledTimes(1);
      expect(it_.files.get("new-id")?.markdown).toBe("一二三");
    } finally {
      vi.useRealTimers();
    }
  });

  it("**换一篇之前先把手上这篇存住**——丢的是刚写的字，不能靠「多半来得及」", async () => {
    const it_ = writer([draft("other", "别人")], 10_000);
    await it_.writer.create();
    it_.writer.edit("还没到点的字");

    await it_.writer.open("other");

    expect(it_.files.get("new-id")?.markdown).toBe("还没到点的字");
    expect(it_.writer.text()).toBe("别人");
  });

  it("正文按键就变，**但它不进 state**——否则右边那栏每个字都白重渲染一遍", async () => {
    const it_ = writer([], 10_000);
    await it_.writer.create();
    const seen = vi.fn();
    it_.writer.subscribe(seen);

    it_.writer.edit("# 标题");   // 变脏 + 名字变了：通知
    it_.writer.edit("# 标题一"); // 名字又变了：通知
    it_.writer.edit("# 标题一\n\n正文"); // 名字没变、状态没变：不通知
    it_.writer.edit("# 标题一\n\n正文二");

    expect(seen).toHaveBeenCalledTimes(2);
    expect(it_.writer.text()).toBe("# 标题一\n\n正文二");
    expect(it_.writer.state.title).toBe("标题一");
  });

  it("**存不住要说出来**，而且状态退回脏的——以为存了其实没存是最坏的一种", async () => {
    const it_ = writer([], 0);
    await it_.writer.create();
    it_.breakIt("磁盘满了");

    it_.writer.edit("写不进去的字");
    await it_.writer.flush();

    expect(it_.writer.state.status).toBe("dirty");
    expect(it_.writer.state.error).toBe("磁盘满了");
  });

  it("删掉正开着的那篇，**防抖里那一拍不能把文件写回来**", async () => {
    const it_ = writer([], 10_000);
    const id = await it_.writer.create();
    it_.writer.edit("正要存的字");

    await it_.writer.remove(id);
    await it_.writer.flush();

    expect(it_.files.has(id)).toBe(false);
    expect(it_.writer.state.openId).toBeNull();
  });

  it("打开一篇不在了的，报错而不是打开一篇空的", async () => {
    await expect(writer().writer.open("没有的")).rejects.toThrow("不在了");
  });

  describe("标成我的观点", () => {
    it("在那一段末尾添上记号，并且换掉正文（要重建编辑器）", async () => {
      const it_ = writer([], 10_000);
      await it_.writer.create();
      it_.writer.edit("# 标题\n\n一句没有出处的话");
      const before = it_.writer.state.epoch;

      it_.writer.markAuthored(3);

      expect(it_.writer.text()).toBe("# 标题\n\n一句没有出处的话 [authored]");
      expect(it_.writer.state.epoch).toBeGreaterThan(before);
    });

    it("**重复点不叠加，也不白重建一次编辑器**", async () => {
      const it_ = writer([], 10_000);
      await it_.writer.create();
      it_.writer.edit("一句话");
      it_.writer.markAuthored(1);
      const after = it_.writer.state.epoch;

      it_.writer.markAuthored(1);

      expect(it_.writer.text()).toBe("一句话 [authored]");
      expect(it_.writer.state.epoch).toBe(after);
    });
  });
});

describe("新起一篇要标题", () => {
  it("按标题起地址，名字跟着落盘", async () => {
    const it_ = writer();
    const id = await it_.writer.create("Test VPS Blog");
    expect(id).toBe("test-vps-blog");
    expect(it_.files.get("test-vps-blog")).toMatchObject({ id: "test-vps-blog", title: "Test VPS Blog", markdown: "" });
  });

  it("地址撞了就拒绝——文件名就是 id，覆盖等于把另一篇悄悄抹掉", async () => {
    const it_ = writer([draft("同一篇", "# 旧的")]);
    await it_.writer.refresh();
    await expect(it_.writer.create("同一篇")).rejects.toThrow("已经有一篇");
    expect(it_.files.get("同一篇")!.markdown).toBe("# 旧的");
  });

  it("起不出地址的标题拒绝；不给标题仍走 uuid（桌面版老路）", async () => {
    const it_ = writer();
    await expect(it_.writer.create("...")).rejects.toThrow("起不出地址");
    expect(await it_.writer.create()).toBe("new-id");
  });
});

describe("顶栏的名字", () => {
  it("**新起的一篇叫人起的那个名字**——正文空着、或随手敲了个字符，都不改它", async () => {
    const it_ = writer([], 10_000);
    await it_.writer.create("professional agent 的 eval");
    expect(it_.writer.state.title).toBe("professional agent 的 eval");
    expect(it_.writer.state.drafts[0]!.title).toBe("professional agent 的 eval");

    it_.writer.edit("\\`");
    await it_.writer.flush();
    expect(it_.writer.state.title).toBe("professional agent 的 eval");
    expect(it_.writer.state.drafts[0]!.title).toBe("professional agent 的 eval");
  });

  it("打开架上的一篇再打字，正文没标题行，架上的名字不动", async () => {
    const it_ = writer([draft("gemm", "## 小节\n\n正文")], 0);
    it_.store.list = async () => [{ id: "gemm", title: "triton is all you need 之 GEMM", excerpt: "", updatedAt: 1 }];
    await it_.writer.refresh();
    await it_.writer.open("gemm");
    it_.writer.edit("## 小节\n\n正文多了一句");
    await it_.writer.flush();
    expect(it_.writer.state.title).toBe("triton is all you need 之 GEMM");
    expect(it_.writer.state.drafts[0]!.title).toBe("triton is all you need 之 GEMM");
  });

  it("正文没有标题行时用架上的名字，不用正文第一行", async () => {
    // 那 92 篇的正文多半没有 H1（Hugo 自己渲染标题），第一行往往是个小节名。
    const it_ = writer([draft("gemm", "## 获取当前程序的全局索引\n\n正文…")]);
    // 内存 store 的 list 把 markdown 当 title；真实 store 给的是 frontmatter 的 title——
    // 这里直接把架上的名字放进列表，模拟真实形状。
    it_.store.list = async () => [{ id: "gemm", title: "triton is all you need 之 GEMM", excerpt: "", updatedAt: 1 }];
    await it_.writer.refresh();
    await it_.writer.open("gemm");
    expect(it_.writer.state.title).toBe("triton is all you need 之 GEMM");
  });

  it("正文有一级标题就用它——写的人刚敲下 `#` 那一行就该看到名字变", async () => {
    const it_ = writer([draft("x", "# 我起的名字\n\n正文")]);
    await it_.writer.refresh();
    await it_.writer.open("x");
    expect(it_.writer.state.title).toBe("我起的名字");
  });
});

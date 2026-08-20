import { describe, expect, it } from "vitest";
import {
  closeOnDesk,
  closeSettings,
  openDocOnDesk,
  openDraftOnDesk,
  openPageOnDesk,
  openSettings,
  rootOf,
  rememberOnDesk,
  type Active,
  type DeskItem,
} from "./desk";

const reading = (id: string): Active => ({ kind: "doc", id });
const writing = (id: string): Active => ({ kind: "draft", id });

const desk = (...ids: string[]): DeskItem[] =>
  ids.map((id) => ({ kind: "doc" as const, id, page: 1, pane: "clips" as const }));

describe("案头", () => {
  it("打开一本没开过的，接在最后", () => {
    expect(openDocOnDesk(desk("a"), "b").map((one) => one.id)).toEqual(["a", "b"]);
  });

  it("**已经在案头上的不重复、也不挪位置**——挪了的话人眼里的顺序会自己跳", () => {
    const before = openDocOnDesk(desk("a", "b", "c"), "a");

    expect(before.map((one) => one.id)).toEqual(["a", "b", "c"]);
  });

  it("重开一本已在案头的书，它记着的位置不丢", () => {
    const kept = rememberOnDesk(desk("a", "b"), "a", { page: 42 });

    expect(openDocOnDesk(kept, "a")[0]).toMatchObject({ page: 42 });
  });

  it("新开的一项从第 1 页、摘录栏开始", () => {
    expect(openDocOnDesk([], "a")[0]).toEqual({ kind: "doc", id: "a", page: 1, pane: "clips" });
  });

  it("记住页码和栏位，别的项不动", () => {
    const next = rememberOnDesk(desk("a", "b"), "b", { page: 88, pane: "chat" });

    expect(next[1]).toEqual({ kind: "doc", id: "b", page: 88, pane: "chat" });
    expect(next[0]).toEqual({ kind: "doc", id: "a", page: 1, pane: "clips" });
  });

  it("记一个不在案头上的，当没发生", () => {
    const list = desk("a");
    expect(rememberOnDesk(list, "x", { page: 5 })).toBe(list);
  });

  describe("书与稿子在同一列里（ADR-0004）", () => {
    it("**稿子不带页码和栏位**——它的位置由编辑器自己拿着", () => {
      expect(openDraftOnDesk([], "d1")[0]).toEqual({ kind: "draft", id: "d1" });
    });

    it("同名的一本书和一篇稿子是两项，不是一项", () => {
      const both = openDraftOnDesk(openDocOnDesk([], "同一个 id"), "同一个 id");

      expect(both).toHaveLength(2);
    });

    it("记住书的位置时，不会误伤同 id 的稿子", () => {
      const both = openDraftOnDesk(openDocOnDesk([], "x"), "x");

      expect(rememberOnDesk(both, "x", { page: 9 })).toEqual([
        { kind: "doc", id: "x", page: 9, pane: "clips" },
        { kind: "draft", id: "x" },
      ]);
    });
  });

  describe("关掉一项之后，活的是哪个", () => {
    it("关掉不活的那个，活的不变", () => {
      const { desk: next, active } = closeOnDesk(desk("a", "b", "c"), "doc", "c", reading("a"));

      expect(next.map((one) => one.id)).toEqual(["a", "b"]);
      expect(active).toEqual(reading("a"));
    });

    it("**关掉活的那个，接下面那一项**——手指停在原地，下一本自然顶上来", () => {
      const { active } = closeOnDesk(desk("a", "b", "c"), "doc", "b", reading("b"));

      expect(active).toEqual(reading("c"));
    });

    it("关掉最后一项时往上退——下面没有了", () => {
      const { active } = closeOnDesk(desk("a", "b", "c"), "doc", "c", reading("c"));

      expect(active).toEqual(reading("b"));
    });

    it("接班的可能是一篇稿子——两侧本来就在同一列里", () => {
      const both = openDraftOnDesk(desk("a"), "d1");

      expect(closeOnDesk(both, "doc", "a", reading("a")).active).toEqual(writing("d1"));
    });

    it("关掉唯一一本书就回书架", () => {
      const { desk: next, active } = closeOnDesk(desk("a"), "doc", "a", reading("a"));

      expect(next).toEqual([]);
      expect(active).toEqual({ kind: "shelf" });
    });

    it("**关掉唯一一篇稿子回稿子架，不是书架**——那等于把人从写作里踢回阅读", () => {
      const only = openDraftOnDesk([], "d1");

      expect(closeOnDesk(only, "draft", "d1", writing("d1")).active).toEqual({ kind: "writer" });
    });

    it("关一个不在案头上的，什么都不动", () => {
      const list = desk("a", "b");
      const { desk: next, active } = closeOnDesk(list, "doc", "x", reading("a"));

      expect(next).toBe(list);
      expect(active).toEqual(reading("a"));
    });
  });
});

describe("设置这一根", () => {
  it("关掉设置回到打开它之前那一样", () => {
    // 设置此前是盖在内容之上的原生 <dialog>，「关掉就回到刚才那一页」是浏览器白送的。
    // 做成根之后这一条要自己拿住：读了一半去改个模型，回来必须还在那本书上。
    // 掉回书架的话，读者得重新点开这本书——而换书是要重读 PDF、摘录和目录的。
    const reading: Active = { kind: "doc", id: "a" };

    expect(closeSettings(openSettings(reading))).toEqual(reading);
  });

  it("在设置里再点一次设置，不会把设置自己记成来路", () => {
    // 侧栏左下角那个按钮**一直在**，包括已经站在设置页上的时候。记成来路的话，
    // 点两次设置就再也退不回那本书了——而且退出去看起来还挺正常（退到了设置页）。
    const twice = openSettings(openSettings({ kind: "doc", id: "a" }));

    expect(closeSettings(twice)).toEqual({ kind: "doc", id: "a" });
  });

  it("从设置里直接点某个根，就是去那个根，不用先退出来", () => {
    // 三个根与设置平级（ADR-0003 决策 3：没有「模式」这一层）。设置不是一个要先退出
    // 的模态层，它就是列表上的一样，点别的就走。
    expect(closeSettings({ kind: "shelf" })).toEqual({ kind: "shelf" });
  });
});

describe("在设置里动案头", () => {
  it("关掉设置的来路那一项，设置跟着关——来路没了，它无处可退", () => {
    // 设置页开着的时候，侧栏那一列还在，人可以把自己刚才在读的那本从案头拿走。
    // 不管这一下的话，退出设置会回到一本**已经不在案头上的书**：界面照画，
    // 而那本书在侧栏里已经没有了。
    const desk = openDocOnDesk(openDocOnDesk([], "a"), "b");

    const next = closeOnDesk(desk, "doc", "a", openSettings({ kind: "doc", id: "a" }));

    expect(next.active).toEqual({ kind: "doc", id: "b" });
  });

  it("关掉案头上**别的**项，设置照开不误", () => {
    // 只有来路那一项才牵动设置。关掉旁边一本与设置无关，人不该被弹出去。
    const desk = openDocOnDesk(openDocOnDesk([], "a"), "b");
    const inSettings = openSettings({ kind: "doc", id: "a" });

    expect(closeOnDesk(desk, "doc", "b", inSettings).active).toEqual(inSettings);
  });

  it("关掉唯一一项，退回它那一侧的根，而不是停在设置里", () => {
    const only = openDraftOnDesk([], "d1");

    expect(closeOnDesk(only, "draft", "d1", openSettings({ kind: "draft", id: "d1" })).active).toEqual({
      kind: "writer",
    });
  });
});

describe("网页也进同一个案头", () => {
  const web = (id: string): DeskItem => ({ kind: "page", id, url: id, title: "" });

  it("网页的根是 Book 的书架，不是 Writer", () => {
    // `rootOf` 原来是个二选一的三元表达式（doc → shelf，其余 → writer）。
    // 加第三种时它会**默默把网页归到 Writer 名下**——案头上关掉最后一个网页，
    // 读者会莫名其妙掉进写作页。
    expect(rootOf("page")).toEqual({ kind: "shelf" });
  });

  it("网页和书混在同一列里，互不干扰", () => {
    const desk = [
      { kind: "doc" as const, id: "book", page: 1, pane: "clips" as const },
      web("https://example.com/a"),
    ];

    expect(openPageOnDesk(desk, "https://example.com/a", "https://example.com/a", "")).toBe(desk);
    expect(openPageOnDesk(desk, "https://example.com/b", "https://example.com/b", "")).toHaveLength(3);
  });

  it("关掉网页接下面那一项，接不到就回书架", () => {
    const desk = [web("https://a.com"), web("https://b.com")];
    const { active } = closeOnDesk(desk, "page", "https://a.com", { kind: "page", id: "https://a.com" });

    expect(active).toEqual({ kind: "page", id: "https://b.com" });
  });

  it("**同一个页面不会开两次**——身份用归一化过的 pageId", () => {
    // `?utm_source=` 不同不该变成两个条目。归一化在 `web/page-id.ts`，
    // 案头只认调用方给的 id，所以这条实际是在钉住「调用方必须给 pageId」这个约定。
    const desk = [web("https://example.com/a")];

    // 同一个 pageId 再开一次＝回到它，不新增。
    expect(openPageOnDesk(desk, "https://example.com/a", "https://example.com/a?utm_source=x", "")).toBe(desk);
  });
});

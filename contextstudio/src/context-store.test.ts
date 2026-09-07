import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContextStore } from "./context-store";
import type { Context } from "./context";
import { buildGraph } from "./graph";

const root = () => mkdtemp(path.join(tmpdir(), "contextstudio-"));

function context(id: string, patch: Partial<Context> = {}): Context {
  return {
    id,
    sourceClipId: "clip_" + id,
    source: { docId: "doc_1", title: "Attention Is All You Need", locator: "p.3" },
    claim: "断言 " + id,
    evidence: "The dominant sequence transduction models are based on complex networks.",
    stance: null,
    status: "pending",
    sourceClipDeleted: false,
    topics: [],
    ...patch,
  };
}

describe("ContextStore", () => {
  it("收下一条，再全量读回来——一模一样", async () => {
    const store = createContextStore(await root());
    const one = context("ctx_001", {
      claim: "纯 tag 匹配在库大了以后召回率会掉",
      stance: "support",
      topics: ["rag", "eval"],
    });

    await store.ingest("doc_1", [one]);

    expect(await store.all()).toEqual([one]);
  });

  // id 不稳或导入不幂等，draft 的 provenance 就会指向不存在的 context——而且不报错。
  // 这是 ADR-0002 里代价最大的一条。
  it("同一批导入两次，库里条数不变", async () => {
    const store = createContextStore(await root());
    const batch = [context("ctx_001"), context("ctx_002")];

    const first = await store.ingest("doc_1", batch);
    const second = await store.ingest("doc_1", batch);

    expect(await store.all()).toHaveLength(2);
    expect(first).toEqual({ added: 2, updated: 0, sourceDeleted: 0 });
    expect(second).toEqual({ added: 0, updated: 2, sourceDeleted: 0 });
  });

  // 导出层不填 topics（ADR-0002 ②），所以重导一次时导入的 topics 一定是空的。
  // 无脑整条替换 = 把读者定好的主题静默抹掉。
  it("重导不会抹掉读者已经填好的主题、立场和状态", async () => {
    const store = createContextStore(await root());
    await store.ingest("doc_1", [context("ctx_001")]);
    await store.update("ctx_001", { topics: ["rag"], stance: "refute", status: "approved" });

    await store.ingest("doc_1", [context("ctx_001")]);

    const [stored] = await store.all();
    expect(stored.topics).toEqual(["rag"]);
    expect(stored.stance).toBe("refute");
    expect(stored.status).toBe("approved");
  });

  // source 是上游的真相——书改了名、页码算法修了，重导要能带过来。
  it("重导会覆盖 source，上游说了算", async () => {
    const store = createContextStore(await root());
    await store.ingest("doc_1", [context("ctx_001")]);

    await store.ingest("doc_1", [
      context("ctx_001", {
        source: { docId: "doc_1", title: "Attention Is All You Need", locator: "p.4" },
      }),
    ]);

    const [stored] = await store.all();
    expect(stored.source.locator).toBe("p.4");
  });

  // **这一条曾经写反了。** 原测试叫「重导会覆盖 evidence，上游说了算」，理由是「摘录
  // 那边修了错字要能带过来」——听着合理，但它执行的是 ADR-0002 ③ 的反面。
  //
  // evidence 是逐字引文，Blog Studio 的 draft 会把它照抄进正文并留 provenance。悄悄改掉
  // 一句已经被引用的原文，是这个系统里最难发现的错：文章还在，引文变了，没人报错。
  // ADR 把它写成硬要求却只写在 prose 里，所以由存储这一侧执行。
  it("evidence 冻结在第一次入库那一刻，重导不覆盖", async () => {
    const store = createContextStore(await root());
    await store.ingest("doc_1", [context("ctx_001", { evidence: "打错的原文" })]);

    await store.ingest("doc_1", [context("ctx_001", { evidence: "改过的原文" })]);

    const [stored] = await store.all();
    expect(stored.evidence).toBe("打错的原文");
  });

  // ADR-0002 ① 把 id 列为「最容易漏、代价最大」的一条。id 由 (docId, clipId) 派生，
  // 而 docId 是书架目录名，带斜杠完全可能——落到别处而 all() 只收 <root>/*.md，
  // 那一条就这么没了，不报错。静默丢数据是这里唯一不能接受的失败方式。
  it("id 当不了文件名时抛，不静默丢掉这一条", async () => {
    const store = createContextStore(await root());

    await expect(store.ingest("doc_1", [context("doc_1/ctx_001")])).rejects.toThrow(/文件名/);
    await expect(store.ingest("doc_1", [context("../逃出去")])).rejects.toThrow(/文件名/);
  });

  // 没有 markSourceDeleted 方法：这个文档下库里有、这批没有的，就是来源被删了。
  // context 本身留着——它可能已经被 Blog Studio 引用了，删摘录不该连坐。
  it("这个文档下库里有、这批没有的，标成来源已删", async () => {
    const store = createContextStore(await root());
    await store.ingest("doc_1", [context("ctx_001"), context("ctx_002")]);

    const report = await store.ingest("doc_1", [context("ctx_001")]);

    const all = await store.all();
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === "ctx_002")!.sourceClipDeleted).toBe(true);
    expect(all.find((c) => c.id === "ctx_001")!.sourceClipDeleted).toBe(false);
    expect(report.sourceDeleted).toBe(1);
  });

  it("定域：导入一个文档不会碰到别的文档的 context", async () => {
    const store = createContextStore(await root());
    const other = { docId: "doc_2", title: "另一篇", locator: "p.1" };
    await store.ingest("doc_1", [context("ctx_001")]);
    await store.ingest("doc_2", [context("ctx_900", { source: other })]);

    const report = await store.ingest("doc_2", []);

    const all = await store.all();
    expect(all.find((c) => c.id === "ctx_001")!.sourceClipDeleted).toBe(false);
    expect(all.find((c) => c.id === "ctx_900")!.sourceClipDeleted).toBe(true);
    expect(report.sourceDeleted).toBe(1);
  });

  it("已经标过来源已删的，不重复计数", async () => {
    const store = createContextStore(await root());
    await store.ingest("doc_1", [context("ctx_001")]);
    await store.ingest("doc_1", []);

    const again = await store.ingest("doc_1", []);

    expect(again.sourceDeleted).toBe(0);
  });

  it("还没有任何 context 时，全量读是空的，不是报错", async () => {
    const store = createContextStore(path.join(await root(), "还不存在"));

    expect(await store.all()).toEqual([]);
  });

  // frontmatter 的标量用 JSON 编码，就是为了这一条：论文标题里有冒号和引号是常态。
  it("标题里的冒号引号、空 claim、多行 evidence 都能原样回来", async () => {
    const store = createContextStore(await root());
    const awkward = context("ctx_001", {
      source: { docId: "d", title: 'Attention Is All You Need: a "study"', locator: "§3.1" },
      claim: null,
      evidence: "第一行\n\n第二行，带一个冒号：还有引号「」",
      topics: ["multi word topic", "中文主题"],
    });

    await store.ingest("d", [awkward]);

    expect(await store.all()).toEqual([awkward]);
  });

  // 接口文档承诺的组合方式：store 负责存，buildGraph 是纯函数，两者不揉在一起。
  it("和 buildGraph 组合得起来", async () => {
    const store = createContextStore(await root());
    await store.ingest("doc_1", [
      context("ctx_001", { topics: ["rag"] }),
      context("ctx_002", { topics: ["rag"] }),
      context("ctx_003", { topics: [] }),
    ]);

    const graph = buildGraph(await store.all());

    expect(graph.edges).toEqual([{ a: "ctx_001", b: "ctx_002", topics: ["rag"] }]);
    expect(graph.nodes.find((node) => node.id === "ctx_003")!.degree).toBe(0);
  });
});

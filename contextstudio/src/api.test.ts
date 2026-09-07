import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "./context";
import { createContextStudio } from "./api";

const root = () => mkdtemp(path.join(tmpdir(), "contextstudio-api-"));

function context(id: string, topics: string[]): Context {
  return {
    id,
    sourceClipId: "clip_" + id,
    source: { docId: "doc_1", title: "某篇论文", locator: "p.1" },
    claim: "断言 " + id,
    evidence: "逐字原文 " + id,
    stance: null,
    status: "pending",
    sourceClipDeleted: false,
    topics,
  };
}

describe("createContextStudio", () => {
  // 这一条测的正是 code review 抓到的那个洞：四个模块各自有测试，但
  // `ingest → buildGraph → cluster → focusOn` 怎么串，此前代码里没有一行写着。
  it("入库之后，图、簇、聚焦三样都能从同一批 context 上算出来", async () => {
    const studio = createContextStudio(await root());
    await studio.ingest("doc_1", [
      context("rag_1", ["rag"]),
      context("rag_2", ["rag"]),
      context("rag_3", ["rag", "eval"]),
      context("bat_1", ["电池"]),
      context("bat_2", ["电池"]),
    ]);

    const view = await studio.view();

    expect(view.contexts).toHaveLength(5);
    expect(view.graph.nodes).toHaveLength(5);
    expect(view.clustering.clusters.map((one) => one.contexts)).toEqual([
      ["rag_1", "rag_2", "rag_3"],
      ["bat_1", "bat_2"],
    ]);

    const focus = await studio.focus("rag_1");
    expect(focus!.neighbors.map((one) => one.context.id).sort()).toEqual(["rag_2", "rag_3"]);
  });

  // 一次给全，而不是三个端点：分三次取会读到三个不同时刻的库，页面上就会出现
  // 「这条 context 在图里有、在簇里没有」。
  it("view 交出的三份必然自洽", async () => {
    const studio = createContextStudio(await root());
    await studio.ingest("doc_1", [context("a", ["rag"]), context("b", ["rag"])]);

    const view = await studio.view();
    const inClusters = view.clustering.clusters.flatMap((one) => one.contexts);

    expect([...inClusters, ...view.clustering.orphans].sort()).toEqual(
      view.contexts.map((one) => one.id).sort(),
    );
    expect(view.graph.nodes.map((one) => one.id).sort()).toEqual(
      view.contexts.map((one) => one.id).sort(),
    );
  });

  it("读者定的主题会改变图的形状", async () => {
    const studio = createContextStudio(await root());
    await studio.ingest("doc_1", [context("a", []), context("b", [])]);

    expect((await studio.view()).graph.edges).toEqual([]);

    await studio.update("a", { topics: ["rag"] });
    await studio.update("b", { topics: ["RAG"] });

    const view = await studio.view();
    expect(view.graph.edges).toHaveLength(1);
    // 大小写不同不该断边，但显示要保住读者写的那份。
    expect(view.graph.topics[0].display).toBe("rag");
  });

  it("空库不是错误，是新装应用的正常状态", async () => {
    const view = await createContextStudio(path.join(await root(), "还没建")).view();

    expect(view.contexts).toEqual([]);
    expect(view.clustering.clusters).toEqual([]);
  });

  // 重导之后某条 context 可能没了，而界面上还留着上次选中的 id。
  it("聚焦一个不存在的 id，给 null 而不是崩", async () => {
    const studio = createContextStudio(await root());

    expect(await studio.focus("没这条")).toBeNull();
  });
});

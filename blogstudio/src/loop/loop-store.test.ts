import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLoopStore } from "./loop-store";

const root = () => mkdtemp(path.join(tmpdir(), "loop-"));

describe("LoopStore", () => {
  it("一个 task 的三种处境，重启之后从磁盘上认得出来", async () => {
    const store = createLoopStore(await root());

    expect(await store.taskStates("研究 KV cache", 9, ["01", "02"])).toEqual([
      { id: "01", state: "not-started" },
      { id: "02", state: "not-started" },
    ]);

    // 意图**写在调用之前**——从这一刻起，这笔钱有可能已经花出去了。
    await store.beginTask("研究 KV cache", 9, "01", { model: "opus", capUsd: 0.3 });
    expect(await store.taskStates("研究 KV cache", 9, ["01", "02"])).toEqual([
      { id: "01", state: "maybe-charged" },
      { id: "02", state: "not-started" },
    ]);

    await store.finishTask("研究 KV cache", 9, "01", "# 找到 4 篇\n\n…");
    expect(await store.taskStates("研究 KV cache", 9, ["01", "02"])).toEqual([
      { id: "01", state: "done" },
      { id: "02", state: "not-started" },
    ]);
  });

  it("**report 就是一个 `.md`，原样躺在那儿**——外面的编辑器打开就能改（ADR-0011）", async () => {
    const dir = await root();
    const store = createLoopStore(dir);

    await store.beginTask("p", 9, "01", { model: "opus", capUsd: 0.3 });
    await store.finishTask("p", 9, "01", "\n# 找到 4 篇\n\n第一句\n\n");

    const at = path.join(dir, "p", "runs", "0009", "tasks", "01.report.md");
    // 首尾的空行也留着——**一个字都不加工**。顺手 trim 一下就是我们在替读者改稿。
    expect(await readFile(at, "utf8")).toBe("\n# 找到 4 篇\n\n第一句\n\n");
  });

  it("崩在写意图中途留下的半个文件，**不算意图**", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    await store.beginTask("p", 9, "02", { model: "opus", capUsd: 0.3 });
    // 上次崩在 `writeFile` 和 `rename` 之间，留下这么个东西。
    const tasks = path.join(dir, "p", "runs", "0009", "tasks");
    await writeFile(path.join(tasks, "01.intent.json.writing"), '{ "model": "op', "utf8");

    // 认下它，01 就会被当成「可能已花钱」而被挂起——**而它其实一次都没跑过**。
    expect(await store.taskStates("p", 9, ["01"])).toEqual([{ id: "01", state: "not-started" }]);
  });

  it("项目名带路径就拒绝——**别让一个坏名字静静地写到 root 外面去**", async () => {
    const store = createLoopStore(await root());

    const bad = ["..", "a/b", "a\\b", ""];
    for (const name of bad) {
      await expect(store.beginTask(name, 9, "01", { model: "opus", capUsd: 0.3 })).rejects.toThrow();
      await expect(store.finishTask("p", 9, name, "x")).rejects.toThrow();
    }
  });

  it("意图文件的内容坏了，照样算「可能已花钱」——**判据是它在不在，不是它写没写全**", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    await store.beginTask("p", 9, "01", { model: "opus", capUsd: 0.3 });
    const at = path.join(dir, "p", "runs", "0009", "tasks", "01.intent.json");
    await writeFile(at, '{ "model": "op', "utf8");

    // 靠解析内容来判断的话，一个截断的意图会被当成「没有意图」＝没跑过 ＝可以重跑，
    // 而它恰恰是最可能已经付过钱的那一个。所以只看文件在不在。
    expect(await store.taskStates("p", 9, ["01"])).toEqual([{ id: "01", state: "maybe-charged" }]);
  });

  it("列出每一轮：**最新在最上面**，而且 10 排在 9 上面（不是字典序）", async () => {
    const store = createLoopStore(await root());
    const at = (n: number) => ({
      n,
      phase: "wrap" as const,
      tasks: ["01"],
      done: ["01"],
      failed: [],
      skipped: [],
    });
    await store.saveRun("p", { ...at(9), startedAt: 100, endedAt: 200, capUsd: 1.5 });
    await store.saveRun("p", { ...at(10), startedAt: 300, endedAt: 400, capUsd: 2 });

    expect((await store.runs("p")).map((r) => r.n)).toEqual([10, 9]);
  });

  it("第 10000 轮排在第 9999 轮上面——补零只撑到四位，排序不能靠目录名", async () => {
    const store = createLoopStore(await root());
    const at = (n: number) => ({
      n,
      phase: "wrap" as const,
      tasks: [],
      done: [],
      failed: [],
      skipped: [],
      startedAt: n,
      endedAt: n,
      capUsd: 0,
    });
    await store.saveRun("p", at(9999));
    await store.saveRun("p", at(10000));

    // 目录名是 `9999` 和 `10000`，按字符串排 `10000` 会跑到前面去（"1" < "9"）。
    expect((await store.runs("p")).map((r) => r.n)).toEqual([10000, 9999]);
  });

  it("一轮的成绩单原样读回来——时间线上那一行就靠它", async () => {
    const store = createLoopStore(await root());
    const run = {
      n: 9,
      phase: "wrap" as const,
      tasks: ["01", "02", "03"],
      done: ["01"],
      failed: ["02"],
      skipped: ["03"],
      startedAt: 100,
      endedAt: 200,
      capUsd: 1.5,
    };

    await store.saveRun("p", run);

    expect(await store.runs("p")).toEqual([run]);
  });

  it("手改坏了一轮的成绩单，**别的轮次照样列得出来**", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    const at = (n: number) => ({
      n, phase: "wrap" as const, tasks: [], done: [], failed: [], skipped: [],
      startedAt: n, endedAt: n, capUsd: 0,
    });
    await store.saveRun("p", at(9));
    await store.saveRun("p", at(10));
    await writeFile(path.join(dir, "p", "runs", "0010", "run.md"), "---\n{ 手改坏了\n---\n", "utf8");

    // 第 10 轮读不出来，第 9 轮是无辜的——整条时间线不该跟着一起打不开。
    expect((await store.runs("p")).map((r) => r.n)).toEqual([9]);
  });

  it("只有目录、没有成绩单的，不算一轮", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    // `beginTask` 会先把 `tasks/` 建出来。此刻成绩单还没落地。
    await store.beginTask("p", 9, "01", { model: "opus", capUsd: 0.3 });

    expect(await store.runs("p")).toEqual([]);
  });

  it("列出每一轮时，坏项目名一样拒绝", async () => {
    const store = createLoopStore(await root());

    await expect(store.runs("../../etc")).rejects.toThrow();
  });

  it("一轮都没跑过的项目，列出来是空的——不是报错", async () => {
    const store = createLoopStore(await root());

    expect(await store.runs("还没开张")).toEqual([]);
  });

  it("把一轮的产出整个读回来：最终报告，加上每个 task 各自的", async () => {
    const store = createLoopStore(await root());
    const source = `---\n${JSON.stringify({ id: "01", title: "扫 arXiv", budget_usd: 0.3 })}\n---\n\n查 A`;
    await store.saveTaskFile("p", 9, "01", source);
    await store.finishTask("p", 9, "01", "# 找到 4 篇");
    await store.saveReport("p", 9, "# 周报");

    expect(await store.runDetail("p", 9)).toEqual({
      report: "# 周报",
      tasks: [{ id: "01", title: "扫 arXiv", source, report: "# 找到 4 篇" }],
    });
  });

  it("**没做完的 task 也列出来**——报告里说「有一件没成」，这里就得找得到它", async () => {
    const store = createLoopStore(await root());
    const source = `---\n${JSON.stringify({ id: "02", title: "看 commit", budget_usd: 0.3 })}\n---\n\n查 B`;
    await store.saveTaskFile("p", 9, "02", source);

    // 没有 report。列表里少了它的话，读者顺着报告里那句「02 没做成」翻过来会扑空。
    expect(await store.runDetail("p", 9)).toEqual({
      report: null,
      tasks: [{ id: "02", title: "看 commit", source, report: null }],
    });
  });

  it("这一轮还没有任何产出，也不该报错", async () => {
    const store = createLoopStore(await root());

    expect(await store.runDetail("p", 9)).toEqual({ report: null, tasks: [] });
  });

  it("**一份 task 的 frontmatter 坏了，这一页照样打得开**——人正是来查出了什么事的", async () => {
    const store = createLoopStore(await root());
    await store.saveTaskFile("p", 9, "01", "---\n{ 坏了\n---\n\n查 A");

    // 标题读不出来就用 id 顶着。为一个读不出的标题让整页崩掉，等于把出问题那一轮
    // 的现场一起锁上。
    expect((await store.runDetail("p", 9)).tasks).toEqual([
      { id: "01", title: "01", source: "---\n{ 坏了\n---\n\n查 A", report: null },
    ]);
  });

  it("task 按 id 排，跟落盘的先后无关", async () => {
    const store = createLoopStore(await root());
    const one = (id: string) => `---\n${JSON.stringify({ id, title: id, budget_usd: 0.3 })}\n---\n\n做`;
    // 故意乱序落盘：目录的返回顺序不保证，排序得自己来。
    for (const id of ["03", "01", "02"]) await store.saveTaskFile("p", 9, id, one(id));

    expect((await store.runDetail("p", 9)).tasks.map((t) => t.id)).toEqual(["01", "02", "03"]);
  });

  it("**默认是关着的**——建一个项目不该因为「建了」就开始花钱", async () => {
    const store = createLoopStore(await root());

    expect(await store.enabled("p")).toBe(false);
  });

  it("开了关了都记得住，重启之后还是那样", async () => {
    const dir = await root();
    await createLoopStore(dir).setEnabled("p", true);

    expect(await createLoopStore(dir).enabled("p")).toBe(true);

    await createLoopStore(dir).setEnabled("p", false);
    expect(await createLoopStore(dir).enabled("p")).toBe(false);
  });

  it("**开关不碰 `loop.md`**——那里面是人手写的两段 prompt", async () => {
    const dir = await root();
    const store = createLoopStore(dir);
    await mkdir(path.join(dir, "p"), { recursive: true });
    const config = "---\n{ \"everyHours\": 6, \"runCapUsd\": 3 }\n---\n\n## 排任务\n\n排\n\n## 收口\n\n收\n";
    await writeFile(path.join(dir, "p", "loop.md"), config, "utf8");

    await store.setEnabled("p", true);
    await store.setEnabled("p", false);

    // 一个字都不该动。界面去回写它，一次撞车就可能盖掉正在改的字。
    expect(await readFile(path.join(dir, "p", "loop.md"), "utf8")).toBe(config);
  });
});

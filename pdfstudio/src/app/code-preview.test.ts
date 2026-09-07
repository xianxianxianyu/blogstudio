import { describe, expect, it } from "vitest";
import { isDiagram, serial } from "./code-preview";

describe("isDiagram", () => {
  it("认得 mermaid", () => {
    expect(isDiagram("mermaid")).toBe(true);
  });

  it("不管大小写和两边的空白", () => {
    expect(isDiagram("Mermaid")).toBe(true);
    expect(isDiagram("  MERMAID ")).toBe(true);
  });

  it("别的语言不画图", () => {
    expect(isDiagram("ts")).toBe(false);
    expect(isDiagram("")).toBe(false);
  });

  it("latex 不归它管——那一路由 Crepe 自己接着", () => {
    expect(isDiagram("latex")).toBe(false);
  });

  it("Object 原型上的名字不算数", () => {
    // 查表最经典的那个洞：`DIAGRAM["constructor"]` 拿到的是 Object 的构造函数。
    expect(isDiagram("constructor")).toBe(false);
    expect(isDiagram("toString")).toBe(false);
  });
});

describe("serial", () => {
  it("一件一件来：前一件没完，后一件不许开始", async () => {
    const line = serial();
    const log: string[] = [];
    let letFirstFinish = () => {};

    const first = line(async () => {
      log.push("一开始");
      await new Promise<void>((ok) => (letFirstFinish = ok));
      log.push("一结束");
    });
    const second = line(async () => {
      log.push("二开始");
    });

    // 这一拍里第二件必须还没动过——**它一动，两张图的结果就可能倒着回来**。
    await Promise.resolve();
    expect(log).toEqual(["一开始"]);

    letFirstFinish();
    await Promise.all([first, second]);
    expect(log).toEqual(["一开始", "一结束", "二开始"]);
  });

  it("结果按调用顺序落地", async () => {
    const line = serial();
    const done: string[] = [];
    // 先发的那件慢，后发的那件快。不排队的话「快的」先落地，然后被「慢的」盖掉。
    const slow = line(() => wait(20).then(() => "旧"));
    const fast = line(() => Promise.resolve("新"));
    await Promise.all([slow.then((v) => done.push(v)), fast.then((v) => done.push(v))]);
    expect(done).toEqual(["旧", "新"]);
  });

  it("有一件抛了，队伍不能就堵在那儿", async () => {
    const line = serial();
    const boom = line(() => Promise.reject(new Error("画不出来")));
    await expect(boom).rejects.toThrow("画不出来");
    // **后面那件照样要跑。** 堵住的表现是所有图永远停在「渲染中」，而且不报错。
    await expect(line(() => Promise.resolve("下一张"))).resolves.toBe("下一张");
  });
});

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

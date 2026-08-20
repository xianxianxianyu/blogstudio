import { describe, expect, it, vi } from "vitest";
import { createEngineRegistry, type EngineRecord, type RegistryDeps } from "./engine-registry";

function harness(records: EngineRecord[], commands: Record<number, string | null> = {}) {
  let saved: EngineRecord[] = records;
  const killed: number[] = [];
  const deps: RegistryDeps = {
    load: () => Promise.resolve(saved),
    save: (next) => {
      saved = next;
      return Promise.resolve();
    },
    commandOf: (pid) => commands[pid] ?? null,
    kill: (pid) => void killed.push(pid),
  };
  return { deps, killed, saved: () => saved };
}

const at = (pid: number): EngineRecord => ({ id: "recognition", pid, port: 8000 + pid });

describe("engine registry", () => {
  it("收尸：上一次留下的、还活着的 llama-server 杀掉", async () => {
    const h = harness([at(101), at(102)], { 101: "llama-server", 102: "llama-server" });
    await expect(createEngineRegistry(h.deps).reap()).resolves.toBe(2);
    expect(h.killed).toEqual([101, 102]);
  });

  it("收完就清账：留着的话下次启动会去杀一批早就不存在的 pid", async () => {
    const h = harness([at(101)], { 101: "llama-server" });
    await createEngineRegistry(h.deps).reap();
    expect(h.saved()).toEqual([]);
  });

  it("已经不在的不动手", async () => {
    const h = harness([at(101)], {}); // commandOf 返回 null = 进程不存在
    await expect(createEngineRegistry(h.deps).reap()).resolves.toBe(0);
    expect(h.killed).toEqual([]);
  });

  it("**pid 被系统回收给了别人就不能杀**——只认 llama-server", async () => {
    const h = harness([at(101)], { 101: "Google Chrome Helper" });
    await expect(createEngineRegistry(h.deps).reap()).resolves.toBe(0);
    expect(h.killed).toEqual([]);
  });

  it("绝不杀自己：记错一次就是应用自杀，而且看起来像随机崩溃", async () => {
    const h = harness([at(process.pid)], { [process.pid]: "llama-server" });
    await expect(createEngineRegistry(h.deps).reap()).resolves.toBe(0);
    expect(h.killed).toEqual([]);
  });

  it("记一个：不覆盖已经记着的那些", async () => {
    const h = harness([at(101)]);
    await createEngineRegistry(h.deps).remember(at(202));
    expect(h.saved().map((r) => r.pid)).toEqual([101, 202]);
  });

  it("同一个 pid 记两次只留一条", async () => {
    const h = harness([at(101)]);
    await createEngineRegistry(h.deps).remember({ id: "embedding", pid: 101, port: 9999 });
    expect(h.saved()).toEqual([{ id: "embedding", pid: 101, port: 9999 }]);
  });

  it("自己停掉的要销账，别留给下次去杀", async () => {
    const h = harness([at(101), at(102)]);
    await createEngineRegistry(h.deps).forget(101);
    expect(h.saved().map((r) => r.pid)).toEqual([102]);
  });

  it("账本读不出来当没有：首次运行没这个文件是正常的，不能让它挡住启动", async () => {
    const deps: RegistryDeps = {
      load: () => Promise.reject(new Error("ENOENT")),
      save: () => Promise.resolve(),
      commandOf: () => null,
      kill: () => undefined,
    };
    await expect(createEngineRegistry(deps).reap()).resolves.toBe(0);
  });

  it("写不进去也不能把启动拦下来——收尸是清扫，不是主线", async () => {
    const deps: RegistryDeps = {
      load: () => Promise.resolve([at(101)]),
      save: () => Promise.reject(new Error("EROFS")),
      commandOf: () => "llama-server",
      kill: vi.fn(),
    };
    await expect(createEngineRegistry(deps).reap()).resolves.toBe(1);
    expect(deps.kill).toHaveBeenCalledWith(101);
  });
});

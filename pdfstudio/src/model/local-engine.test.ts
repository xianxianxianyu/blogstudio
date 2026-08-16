import { describe, expect, it } from "vitest";
import { createLocalEngine } from "./local-engine";
import type { EngineDeps } from "./local-engine";

const ASSETS = [
  { url: "https://example/model.gguf", target: "model.gguf", bytes: 892 },
  { url: "https://example/mmproj.gguf", target: "mmproj.gguf", bytes: 840 },
];

function deps(over: Partial<EngineDeps> = {}) {
  const calls = { fetched: [] as string[], spawned: 0, stopped: 0 };
  const present = new Set<string>();
  return {
    calls,
    present,
    deps: {
      assets: ASSETS,
      has: async (target: string) => present.has(target),
      fetch: async (asset: { url: string; target: string }) => {
        calls.fetched.push(asset.target);
        present.add(asset.target);
      },
      spawn: async () => {
        calls.spawned++;
        return { baseURL: "http://127.0.0.1:9999", stop: () => calls.stopped++ };
      },
      ...over,
    } as EngineDeps,
  };
}

describe("本地引擎", () => {
  it("缺文件时先下载再起进程", async () => {
    const { calls, deps: d } = deps();
    const engine = createLocalEngine(d);

    const { baseURL } = await engine.ensureReady();

    expect(calls.fetched).toEqual(["model.gguf", "mmproj.gguf"]);
    expect(calls.spawned).toBe(1);
    expect(baseURL).toBe("http://127.0.0.1:9999");
  });

  it("文件已在就不重下", async () => {
    const { calls, present, deps: d } = deps();
    present.add("model.gguf").add("mmproj.gguf");

    await createLocalEngine(d).ensureReady();

    expect(calls.fetched).toEqual([]);
  });

  it("重复调用只起一个进程", async () => {
    // 每次识别都会走一遍 ensureReady。不去重的话读者框第二下就多一个占着几 GB
    // 内存的 llama-server，而且没人知道它在。
    const { calls, deps: d } = deps();
    const engine = createLocalEngine(d);

    await Promise.all([engine.ensureReady(), engine.ensureReady()]);
    await engine.ensureReady();

    expect(calls.spawned).toBe(1);
  });

  it("启动失败不留下「已就绪」的假象，且能重试", async () => {
    // 失败的 promise 缓存住的话，这个实例此后每次调用都以同一个错误 reject，
    // 再也没有重试的路径——embedder 那边踩过一次，同一个形状。
    let attempt = 0;
    const { calls, deps: d } = deps({
      spawn: async () => {
        if (attempt++ === 0) throw new Error("端口被占用");
        calls.spawned++;
        return { baseURL: "http://127.0.0.1:9999", stop: () => calls.stopped++ };
      },
    });
    const engine = createLocalEngine(d);

    await expect(engine.ensureReady()).rejects.toThrow("端口被占用");
    await expect(engine.ensureReady()).resolves.toMatchObject({ baseURL: "http://127.0.0.1:9999" });
    expect(engine.status().running).toBe(true);
  });

  it("stop 之后状态归位，再 ensureReady 会重新起", async () => {
    const { calls, deps: d } = deps();
    const engine = createLocalEngine(d);
    await engine.ensureReady();

    engine.stop();
    expect(engine.status().running).toBe(false);
    await engine.ensureReady();

    expect(calls.stopped).toBe(1);
    expect(calls.spawned).toBe(2);
  });

  it("下载进度能看见，权重有 1.7 GB", async () => {
    // 不报进度的话就是几分钟毫无动静——向量模型那次的教训，那次只有 326 MB。
    const seen: (string | null)[] = [];
    const { deps: d } = deps();
    const engine = createLocalEngine({ ...d, onProgress: (text) => seen.push(text) });

    await engine.ensureReady();

    expect(seen.some((text) => text?.includes("model.gguf"))).toBe(true);
    // 结束时要把进度清掉，否则界面会一直挂着「正在启动…」。
    expect(seen.at(-1)).toBeNull();
  });
});

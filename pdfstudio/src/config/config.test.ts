import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig, resolveEndpoint, saveConfig } from "./config";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FLAT = {
  baseURL: "https://example.invalid/v1",
  apiKey: "sk-test",
  model: "gpt-5.6-sol",
};

describe("Config — 只配一个端点的读者", () => {
  it("扁平写法仍然有效，五个功能全部解析到它", () => {
    const config = parseConfig(FLAT);

    // ADR-0010 让配置按功能分组，但只配一个端点的读者不该被迫填五遍。
    // 而且既有的 config.json 就是这个形状，不能让它一夜失效。
    for (const capability of ["recognition", "translation", "chat", "embedding", "claim"] as const) {
      expect(resolveEndpoint(config, capability)).toEqual(FLAT);
    }
  });
});

describe("Config — 按字段回退", () => {
  it("只换模型时不用把 url 和 key 再抄一遍", () => {
    const config = parseConfig({
      default: FLAT,
      capabilities: { translation: { model: "fast-translator" } },
    });

    // 「同一个端点、翻译换个更快的模型」是最常见的配法。按组回退的话，
    // 这里就得把 baseURL 和 apiKey 原样再写一遍——配置项一多，抄漏就成了常态。
    expect(resolveEndpoint(config, "translation")).toEqual({ ...FLAT, model: "fast-translator" });
    expect(resolveEndpoint(config, "recognition")).toEqual(FLAT);
  });

  it("本地识别可以整组换掉，与云端 chat 并存", () => {
    const config = parseConfig({
      default: FLAT,
      capabilities: {
        recognition: {
          baseURL: "http://127.0.0.1:8080/v1",
          apiKey: "",
          model: "PaddleOCR-VL-1.6",
        },
      },
    });

    // ADR-0001 修订要的「本地/云端可选」落到配置上就是这个样子——
    // 识别指向本机 llama-server，其余仍走云端，Recognizer 一行都不用改。
    expect(resolveEndpoint(config, "recognition").baseURL).toBe("http://127.0.0.1:8080/v1");
    expect(resolveEndpoint(config, "chat")).toEqual(FLAT);
  });
});

describe("Config — 读写文件", () => {
  it("文件不存在时返回空配置，不抛错", async () => {
    const config = await loadConfig(path.join(tmpdir(), "definitely-not-there.json"));

    // 首次启动、还没配任何东西是正常状态，不是故障。
    expect(resolveEndpoint(config, "chat")).toEqual({ baseURL: "", apiKey: "", model: "" });
  });

  it("写回来的总是分组形式，即使读进去的是扁平的", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "config-")), "config.json");
    await writeFile(file, JSON.stringify(FLAT), "utf8");

    const config = await loadConfig(file);
    await saveConfig(file, config);

    // 同一份配置不该在两种形态之间来回漂——读的时候认两种，写的时候只写一种。
    const written = JSON.parse(await readFile(file, "utf8")) as { default: unknown };
    expect(written.default).toEqual(FLAT);
    expect(resolveEndpoint(await loadConfig(file), "recognition")).toEqual(FLAT);
  });
});

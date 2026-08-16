import { describe, expect, it } from "vitest";
import { fieldSource, parseConfig, resolveEndpoint } from "./config";
import type { AppConfig } from "./config";
import { loadConfig, saveConfig } from "./config-file";
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

describe("某一栏是自己配的还是跟随默认组", () => {
  const config: AppConfig = {
    default: { baseURL: "https://a", apiKey: "k", model: "m" },
    capabilities: { translation: { model: "fast" }, recognition: { baseURL: "" } },
    retention: { ttlDays: 7, acknowledged: false },
    localRecognition: false,
  };

  it("自己写了就是自己的", () => {
    expect(fieldSource(config, "translation", "model")).toBe("own");
  });

  it("没写就是跟随默认组", () => {
    // 界面上必须能看出这个区别，否则读者改了默认组会**意外影响到**
    // 他以为已经独立配置的功能。
    expect(fieldSource(config, "translation", "baseURL")).toBe("inherited");
    expect(fieldSource(config, "chat", "model")).toBe("inherited");
  });

  it("显式写成空串也是自己的", () => {
    // 「我就是要它为空」和「我没配、跟着默认走」是两回事：本地模型不需要 apiKey，
    // 显式清空是一种真实配法。按真假值判会把它误认成未配置，然后偷偷灌进默认组的 key
    // ——那把云端的 key 发给了本地端点。
    expect(fieldSource(config, "recognition", "baseURL")).toBe("own");
  });
});

describe("回收策略配置", () => {
  it("默认 7 天，且默认**没有**确认过", async () => {
    // acknowledged 默认 false 是要害：ADR-0012 说首次运行必须显式告知，而删完再说
    // 不叫告知。默认 true 的话，读者第一次打开应用就可能已经丢了东西。
    const config = parseConfig(null);

    expect(config.retention).toEqual({ ttlDays: 7, acknowledged: false });
  });

  it("旧配置文件没有这一段，读成默认值而不是 undefined", async () => {
    const config = parseConfig({ baseURL: "https://a", apiKey: "k", model: "m" });

    expect(config.retention.ttlDays).toBe(7);
    expect(config.retention.acknowledged).toBe(false);
  });

  it("改过的天数与确认状态存得住", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "cfg-")), "config.json");
    const config = parseConfig(null);

    await saveConfig(file, { ...config, retention: { ttlDays: 30, acknowledged: true } });

    expect((await loadConfig(file)).retention).toEqual({ ttlDays: 30, acknowledged: true });
  });
});

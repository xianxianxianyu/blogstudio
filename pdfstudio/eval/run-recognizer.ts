/**
 * 拿真实模型跑 Recognizer 的视觉路由，人眼对照 manifest。
 *
 * **不是单元测试**：真模型不确定、要花钱、要网络，混进红绿循环会让测试变成薛定谔的。
 * 这里回答的是单元测试回答不了的那个问题——真实模型会不会按我们要求的 JSON 契约作答，
 * kind 分得准不准，公式的 LaTeX 能不能用。`npm run test:pdfstudio` 里的 fake 只会
 * 复述我写进去的东西，prompt 写得再烂也全绿。
 *
 *   npm run eval:recognizer              # 跑全部 19 张样本
 *   npm run eval:recognizer -- f05 g01   # 只跑指定的几张
 *
 * 配置：把 pdfstudio/config.example.json 抄成 pdfstudio/config.json 填上 key。
 * 该文件已 gitignore（ADR-0005：真实 key 绝不进源码或构建产物）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRecognizer } from "../src/recognizer/recognizer";
import type { Screenshot } from "../src/recognizer/recognizer";
import { createModelClient } from "../src/model/openai-compatible";
import { openFixturePdf } from "../test/fixtures";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");

interface Sample {
  id: string;
  type: string;
  paper: string;
  page: number;
  note: string;
}

/** manifest 是唯一真相，别在这里再抄一份样本清单。 */
async function readManifest(): Promise<Sample[]> {
  const markdown = await readFile(path.join(HERE, "samples", "manifest.md"), "utf8");
  const samples: Sample[] = [];

  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const [, id, type, source, note] = cells;
    if (!/^[fgpm]\d\d$/.test(id)) continue;

    const arxiv = source.match(/arXiv:([\d.]+)/);
    const page = source.match(/p\.(\d+)/);
    if (!arxiv || !page) continue;

    samples.push({ id, type, paper: `${arxiv[1]}.pdf`, page: Number(page[1]), note });
  }

  return samples;
}

async function loadScreenshot(id: string): Promise<Screenshot> {
  const bytes = new Uint8Array(await readFile(path.join(HERE, "samples", `${id}.png`)));
  // 300 DPI 渲染后裁剪（见 manifest），换算回 PDF 点只用于填 Screenshot 的尺寸字段。
  return { mime: "image/png", bytes, width: 0, height: 0 };
}

interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
}

async function loadConfig(): Promise<Config | null> {
  try {
    return JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8")) as Config;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const samples = (await readManifest()).filter(
    (sample) => wanted.length === 0 || wanted.includes(sample.id),
  );

  if (samples.length === 0) {
    console.error(`没有匹配的样本：${wanted.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();

  // 没配置也先把认出来的样本列出来，好确认 manifest 解析没歪。
  if (!config?.apiKey) {
    console.log(`manifest 认出 ${samples.length} 张样本：`);
    for (const sample of samples) {
      console.log(`  ${sample.id}  ${sample.type.padEnd(9)} ${sample.paper} p.${sample.page}`);
    }
    console.error(
      config === null
        ? "\n还没有 pdfstudio/config.json。把 config.example.json 抄一份过去、填上 apiKey 再跑。"
        : "\npdfstudio/config.json 里的 apiKey 是空的——先填上再跑。",
    );
    process.exitCode = 1;
    return;
  }

  const model = createModelClient(config);
  console.log(`模型 ${config.model} @ ${config.baseURL}，共 ${samples.length} 张\n`);

  for (const sample of samples) {
    const document = await openFixturePdf(sample.paper);
    const recognizer = createRecognizer({ document, model });
    const pixels = await loadScreenshot(sample.id);

    console.log(`── ${sample.id}  [manifest: ${sample.type}]  ${sample.note}`);

    try {
      // 强制 vision：样本是裁好的 PNG，manifest 没记页面坐标，覆盖检测无从下手。
      const content = await recognizer.recognize(
        { page: sample.page, rect: { x: 0, y: 0, width: 100, height: 100 }, pixels },
        { engine: "vision" },
      );

      console.log(`   sourceText  ${preview(content.sourceText)}`);
      console.log(`   translation ${preview(content.translation ?? null)}`);
      console.log(`   multimodal  ${preview(content.multimodal ?? null)}`);
    } catch (error) {
      const { kind, message } = error as { kind?: string; message: string };
      console.log(`   ✗ ${kind ?? "error"}：${message}`);
    }
    console.log();
  }
}

function preview(value: string | null): string {
  if (value === null) return "null";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

await main();

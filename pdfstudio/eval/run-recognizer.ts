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
 *   npm run eval:recognizer -- --local   # 端点是只认固定 prompt 的专用识别模型
 *                                        #（PaddleOCR-VL 之类，见 ADR-0001 修订的准入门槛）
 *
 * 配置：把 pdfstudio/config.example.json 抄成 pdfstudio/config.json 填上 key。
 * 该文件已 gitignore（ADR-0005：真实 key 绝不进源码或构建产物）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRecognizer } from "../src/recognizer/recognizer";
import type { Screenshot, VisionKind } from "../src/recognizer/recognizer";
import { createModelClient } from "../src/model/openai-compatible";
import { createFixedPromptRecognitionClient } from "../src/model/fixed-prompt-recognition";
import { openFixturePdf } from "../test/fixtures";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");

/**
 * manifest 的 type 与 kind 词表的对应。值的类型绑到 `VisionKind`，prompt 改词表时
 * 这里编译不过——此前是一份手抄的 `Record<string, string>`，词表变了 eval 会静默失准。
 *
 * `paragraph → mixed` 是**凑合映射**：那 4 张是被强制走 vision 的纯文本区，
 * kind 词表里没有更贴切的选项。所以 19/19 这个数里有 4 张的判定基准偏软，
 * ADR-0001 拿它当本地模型准入门槛时要知道这一点。
 */
const EXPECTED_KIND: Record<string, VisionKind> = {
  formula: "formula",
  figure: "figure",
  table: "figure",
  paragraph: "mixed",
  mixed: "mixed",
};

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
    const [, id, type, source] = cells;
    if (!/^[fgpm]\d\d$/.test(id)) continue;
    // 说明一栏里本身含 `|`（数学条件概率），按列切会把它截断——重新拼回去。
    const note = cells.slice(4, -2).join("|");

    const arxiv = source.match(/arXiv:([\d.]+)/);
    const page = source.match(/p\.(\d+)/);
    if (!arxiv || !page) continue;

    samples.push({ id, type, paper: `${arxiv[1]}.pdf`, page: Number(page[1]), note });
  }

  return samples;
}

async function loadScreenshot(id: string): Promise<Screenshot> {
  const bytes = new Uint8Array(await readFile(path.join(HERE, "samples", `${id}.png`)));
  // 尺寸字段填 0：模型读的是 bytes，这两个数在视觉路由上无人消费。
  // 真要用时应从 PNG 头解析，而不是让假值一直躺在领域类型里。
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
  const argv = process.argv.slice(2);
  const local = argv.includes("--local");
  const wanted = argv.filter((arg) => !arg.startsWith("--"));
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

  // 包一层录音：模型自报的 kind 被 Recognizer 在出口消费掉，不进 ClipContent
  // （canonical 接口本来就没这个字段）。但 eval 要判的恰恰是它分得准不准，
  // 所以在缝上录下原始回答。
  const raw: string[] = [];
  const endpoint = createModelClient(config);
  // --local：端点只认六个固定 prompt，看不懂我们的 JSON 契约，套一层翻译。
  const inner = local ? createFixedPromptRecognitionClient(endpoint) : endpoint;
  const model: typeof inner = {
    async complete(request) {
      const response = await inner.complete(request);
      raw.push(response.text);
      return response;
    },
    streamComplete: inner.streamComplete.bind(inner),
  };

  console.log(`模型 ${config.model} @ ${config.baseURL}，共 ${samples.length} 张`);
  if (local) {
    console.log("固定 prompt 模式：统一用 `OCR:`，kind 由「有没有认出字」合成。");
    console.log("**公式那 6 张拿不到 LaTeX**——这是本地档相对云端的已知实质损失，正是要量的东西。\n");
  } else {
    console.log("");
  }

  // kind 是确定性可判的，自动算合规率；内容正确性（LaTeX 对不对、描述准不准）
  // 仍然人眼看——manifest 明写本 eval 不做自动打分。
  let matched = 0;
  let failed = 0;

  for (const sample of samples) {
    const document = await openFixturePdf(sample.paper);
    const recognizer = createRecognizer({ document, recognition: model });
    const pixels = await loadScreenshot(sample.id);

    console.log(`── ${sample.id}  [manifest: ${sample.type}]  ${sample.note}`);
    raw.length = 0;

    try {
      // 强制 vision：样本是裁好的 PNG，manifest 没记页面坐标，覆盖检测无从下手。
      const content = await recognizer.recognize(
        { page: sample.page, rect: { x: 0, y: 0, width: 100, height: 100 }, pixels },
        { route: "vision" },
      );

      const kind = (JSON.parse(raw[0] ?? "{}") as { kind?: string }).kind ?? "（没报）";
      const expected = EXPECTED_KIND[sample.type];
      if (kind === expected) matched++;
      console.log(`   kind        ${kind}${kind === expected ? "" : `  ← manifest 期待 ${expected}`}`);
      console.log(`   sourceText  ${preview(content.sourceText)}`);
      console.log(`   translation ${preview(content.translation ?? null)}`);
      console.log(`   multimodal  ${preview(content.multimodal ?? null)}`);
    } catch (error) {
      const { kind, message } = error as { kind?: string; message: string };
      failed++;
      console.log(`   ✗ ${kind ?? "error"}：${message}`);
    }
    console.log();
  }

  console.log(`kind 与 manifest 一致 ${matched}/${samples.length}${failed > 0 ? `，另有 ${failed} 张调用失败` : ""}`);
  console.log("内容正确性（LaTeX、描述）请对照 PDF 目检——ADR-0001 的准入门槛是");
  console.log("「可比的 kind 合规率**与公式 LaTeX 质量**」，后者这个 runner 只负责打印，不打分。");
  console.log("公式那 6 张（f01–f06）的 sourceText 就是要核的 LaTeX。");
}

function preview(value: string | null): string {
  if (value === null) return "null";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

await main();

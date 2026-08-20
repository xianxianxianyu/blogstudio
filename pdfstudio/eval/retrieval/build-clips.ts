/**
 * 拿识别 eval 的样本生成一批真实摘录，缓存成 JSON 供检索 eval 用。
 *
 *   npm run eval:clips
 *
 * 为什么要缓存：检索 eval 每次都跑一遍视觉识别的话，既慢又要花钱，而且**同一份语料
 * 每次都不一样**——那样「加了摘录之后指标塌没塌」就分不清是摘录的作用还是模型的抖动。
 * 生成一次、钉住，之后的比较才是受控的。
 *
 * 这批摘录的价值恰恰在于它们是真的：公式那 6 张给出的是模型认出来的 LaTeX，图表那几张
 * 给出的是模型写的描述——正是 pdf.js 文本层给不出、而摘录索引要补上的两类。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRecognizer } from "../../src/recognizer/recognizer";
import { createModelClient } from "../../src/model/openai-compatible";
import { resolveEndpoint } from "../../src/config/config";
import { loadConfig } from "../../src/config/config-file";
import { openFixturePdf } from "../../test/fixtures";
import type { Clip } from "../../src/clip/clip";
import type { Screenshot } from "../../src/recognizer/recognizer";

const HERE = import.meta.dirname;
const SAMPLES = path.join(HERE, "..", "samples");
const OUT = path.join(HERE, "clips.json");

interface Sample {
  id: string;
  paper: string;
  page: number;
}

/** manifest 是唯一真相，别在这里再抄一份样本清单。 */
async function readManifest(): Promise<Sample[]> {
  const markdown = await readFile(path.join(SAMPLES, "manifest.md"), "utf8");
  const samples: Sample[] = [];

  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const [, id, , source] = cells;
    if (!/^[fgpm]\d\d$/.test(id)) continue;
    const arxiv = source.match(/arXiv:([\d.]+)/);
    const page = source.match(/p\.(\d+)/);
    if (arxiv && page) samples.push({ id, paper: `${arxiv[1]}.pdf`, page: Number(page[1]) });
  }

  return samples;
}

async function main(): Promise<void> {
  const config = resolveEndpoint(
    await loadConfig(path.join(HERE, "..", "..", "config.json")),
    "recognition",
  );
  if (!config.apiKey) {
    console.error("pdfstudio/config.json 的 apiKey 是空的。填上再跑。");
    process.exitCode = 1;
    return;
  }

  const samples = await readManifest();
  const model = createModelClient(config);
  const clips: Record<string, Clip[]> = {};

  console.log(`拿 ${config.model} 生成 ${samples.length} 条摘录…\n`);

  for (const sample of samples) {
    const document = await openFixturePdf(sample.paper);
    // 翻译显式关掉：这批摘录是给检索用的，译文另有一条真实链路，混进来会让
    // 「哪一部分带来了召回」说不清。
    const recognizer = createRecognizer({ document, recognition: model, translation: null });
    const bytes = new Uint8Array(await readFile(path.join(SAMPLES, `${sample.id}.png`)));
    const pixels: Screenshot = { mime: "image/png", bytes, width: 0, height: 0 };
    const rect = { x: 0, y: 0, width: 100, height: 100 };

    try {
      // 强制 vision：样本是裁好的 PNG，manifest 没记页面坐标，覆盖检测无从下手。
      const content = await recognizer.recognize({ page: sample.page, rect, pixels }, { route: "vision" });
      (clips[sample.paper] ??= []).push({
        id: sample.id,
        state: "ready",
        region: { page: sample.page, rect, pixels },
        content: { ...content, images: [], screenshot: pixels },
        sourceText: content.sourceText,
        translation: null,
        note: null,
        label: "dot",
        important: true,
        anchorStatus: "anchored",
        tagId: null,
        title: null,
        lastViewedAt: 0,
      });
      const preview = (content.sourceText ?? content.multimodal ?? "").replace(/\s+/g, " ").slice(0, 70);
      console.log(`  ${sample.id}  ${content.route.padEnd(6)} ${preview}`);
    } catch (error) {
      console.log(`  ${sample.id}  ✗ ${(error as Error).message}`);
    }
  }

  // 字节不写进 JSON：检索只吃文本，而 19 张 PNG 会让这个文件涨到几 MB
  // 且没有任何一处会读它。
  const slim = Object.fromEntries(
    Object.entries(clips).map(([paper, list]) => [
      paper,
      list.map((clip) => ({
        ...clip,
        region: { ...clip.region, pixels: undefined },
        content: clip.content && { ...clip.content, screenshot: undefined, images: [] },
      })),
    ]),
  );
  await writeFile(OUT, `${JSON.stringify(slim, null, 2)}\n`, "utf8");
  console.log(`\n写入 ${path.relative(process.cwd(), OUT)}`);
}

await main();

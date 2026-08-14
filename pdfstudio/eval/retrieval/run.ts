/**
 * 跑 `eval/retrieval/questions.md`，量 Chat 内部检索缝把问题定位到正确页的能力。
 *
 * **不是单元测试**：它测的是 Chat 的**内部缝**（切块 + 打分），而单元测试只站在
 * `ask` 上。两者分工不同——契约与不变量由测试守，检索质量由这里量。
 *
 *   npm run eval:retrieval
 *
 * **这套数据集判不了模型选型**（3 篇论文、29 条问题，而候选间差距约 3 个百分点）。
 * 它判得了的是「换上 embedding 有没有修好中文零召回」「双栏读序修好后有没有改善」
 * 这类效应量大一个数量级的问题。详见 README 末节。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { openFixturePdf } from "../../test/fixtures";
import { buildIndex, searchChunks } from "../../src/chat/retrieval";
import type { Chunk } from "../../src/chat/retrieval";
import { createTransformersEmbedder } from "../../src/model/transformers-embedder";

const HERE = import.meta.dirname;

/** recall@k 的 k 取实际喂给 LLM 的块数，不用 nDCG——见 README。 */
const KS = [1, 3];

interface Question {
  id: string;
  lang: string;
  question: string;
  paper: string;
  /** null 表示「文档答不了」，验的是不变量⑤。 */
  page: number | null;
}

async function readQuestions(): Promise<Question[]> {
  const markdown = await readFile(path.join(HERE, "questions.md"), "utf8");
  const questions: Question[] = [];

  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const [, id, lang, question, source, page] = cells;
    if (!/^(zh|en|na)-\d\d$/.test(id)) continue;

    const arxiv = source.match(/arXiv:([\d.]+)/);
    if (!arxiv) continue;

    questions.push({
      id,
      lang,
      question,
      paper: `${arxiv[1]}.pdf`,
      page: /^\d+$/.test(page) ? Number(page) : null,
    });
  }

  return questions;
}

interface Outcome {
  question: Question;
  /** 检索到的块所在页，按打分降序。 */
  pages: number[];
}

function hitAt(outcome: Outcome, k: number): boolean {
  return outcome.question.page !== null && outcome.pages.slice(0, k).includes(outcome.question.page);
}

function rate(outcomes: Outcome[], k: number): string {
  if (outcomes.length === 0) return "  —  ";
  const hits = outcomes.filter((outcome) => hitAt(outcome, k)).length;
  return `${((hits / outcomes.length) * 100).toFixed(1).padStart(5)}%`;
}

async function main(): Promise<void> {
  // --embed：接本地 embedding（首次会下载权重）。不加就是关键词基线。
  const useEmbedder = process.argv.slice(2).includes("--embed");
  const embedder = useEmbedder ? createTransformersEmbedder() : undefined;

  const questions = await readQuestions();
  const indexes = new Map<string, Chunk[]>();

  if (useEmbedder) console.log("检索：本地 embedding（首次运行要下载权重，请稍候）\n");
  else console.log("检索：关键词基线\n");

  const outcomes: Outcome[] = [];
  for (const question of questions) {
    if (!indexes.has(question.paper)) {
      indexes.set(
        question.paper,
        await buildIndex(await openFixturePdf(question.paper), embedder),
      );
    }
    const chunks = await searchChunks(
      indexes.get(question.paper)!,
      question.question,
      Math.max(...KS),
      embedder,
    );
    outcomes.push({ question, pages: chunks.map((chunk) => chunk.page) });
  }

  // 「答不了」的题也带 lang，但它们没有正确页，混进 recall 的分母会把成绩冲淡。
  const answerable = outcomes.filter((outcome) => outcome.question.page !== null);
  const zh = answerable.filter((outcome) => outcome.question.lang === "zh");
  const en = answerable.filter((outcome) => outcome.question.lang === "en");
  const na = outcomes.filter((outcome) => outcome.question.page === null);

  console.log(`语料 ${indexes.size} 篇，问题 ${questions.length} 条（zh ${zh.length} / en ${en.length} / 答不了 ${na.length}）\n`);

  console.log("           recall@1  recall@3");
  console.log(`中文      ${rate(zh, 1)}     ${rate(zh, 3)}`);
  console.log(`英文      ${rate(en, 1)}     ${rate(en, 3)}`);

  // 那 6 条英文题是 6 条中文题的逐句对译（同页同依据），所以 Δ 就是跨语言净损失，
  // 没有别的变量能背锅。
  for (const k of KS) {
    const zhHits = zh.filter((outcome) => hitAt(outcome, k)).length / (zh.length || 1);
    const enHits = en.filter((outcome) => hitAt(outcome, k)).length / (en.length || 1);
    console.log(`Δ@${k}（跨语言净损失）  ${((enHits - zhHits) * 100).toFixed(1)} 个百分点`);
  }

  const abstained = na.filter((outcome) => outcome.pages.length === 0).length;
  console.log(`\n答不了的问题正确返回空：${abstained}/${na.length}`);
  console.log("⚠ 这一项必须与中文 recall 并排看——永远返回空就是满分。");

  const zhEmpty = zh.filter((outcome) => outcome.pages.length === 0).length;
  if (zhEmpty === zh.length && na.length > 0) {
    console.log(`  当前正是这种情况：${zh.length} 条中文题全部返回空，abstention 是白送的。`);
  }

  console.log("\n未命中的中文题：");
  for (const outcome of zh.filter((o) => !hitAt(o, Math.max(...KS)))) {
    const got = outcome.pages.length > 0 ? `检索到 p.${outcome.pages.join("/")}` : "什么都没检索到";
    console.log(`  ${outcome.question.id}  期待 p.${outcome.question.page}，${got}`);
  }
}

await main();

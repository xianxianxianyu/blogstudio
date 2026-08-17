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
import { defaultTags } from "../../src/tag/tag";
import { buildIndex, searchChunks, scoreChunks, peakMargin } from "../../src/chat/retrieval";
import type { Clip } from "../../src/clip/clip";
import type { Chunk } from "../../src/chat/retrieval";
import { createTransformersEmbedder } from "../../src/model/transformers-embedder";
import { createLlamaEmbedder } from "../../src/model/llama-embedder";
import { retrievalQuery } from "../../src/chat/chat";

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
    if (!/^(zh|en|na|cl|fu|tg)-\d\d$/.test(id)) continue;

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
  /** 与 pages 一一对应的相似度；关键词模式下为空。 */
  scores: number[];
  /** top-1 高出背景分布多少。命中判据用它，不用绝对余弦——见 retrieval.ts。 */
  margin: number;
  /**
   * **未经门槛过滤、但走生产排序路径（RRF 融合）**的结果。扫描曲线必须用它：
   * 用 pages 会在已经切过的数据上再切一次；用纯向量排序则标定出的阈值与生产路径
   * 不是同一个口径。
   */
  rankedPages: number[];
}

function hitAt(outcome: Outcome, k: number): boolean {
  return outcome.question.page !== null && outcome.pages.slice(0, k).includes(outcome.question.page);
}

function rate(outcomes: Outcome[], k: number): string {
  if (outcomes.length === 0) return "  —  ";
  const hits = outcomes.filter((outcome) => hitAt(outcome, k)).length;
  return `${((hits / outcomes.length) * 100).toFixed(1).padStart(5)}%`;
}

/**
 * 这一条题拿什么去检索。
 *
 * 追问题写成 `前一问 ‖ 追问`，在这里还原成两轮对话，**再交给生产的那条规则**
 * （`retrievalQuery`）去拼——不自己实现一遍。eval 与生产在参数上对不上的亏已经吃过
 * 一次：生产喂 top-1 而这里量 recall@3，于是汇报的数字模型根本看不到。
 */
function queryFor(question: Question): string {
  if (!question.question.includes("‖")) return question.question;
  const [first, follow] = question.question.split("‖").map((part) => part.trim());
  return retrievalQuery([
    { role: "user", parts: [{ kind: "text", text: first }] },
    { role: "assistant", parts: [{ kind: "text", text: "（上一轮的回答）" }] },
    { role: "user", parts: [{ kind: "text", text: follow }] },
  ]);
}

async function main(): Promise<void> {
  // --embed：接本地 embedding（首次会下载权重）。不加就是关键词基线。
  const useEmbedder = process.argv.slice(2).includes("--embed");
  // --clips：把摘录也放进检索池。语料由 `npm run eval:clips` 生成一次并钉住——
  // 每次现跑视觉识别的话，「加了摘录之后指标塌没塌」就分不清是摘录的作用还是模型抖动。
  const useClips = process.argv.slice(2).includes("--clips");
  const clipsByPaper: Record<string, Clip[]> = useClips
    ? (JSON.parse(await readFile(path.join(import.meta.dirname, "clips.json"), "utf8")) as Record<string, Clip[]>)
    : {};
  // PDFSTUDIO_EMBED_URL 指向一个 llama-server 的 /v1，就换成它算向量。
  // 换推理后端必须重新量：Q8_0 GGUF 与 q8 ONNX 是不同的量化方案，不能假设等价。
  const embedder = !useEmbedder
    ? undefined
    : process.env.PDFSTUDIO_EMBED_URL
      ? createLlamaEmbedder(process.env.PDFSTUDIO_EMBED_URL)
      : createTransformersEmbedder();

  const questions = await readQuestions();
  const indexes = new Map<string, Chunk[]>();

  if (useEmbedder) console.log(`检索：本地 embedding（${process.env.PDFSTUDIO_EMBED_URL ? "llama.cpp" : "onnxruntime"}）`);
  else console.log("检索：关键词基线");
  console.log(
    useClips
      ? `摘录：进池，共 ${Object.values(clipsByPaper).flat().length} 条\n`
      : "摘录：不进池（正文块基线）\n",
  );

  const outcomes: Outcome[] = [];
  for (const question of questions) {
    if (!indexes.has(question.paper)) {
      indexes.set(
        question.paper,
        await buildIndex(
          await openFixturePdf(question.paper),
          embedder,
          clipsByPaper[question.paper] ?? [],
          undefined,
          defaultTags(),
        ),
      );
    }
    const index = indexes.get(question.paper)!;

    if (embedder) {
      // 一次打分、多个阈值：扫描时不重跑 embedding。
      const query = queryFor(question);
      const chunks = await searchChunks(index, query, Math.max(...KS), embedder);
      const scored = await scoreChunks(index, query, embedder);
      // 门槛设成 -Infinity 拿到未过滤但**同样经过 RRF 融合**的排序——
      // 曲线与生产路径口径一致，标定出的数才能直接填回去。
      const ungated = await searchChunks(
        index,
        query,
        Math.max(...KS),
        embedder,
        -Infinity,
      );
      outcomes.push({
        question,
        pages: chunks.map((chunk) => chunk.page),
        scores: scored.slice(0, Math.max(...KS)).map((s) => s.score),
        margin: peakMargin(scored),
        rankedPages: ungated.map((chunk) => chunk.page),
      });
    } else {
      const chunks = await searchChunks(index, queryFor(question), Math.max(...KS));
      outcomes.push({
        question,
        pages: chunks.map((chunk) => chunk.page),
        scores: [],
        margin: 0,
        rankedPages: chunks.map((chunk) => chunk.page),
      });
    }
  }

  // 摘录题单独算。混进主 recall 会让 MIN_PEAK_MARGIN 的标定曲线跟历史数字失去可比性
  // ——那条门槛是在原来 29 条上标出来的。
  const clipQuestions = outcomes.filter((outcome) => outcome.question.id.startsWith("cl-"));
  const followUps = outcomes.filter((outcome) => outcome.question.id.startsWith("fu-"));
  const tagged = outcomes.filter((outcome) => outcome.question.id.startsWith("tg-"));
  const main = outcomes.filter(
    (outcome) =>
      !outcome.question.id.startsWith("cl-") &&
      !outcome.question.id.startsWith("fu-") &&
      !outcome.question.id.startsWith("tg-"),
  );

  // 「答不了」的题也带 lang，但它们没有正确页，混进 recall 的分母会把成绩冲淡。
  const answerable = main.filter((outcome) => outcome.question.page !== null);
  const zh = answerable.filter((outcome) => outcome.question.lang === "zh");
  const en = answerable.filter((outcome) => outcome.question.lang === "en");
  const na = main.filter((outcome) => outcome.question.page === null);
  // 两类考的不是一回事：「主题不在」的题检索本就不该找到东西；「主题在、事实不在」的
  // 题（na-03：满页 FID 表格但全文无 ImageNet）检索找到相关段落是**对的**——
  // 判断「这段里没有你问的事实」是推理不是检索。见 README 与 chat-retrieval-interface.md。
  const OFF_TOPIC = ["na-01", "na-02"];
  const offTopic = na.filter((outcome) => OFF_TOPIC.includes(outcome.question.id));

  reportClipQuestions(clipQuestions, useClips);
  reportFollowUps(followUps);
  reportTagQuestions(tagged);
  console.log(`语料 ${indexes.size} 篇，问题 ${questions.length} 条（zh ${zh.length} / en ${en.length} / 答不了 ${na.length}）\n`);

  console.log("           recall@1  recall@3");
  console.log(`中文      ${rate(zh, 1)}     ${rate(zh, 3)}`);
  console.log(`英文      ${rate(en, 1)}     ${rate(en, 3)}`);

  // Δ 只能在**对译子集**上算：questions.md 里 en-* 六条是 zh-01/05/08/13/15/19 的
  // 逐句对译（同页同依据），只有这六对之间的差才是干净的跨语言净损失。
  // 拿 zh 全量 20 条去比，等于把 14 条无对照、难度不同的题混进分母——那是绝对水位差，
  // 不是净损失。（这个坑我在这个 runner 上踩的第三个统计口径问题。）
  const PARALLEL_ZH = ["zh-01", "zh-05", "zh-08", "zh-13", "zh-15", "zh-19"];
  const parallelZh = zh.filter((outcome) => PARALLEL_ZH.includes(outcome.question.id));

  for (const k of KS) {
    const zhHits = parallelZh.filter((o) => hitAt(o, k)).length / (parallelZh.length || 1);
    const enHits = en.filter((outcome) => hitAt(outcome, k)).length / (en.length || 1);
    console.log(
      `Δ@${k}（跨语言净损失，${parallelZh.length} 对对译题）  ${((enHits - zhHits) * 100).toFixed(1)} 个百分点`,
    );
  }

  const abstained = offTopic.filter((outcome) => outcome.pages.length === 0).length;
  console.log(`\n主题不在文档里的问题正确返回空：${abstained}/${offTopic.length}`);
  console.log("⚠ 这一项必须与中文 recall 并排看——永远返回空就是满分。");
  console.log("（na-03 不计入：它的主题在文档里，检索找到相关段落是对的，见 README）");

  const zhEmpty = zh.filter((outcome) => outcome.pages.length === 0).length;
  if (zhEmpty === zh.length && na.length > 0) {
    console.log(`  当前正是这种情况：${zh.length} 条中文题全部返回空，abstention 是白送的。`);
  }

  if (useEmbedder) {
    // 阈值与 abstention / 召回是此消彼长的，只看一个必调歪，所以并排扫。
    console.log("\n尖峰判据权衡曲线（中文 recall / 答不了正确返回空）：");
    console.log("  margin  zh@1   zh@3   en@3   abstention");
    for (const threshold of [0.02, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.3]) {
      // 没有尖峰就整条判为未命中——与 searchChunks 里的判据一致。
      // 用未过滤的 rankedPages——拿 pages 会在 searchChunks 已经切过的数据上再切一次，
      // 曲线会变成一条平线，看着像「阈值无关紧要」。
      const gate = (outcome: Outcome, k: number) =>
        outcome.margin >= threshold ? outcome.rankedPages.slice(0, k) : [];
      const hits = (set: Outcome[], k: number) =>
        set.filter((o) => o.question.page !== null && gate(o, k).includes(o.question.page)).length;
      const abst = offTopic.filter((o) => gate(o, Math.max(...KS)).length === 0).length;
      console.log(
        `  ${threshold.toFixed(2)}  ${((hits(zh, 1) / zh.length) * 100).toFixed(1).padStart(5)}% ` +
          `${((hits(zh, 3) / zh.length) * 100).toFixed(1).padStart(5)}% ` +
          `${((hits(en, 3) / en.length) * 100).toFixed(1).padStart(5)}%   ${abst}/${offTopic.length}`,
      );
    }
    console.log("  → 选让 zh@3 尽量高、同时 abstention 拿满的那一档，填进");
    console.log("     src/chat/retrieval.ts 的 MIN_PEAK_MARGIN。");
    console.log("  曲线与生产路径同口径：排序同样经 RRF 融合，只有门槛在变。");
    console.log("\n各题的 margin（看答得了/答不了两组分不分得开）：");
    for (const set of [zh, en, na]) {
      const label = set === na ? "答不了" : set === zh ? "中文  " : "英文  ";
      const margins = set.map((o) => o.margin).sort((a, b) => a - b);
      if (margins.length === 0) continue;
      console.log(
        `  ${label} 最低 ${margins[0].toFixed(3)}  中位 ${margins[Math.floor(margins.length / 2)].toFixed(3)}  最高 ${margins.at(-1)!.toFixed(3)}`,
      );
    }
  }

  if (useEmbedder && na.length > 0) {
    console.log("\n答不了的题逐条（看漏网的那条是中文还是英文——决定 hybrid 能否帮上忙）：");
    for (const outcome of na) {
      console.log(`  ${outcome.question.id} [${outcome.question.lang}]  margin ${outcome.margin.toFixed(3)}`);
    }
  }

  console.log("\n未命中的中文题：");
  for (const outcome of zh.filter((o) => !hitAt(o, Math.max(...KS)))) {
    const got = outcome.pages.length > 0 ? `检索到 p.${outcome.pages.join("/")}` : "什么都没检索到";
    console.log(`  ${outcome.question.id}  期待 p.${outcome.question.page}，${got}`);
  }
}

await main();

/**
 * 摘录题单独报。
 *
 * 它们问的是公式怎么写、图和表里画了什么——pdf.js 文本层在这几处要么给乱码、要么什么
 * 都没有，所以**只有摘录进池时才可能召回**。同一套题跑 `--clips` 与不跑，差值就是
 * 摘录索引的净收益；不跑时的命中全是文本层碰巧蹭到的（图题、表题那一行）。
 */
function reportClipQuestions(outcomes: Outcome[], useClips: boolean): void {
  if (outcomes.length === 0) return;
  const hit = outcomes.filter((outcome) => outcome.pages.slice(0, 3).includes(outcome.question.page!));

  console.log(
    `摘录题 recall@3：${((hit.length / outcomes.length) * 100).toFixed(1)}% ` +
      `(${hit.length}/${outcomes.length})  ${useClips ? "摘录在池" : "摘录不在池"}`,
  );
  for (const outcome of outcomes) {
    const ok = hit.includes(outcome);
    const from = outcome.pages.length === 0 ? "什么都没检索到" : `检索到 p.${outcome.pages.slice(0, 3).join("/")}`;
    console.log(`  ${outcome.question.id}  ${ok ? "✓" : "✗"} 期待 p.${outcome.question.page}，${from}`);
  }
  console.log("");
}

/**
 * 追问题单独报。
 *
 * 它们量的是「读者接着上一句往下问」时检索还找不找得到——第二问单独看往往没有任何
 * 可检索的名词（「那反向的呢」四个字）。查询由 `retrievalQuery` 拼，**用的就是生产的
 * 那条规则**，不是它的复制品：eval 与生产在参数上对不上的亏已经吃过一次（生产喂
 * top-1 而这里量 recall@3）。
 */
/**
 * 标签题：**退化问句**，除了标签名没有任何主题词。
 *
 * 「标签名要不要进检索文本」只能这么量——留着主题词的话，检索本来就能命中，
 * 测的是别的东西。fu-01…06 那次已经栽过一回：六条追问题全中，因为它们其实都还
 * 保留着主题词，假设根本没被检验。
 */
function reportTagQuestions(outcomes: Outcome[]): void {
  if (outcomes.length === 0) return;
  const hit = outcomes.filter((outcome) => outcome.pages.slice(0, 3).includes(outcome.question.page!));

  console.log(
    `标签题 recall@3：${((hit.length / outcomes.length) * 100).toFixed(1)}% (${hit.length}/${outcomes.length})`,
  );
  for (const outcome of outcomes) {
    const ok = hit.includes(outcome);
    const from = outcome.pages.length === 0 ? "什么都没检索到" : `检索到 p.${outcome.pages.slice(0, 3).join("/")}`;
    console.log(`  ${outcome.question.id}  ${ok ? "✓" : "✗"} 期待 p.${outcome.question.page}，${from}`);
  }
  console.log("");
}

function reportFollowUps(outcomes: Outcome[]): void {
  if (outcomes.length === 0) return;
  const hit = outcomes.filter((outcome) => outcome.pages.slice(0, 3).includes(outcome.question.page!));

  console.log(
    `追问题 recall@3：${((hit.length / outcomes.length) * 100).toFixed(1)}% (${hit.length}/${outcomes.length})`,
  );
  for (const outcome of outcomes) {
    const ok = hit.includes(outcome);
    const from = outcome.pages.length === 0 ? "什么都没检索到" : `检索到 p.${outcome.pages.slice(0, 3).join("/")}`;
    console.log(`  ${outcome.question.id}  ${ok ? "✓" : "✗"} 期待 p.${outcome.question.page}，${from}`);
  }
  console.log("");
}

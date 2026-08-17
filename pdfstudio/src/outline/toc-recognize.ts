import { ModelError } from "../model/model-client";
import { RecognizeError } from "../recognizer/recognizer";
import type { ModelClient } from "../model/model-client";
import type { Screenshot } from "../recognizer/recognizer";
import type { TocEntry } from "./toc";

/**
 * 扫描版的目录页：整页交给模型，要回结构化的目录。
 *
 * **为什么这条路要模型而正文那条不要**：扫描书没有文本层，`parseToc` 那套正则无从下手。
 * 而 OCR 出来的文本本身就是脏的（引导符断续、跨栏、页眉混进来），中文编号形式又杂
 * （`第三章` / `3.1` / `一、` / `（二）`），层级判定交给模型比再写一层正则划算。
 *
 * **只认目录页，不认全书。** 一本 654 页的扫描书，目录也就那么几页——这不是「全书 OCR」，
 * 那会把这个产品变成另一个东西：全书都认了，框选就没有意义了。
 */

const PROMPT = [
  "这是一本书的**目录页**扫描件。把它转成 JSON，不要翻译、不要改写、不要补充原书没有的条目。",
  '格式：{"entries":[{"title":"...","page":12,"level":0}]}',
  "- title：条目标题，**连同它的编号**（如「第三章 进程与线程」「3.1 基本概念」），去掉后面的点线引导符。",
  "- page：这一行右端印着的页码，整数。**没有印页码的行不要输出**——那是装饰或页眉。",
  "- level：层级，顶层是 0。看**缩进**判断，不要靠编号猜——中文书的编号形式很杂。",
  "按页面上从上到下的顺序输出。双栏排版的目录，先整列左栏再整列右栏。",
  "页眉、页脚、书名、「目录」二字本身都不是条目。",
].join("\n");

interface TocOutput {
  entries?: { title?: unknown; page?: unknown; level?: unknown }[];
}

/**
 * 丢掉不成形的条目，而不是整页作废。
 *
 * 模型在一页 40 条里错两条是常态；为那两条把整页扔掉，读者就只剩「什么都没有」。
 * 剩下的 38 条仍然有用——反正**每一条都可以改**（三项全对率只有 57%，改是主路径）。
 */
function usable(entry: { title?: unknown; page?: unknown; level?: unknown }): TocEntry | null {
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const page = typeof entry.page === "number" ? entry.page : Number(entry.page);
  if (title === "" || !Number.isInteger(page) || page <= 0) return null;

  const level = typeof entry.level === "number" && entry.level >= 0 ? Math.floor(entry.level) : 0;
  return { title, printedPage: page, level };
}

/** 认一页目录。多页由调用方逐页调，然后按顺序接起来。 */
export async function recognizeTocPage(
  model: ModelClient,
  pixels: Screenshot,
): Promise<TocEntry[]> {
  let text: string;
  try {
    const response = await model.complete({
      messages: [{ role: "user", content: PROMPT }],
      images: [pixels],
    });
    text = response.text;
  } catch (cause) {
    // 端点通了但没给出能用的东西算坏输出；只有真调不通才是 model-unavailable
    //（与 Recognizer 同一套口径）。
    const unusable =
      cause instanceof ModelError &&
      (cause.kind === "empty-response" || cause.kind === "malformed-stream");
    throw unusable
      ? new RecognizeError("bad-output", "模型没有给出可用的回答", { cause })
      : new RecognizeError("model-unavailable", "模型调用失败", { cause });
  }

  let output: TocOutput;
  try {
    output = JSON.parse(text) as TocOutput;
  } catch (cause) {
    throw new RecognizeError("bad-output", "模型没有按约定返回 JSON", { cause });
  }

  if (!Array.isArray(output.entries)) {
    throw new RecognizeError("bad-output", "模型没有返回 entries");
  }

  return output.entries.map(usable).filter((entry): entry is TocEntry => entry !== null);
}

import type { Context } from "../../contextstudio/src/context";
import type { Recaller } from "./recall";
import type { WebHit, WebSearch } from "./search";

/**
 * 写的时候在旁边说话的那一个。
 *
 * 与 PDF Studio 的「问文档」是同一个形状（问、流式答、答完摆出处），材料不同：那边是
 * 这一篇 PDF 的原文，这边是**正在写的稿子 + 从知识库召回的 context**。
 *
 * **它不动正文。** `docs/workflow.md` §1.3 的规矩是「改动当场被人看见，或者改动会进入
 * review，中间地带不存在」——现在还没有 Diff、也没有 Loop，所以这一版里它只能说话。
 * 它给出的段落由人自己粘进编辑器，那一下就是人看见了。
 */

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * 模型端口。**故意不 import PDF Studio 的 `ModelClient`**：那是另一个 context 的文件，
 * 而这两侧共享的东西只有 `context` 这一个形状（`CONTEXT-MAP.md`）。形状是一样的，
 * 所以接线时直接把那个客户端传进来即可——结构类型帮我们省掉一层适配器。
 */
export interface Model {
  streamComplete(request: { messages: Message[]; signal?: AbortSignal }): AsyncIterable<{ textDelta: string }>;
}

export interface WriterTurn {
  role: "user" | "assistant";
  text: string;
  /** 问的时候选中的那一段正文。「问这一段」的入口，同 PDF Studio 的贴摘录。 */
  quoted?: string;
}

export interface WriterAnswer {
  text: string;
  /** 这一问召回到的材料，分数高的在前。空数组＝库里没有相关的，**不是出错**。 */
  recalled: Context[];
  /** 回答里真的引用了的那几条。摆出来给人点回去核对。 */
  cited: Context[];
  /** 这一问联网查到的网页。没开联网、或没配搜索，就是空数组。 */
  hits: WebHit[];
  /** 联网搜了但没搜成（key 错、额度完、断网）。回答照给，这句摆在旁边。 */
  searchFailed: string | null;
}

export interface AskOptions {
  /** 当前正文全文。每次问都重新给——稿子一直在变，钉住一份快照就是在答上一版。 */
  draft: string;
  signal?: AbortSignal;
  /** 边生成边报，给的是**累计文本**（同 PDF Studio 那侧，理由见 ADR-0009 的注释）。 */
  onText?: (text: string) => void;
  /** 这一问要不要先联网搜一下。没接 `search` 时这个开关不起作用。 */
  web?: boolean;
}

export interface WriterChat {
  ask(turns: WriterTurn[], options: AskOptions): Promise<WriterAnswer>;
}

/**
 * 稿子进 prompt 的字数上限。
 *
 * 超了就**掐掉中间、两头都留**：开头有标题和立意，结尾是刚写到的地方，中间那段是最不
 * 要紧的。掐掉这件事必须在 prompt 里说出来，否则模型会拿一篇看起来完整、实际断了一截的
 * 文章下判断（「你这篇没有结尾」——其实有，只是没给它看）。
 */
const DRAFT_LIMIT = 16000;

function fold(draft: string): string {
  if (draft.length <= DRAFT_LIMIT) return draft;
  const head = Math.floor(DRAFT_LIMIT * 0.6);
  const tail = DRAFT_LIMIT - head;
  const dropped = draft.length - DRAFT_LIMIT;
  return `${draft.slice(0, head)}\n\n（……中间略去 ${dropped} 字，没有给你看……）\n\n${draft.slice(-tail)}`;
}

const renderMaterial = (context: Context): string =>
  [
    `[ctx:${context.id}]`,
    `断言：${context.claim ?? "（还没写）"}`,
    `原文：${context.evidence}`,
    `出处：《${context.source.title}》${context.source.locator}`,
    context.topics.length > 0 ? `主题：${context.topics.join("、")}` : null,
    context.stance !== null ? `立场：${context.stance}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

const RULES = [
  "你是这篇文章作者的写作搭子。用中文回答，说话直接，不要客套。",
  "**你不动正文。** 要改哪里就说改成什么样，由作者自己落笔——这样每一处改动都是他当场看见的。",
  "引用下面给的材料时必须带上它的记号，写成 [ctx:xxxx] 的样子，一句话用了哪几条就标哪几条。",
  "引用联网查到的网页时写成 markdown 链接 [标题](地址)，地址只能是下面列出的那几个，不要编。",
  "材料之外的判断照说不误，但要说清那是你的推断，不是材料里的。",
  "材料与稿子冲突时先说出冲突，不要替作者圆过去。",
].join("\n");

const NO_MATERIAL = "这一问在知识库里没有找到相关材料。**不要编造 [ctx:...] 记号。**";

/** 网页进 prompt 的样子：标题、地址、摘录。地址必须原样出现，模型才引得回去。 */
const renderHit = (hit: WebHit, index: number): string =>
  `${index + 1}. [${hit.title}](${hit.url})\n${hit.content}`;

/** 回答里真的引用了的那几条：只认确实在这次材料里的 id，模型编出来的记号一律不算数。 */
function citedIn(text: string, recalled: Context[]): Context[] {
  const used = new Set([...text.matchAll(/\[ctx:([^\]\s]+)\]/g)].map((match) => match[1]));
  return recalled.filter((context) => used.has(context.id));
}

export function createWriterChat(deps: {
  model: Model;
  /** 知识库当前有哪些 context。函数而不是数组：库随时在变，快照会让新入库的永远召不回。 */
  materials: () => Promise<Context[]>;
  recaller: Recaller;
  /** 联网搜索。不接就没有这一种材料；接了也要 `AskOptions.web` 打开才搜。 */
  search?: WebSearch;
}): WriterChat {
  return {
    async ask(turns: WriterTurn[], options: AskOptions): Promise<WriterAnswer> {
      const last = turns[turns.length - 1];
      if (!last || last.role !== "user") throw new Error("最后一条得是人问的话");

      // 拿问题**和选中的那一段**一起去召回：选区就是「我正卡在这里」，比问题本身更能说明
      // 要找什么。只拿问题去找的话，「这段怎么改」这种问法几乎召不回任何东西。
      const pool = await deps.materials().catch(() => [] as Context[]);
      const hits = await deps.recaller.recall([last.quoted ?? "", last.text].join("\n").trim(), pool);
      const recalled = hits.map((hit) => hit.context);

      /**
       * 联网：拿问题（加选中的那段）去搜一次。**搜不成不拦回答**——key 错了、额度完了、
       * 断网了，都只是少一种材料，答照给，那句原因摆在旁边让人看见。
       */
      let web: WebHit[] = [];
      let searchFailed: string | null = null;
      if (deps.search && options.web) {
        try {
          web = await deps.search.search([last.quoted ?? "", last.text].join("\n").trim(), options.signal);
        } catch (cause) {
          if (options.signal?.aborted) throw cause;
          searchFailed = cause instanceof Error ? cause.message : String(cause);
        }
      }

      const messages: Message[] = [
        { role: "system", content: RULES },
        {
          role: "system",
          content:
            recalled.length === 0
              ? NO_MATERIAL
              : `这一问相关的材料：\n\n${recalled.map(renderMaterial).join("\n\n")}`,
        },
        ...(web.length > 0
          ? [{ role: "system" as const, content: `联网查到的网页：\n\n${web.map(renderHit).join("\n\n")}` }]
          : []),
        { role: "system", content: `作者正在写的稿子：\n\n${fold(options.draft)}` },
        ...turns.map((turn) => ({
          role: turn.role,
          content: turn.quoted ? `他选中了这一段：\n\n${turn.quoted}\n\n${turn.text}` : turn.text,
        })),
      ];

      let text = "";
      for await (const chunk of deps.model.streamComplete({ messages, signal: options.signal })) {
        text += chunk.textDelta;
        options.onText?.(text);
      }

      // 停止按钮按下时，已经生成的半段照样是一个合法回答（同 PDF Studio 的不变量⑥）：
      // 白问一次却什么都不留，只会让人重打一遍字。
      return { text, recalled, cited: citedIn(text, recalled), hits: web, searchFailed };
    },
  };
}

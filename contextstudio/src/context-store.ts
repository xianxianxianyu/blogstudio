import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "./context";

/**
 * Context Studio 唯一的持久化模块。**canonical 接口见
 * `contextstudio/docs/context-store-interface.md`**，落盘形状见 `docs/adr/0004`。
 *
 * 一条 context 一个 markdown 文件，扁平放在 `<root>/` 下。
 */
export interface ContextStore {
  /** 收下 PDF Studio 交出的一批。幂等：同一批导入两次，库里条数不变。 */
  ingest(docId: string, incoming: Context[]): Promise<IngestReport>;
  /** 全量读。**知识库唯一的读法**——degree 与主题频次都是全局量，没有「只读一部分」。 */
  all(): Promise<Context[]>;
  /** 读者改主题 / 立场 / 状态。导入进来的那些字段不在这里改。 */
  update(id: string, patch: ReaderPatch): Promise<void>;
}

/**
 * 读者能改的字段。**刻意不含 evidence 与 source**——那两样上游是真相，
 * 而 evidence 的逐字性是 context 的硬标准，从接口上就不给改的口子。
 */
export type ReaderPatch = Partial<Pick<Context, "topics" | "stance" | "status">>;

export interface IngestReport {
  added: number;
  updated: number;
  /** 这个 docId 下库里有、这批没有的——来源摘录被删了。 */
  sourceDeleted: number;
}

/** frontmatter 的 schema 版本。内部存储格式，改结构时靠它辨认旧文件（ADR-0004）。 */
const SCHEMA_VERSION = 1;

/**
 * frontmatter 每行是 `key: <JSON 值>`。
 *
 * 用 JSON 编码标量而不是裸写，是因为标题里出现冒号、引号、换行都是家常便饭
 * （「Attention Is All You Need: A Study」），裸写就得自己发明转义规则。
 * 读起来仍然是人话，解析却没有歧义。
 */
function renderFrontmatter(context: Context): string {
  const fields: [string, unknown][] = [
    ["version", SCHEMA_VERSION],
    ["id", context.id],
    ["sourceClipId", context.sourceClipId],
    ["docId", context.source.docId],
    ["title", context.source.title],
    ["locator", context.source.locator],
    ["stance", context.stance],
    ["status", context.status],
    ["sourceClipDeleted", context.sourceClipDeleted],
    ["topics", context.topics],
  ];
  return fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
}

function render(context: Context): string {
  return [
    "---",
    renderFrontmatter(context),
    "---",
    "",
    "## claim",
    "",
    context.claim ?? "",
    "",
    "## evidence",
    "",
    context.evidence,
    "",
  ].join("\n");
}

const CLAIM_HEADING = "## claim";
const EVIDENCE_HEADING = "## evidence";

function parse(text: string): Context {
  const end = text.indexOf("\n---", 4);
  const front: Record<string, unknown> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) front[line.slice(0, colon)] = JSON.parse(line.slice(colon + 1));
  }

  const body = text.slice(end + 4);
  const claimAt = body.indexOf(CLAIM_HEADING);
  const evidenceAt = body.indexOf(EVIDENCE_HEADING);
  const claim = body.slice(claimAt + CLAIM_HEADING.length, evidenceAt).trim();

  return {
    id: front.id as string,
    sourceClipId: front.sourceClipId as string,
    source: {
      docId: front.docId as string,
      title: front.title as string,
      locator: front.locator as string,
    },
    claim: claim === "" ? null : claim,
    evidence: body.slice(evidenceAt + EVIDENCE_HEADING.length).trim(),
    stance: front.stance as Context["stance"],
    status: front.status as Context["status"],
    sourceClipDeleted: front.sourceClipDeleted as boolean,
    topics: front.topics as string[],
  };
}

/**
 * 重导时的合并规则。**覆盖不是整条替换**，这是整个模块最容易漏、代价最大的一条。
 *
 * 导出层不填 `topics`（ADR-0002 ②），所以重导进来的那份一定是空的。整条替换等于
 * 把读者定好的主题、立场、状态**静默抹掉**——不报错，只是某天发现全没了。
 *
 * 分界线是「谁是这个字段的真相」：
 * - `evidence` / `source` / `sourceClipId` —— 上游。摘录那边修了 OCR 错字要能带过来。
 * - `topics` / `stance` / `status` —— 读者。导入的空值不覆盖库里的非空值。
 */
function merge(stored: Context, incoming: Context): Context {
  return {
    ...incoming,
    topics: incoming.topics.length > 0 ? incoming.topics : stored.topics,
    stance: incoming.stance ?? stored.stance,
    // status 没有「空」值，所以看的是它是不是还停在初始态——读者判过了就不退回去。
    status: incoming.status === "pending" ? stored.status : incoming.status,
  };
}

export function createContextStore(root: string): ContextStore {
  const file = (id: string) => path.join(root, id + ".md");

  /**
   * 先写临时文件再 `rename`——同一文件系统上 rename 是原子的，所以读到的要么是旧的
   * 完整文件、要么是新的完整文件，不会是写了一半的（ADR-0004 代价 ①）。
   */
  async function write(context: Context): Promise<void> {
    const target = file(context.id);
    const temp = target + ".tmp";
    await writeFile(temp, render(context));
    await rename(temp, target);
  }

  // 不走 `this.all()`：调用方一解构（`const { ingest } = store`）`this` 就没了，
  // 而测试照样绿。内部调用走这个自由函数，`this` 根本不参与。
  async function readAll(): Promise<Context[]> {
    // 目录还不存在 = 一条 context 都还没有，那是新装应用的正常状态，不是错误。
    const entries: string[] = await readdir(root).catch(() => []);
    const names = entries.filter((name) => name.endsWith(".md"));
    return Promise.all(
      names.map(async (name) => parse(await readFile(path.join(root, name), "utf8"))),
    );
  }

  return {
    async ingest(docId, incoming) {
      await mkdir(root, { recursive: true });

      const stored = new Map((await readAll()).map((context) => [context.id, context]));
      const report: IngestReport = { added: 0, updated: 0, sourceDeleted: 0 };

      const arrived = new Set(incoming.map((context) => context.id));

      for (const context of incoming) {
        const existing = stored.get(context.id);
        if (existing) report.updated++;
        else report.added++;
        await write(existing ? merge(existing, context) : context);
      }

      // 这一批**定域在 docId 上**：这个文档下库里有、这批没有的，就是来源摘录被删了。
      // context 本身留着——它可能已经被 Blog Studio 引用了，删摘录不该连坐，
      // 但来源去了哪要如实标出。定域是必须的，否则导入 A 文档会把 B 文档的全标成删了。
      for (const context of stored.values()) {
        if (context.source.docId !== docId) continue;
        if (arrived.has(context.id) || context.sourceClipDeleted) continue;
        report.sourceDeleted++;
        await write({ ...context, sourceClipDeleted: true });
      }

      return report;
    },

    async update(id, patch) {
      const stored = (await readAll()).find((context) => context.id === id);
      if (!stored) return;
      await write({ ...stored, ...patch });
    },

    all: readAll,
  };
}

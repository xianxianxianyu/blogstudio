# ContextStore 接口

Context Studio 唯一的持久化模块。**canonical 定义在这里**，`src/context-store.ts` 跟着它走。

## 接口

```ts
interface ContextStore {
  /** 收下 PDF Studio 交出的一批。幂等：同一批导入两次，库里条数不变。 */
  ingest(docId: string, incoming: Context[]): Promise<IngestReport>;

  /** 全量读。**知识库唯一的读法**——见下面「为什么 all() 是诚实的」。 */
  all(): Promise<Context[]>;

  /** 读者改主题 / 立场 / 状态。导入进来的字段不在这里改。 */
  update(id: string, patch: ReaderPatch): Promise<void>;
}

interface IngestReport {
  added: number;
  updated: number;
  /** 这个 docId 下库里有、这批没有的——来源摘录被删了。 */
  sourceDeleted: number;
}

type ReaderPatch = Partial<Pick<Context, "topics" | "stance" | "status">>;
```

三个方法。这是刻意压到最小的结果，不是还没想全。

## 为什么 `all()` 是诚实的，不是偷懒

知识图**必须全量**：`degree` 是全局量，主题频次（`buildGraph` 交出的 `topics`）也是全局量，
而聚焦视图的稀有度排序正是拿它算的。没有「只读一部分」这种模式。

所以做成 `find(query)` 之类的查询接口是**撒谎**——任何一个 query 内部都得先读全量再过滤。
接口要说出真话：调这个方法会读整个库。

代价量过了（见 `docs/adr/0004`）：2000 条 40ms、10000 条 195ms。到了真扛不住的那天，
补救是在**应用层**加一层缓存，不是把查询塞进 store。

## 深在哪：三件事被藏在了里面

**① 幂等合并的规则。** 调用方不需要知道「按 id 覆盖」这件事，更不需要知道下面这条：

> **覆盖不是整条替换。** 导入进来的 `topics` 是空的（导出层不填，见 ADR-0002），
> 无脑覆盖会把读者上次定的主题抹掉。所以：
> - `source` / `sourceClipId` —— 以导入的为准，上游是真相
> - `evidence` —— **冻结在第一次入库那一刻**，重导不覆盖（`docs/adr/0002` ③）。逐字引文
>   一旦被 draft 引用，悄悄改掉它没有任何东西会报错。原文要改就产出新的一条 context
> - `topics` / `stance` / `status` —— **保留库里已有的**，导入的空值不覆盖非空

这条规则只要漏到调用方一次，就会有一次静默的数据丢失。放在 store 里 = locality。

**② 来源摘录被删的判定。** 没有 `markSourceDeleted` 方法。`ingest` 按 `docId` 定域，
**这个文档下库里有、这批没有的，就是被删了**。调用方完全不需要知道有「删除」这回事。

（这也是为什么 `ingest` 的第一个参数是 `docId` 而不是从 `Context` 里读——
一批空的 `incoming` 仍然要能表达「这个文档的摘录全删了」。）

**③ 落盘的布局。** 一条 context 一个 markdown 文件、frontmatter 放结构化字段
（`docs/adr/0004`）。**布局不在接口里**，所以将来改成按文档分目录、或者加一层索引缓存，
调用方一行都不用动。这是把接口压到三个方法换来的东西。

## 缝在哪：只有一个 adapter，所以不造缝

没有 `ContextStore` 的第二个实现，也不做内存 fake。测试用真临时目录
（`mkdtemp`），和 `pdfstudio/src/clip/clip-store.test.ts` 一样——依赖是本地文件系统，
属于「local-substitutable」，缝是内部的，不该顶到接口上。

**接口就是测试面**：`IngestReport` 存在的一半理由就是让「加了几条、覆盖了几条、
标了几条来源没了」能从接口上断言，而不用去翻文件。

## 不属于这个模块的

- **`buildGraph`**。它是纯函数，吃 `Context[]` 吐 `Graph`。把它塞进 store 会让它没法单独测。
  调用方自己组合：`buildGraph(await store.all())`。
- **主题的提议**（ADR-0003 的 `proposeTopics`）。那是导入口的策略，不是存储。
- **`pdfstudio/src/knowledge/context.ts` 的 `ContextSink`**。ADR-0002 之后 PDF Studio
  不写这个库了，那个端口的 `publish` 已经没有对应物——**它是死的，该删**。

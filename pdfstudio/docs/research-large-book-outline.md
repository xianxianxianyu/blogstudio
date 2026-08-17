# 几千页的大部头：可折叠目录、没有 TOC 时怎么办、以及内存

- **问题来自一个新场景**：读者要拿 PDF Studio 读几千页的中文技术书（CSAPP、分布式系统那一类），而现在这套东西是照着「几十页的论文」长出来的。三件事要回答：目录能不能折叠、没有 outline 的书怎么建目录、几千页会不会把内存吃穿。
- **方法：一手来源。** `pdf.js` 的结论全部来自 `node_modules/pdfjs-dist/` 里的源码与 `types/`（版本 **6.2.108**），标到行号；不引二手博客。凡是我自己跑出来的数字，标 **实测**，脚本与合成样本见 [Sources](#sources) `[M1]`。凡是推的，写「推测」。
- **合成样本**：手上没有几千页的书，所以手写了一本——**3000 页、1212 个 outline 项（3 层）、11.5 MB**，另加一份「不嵌入字体 + 预定义 CMap」的中文页。合成样本的局限在 §5.2 单独说。
- **检索/实测时间：** 2026-08-17。引用键 `[R…]`（pdf.js 源码）/ `[M…]`（本机实测）/ `[E…]`（外部一手来源）见 [Sources](#sources)。

---

## 0. 结论先行

**一句话：现在最该改的不是目录，是 `cMapUrl`——不加它，一大类中文书的文本层是空的，目录、切块、检索、摘录全都建在空气上。目录折叠是个几乎免费的功能（PDF 自己就存着默认折叠状态，pdf.js 也透出来了）。真正的墙不在 pdf.js，在我们自己的 `chunkDocument` 与索引缓存。**

| 问题 | 结论 | 强度 |
| --- | --- | --- |
| `getOutline()` 有没有透出 `/Count`（默认折叠状态）| ✅ **有**。`count: Number.isInteger(count) ? count : undefined`，原样保留负号 | 源码 + 实测 `[R1][M2]` |
| 真实论文里 `count` 有值吗 | ✅ 有。Attention 的 *Model Architecture* 是 `count: -5`（默认折叠），DDPM 的 *3 Diffusion models…* 是 `count: 4`（默认展开）| **实测** `[M3]` |
| 1212 项的 outline 解析要多久 | **18 ms**（冷）/ 2 ms（第二次）。**不是问题** | **实测** `[M2]` |
| 1212 个 dest 解成页码要多久 | 顺序解 **6–27 ms**（fake worker，折扣见 §5.1 第 3 条）| **实测** `[M2]` |
| `getPageLabels()` | ✅ 有，返回**长度 = numPages 的稠密数组**；实测罗马数字前言页正确 | 源码 + 实测 `[R2][M2]` |
| 「书自带书签、论文没有」 | ❌ **无人测过**，别按文档类型分支。仅有的三个实测都来自**论文**且高达 50–74.5%；ResNet 缺目录是**工具链把它洗掉了**（正文经 Distiller 转过一道），不是「论文没有」 | 文献缺口 `[E8]` + **实测** `[M10]` |
| 书这一侧唯一被测过的数 | **50,239 本数字化图书里约 80% 有印刷目录页** —— 这是「解析目录页」那条路的天花板 | `[E11]` |
| 自动重建目录能做到多准 | 三项（标题/层级/页号）全对：扫描书 **~44%**、born-digital **~57%**；只看标题 **83%**、只看页号 **73%**。**所以必须标成「自动识别」且可编辑** | `[E11][E14]` |
| 有没有现成的库可以直接用 | ❌ **没有任何 JS/TS/WASM 实现**能重建层级目录；Python/Java 的那些要么只读书签、要么层级是拉丁编号正则、要么要联网 | `[E15]`–`[E20]` |
| `/StructTreeRoot` 这条路 | ❌ **基本不值得做**。三篇论文 `hasStructTree` **全是 false**；且 pdf.js 的 `getStructTree()` 是**逐页**的、**只给 role 不给文本** | **实测** + 源码 `[M3][R3]` |
| 本地文件能不能分块加载 | ✅ 能，但**必须走 `http://127.0.0.1`**（`file://` 在渲染进程里没有一条 pdf.js 路径）。实测打开一本 11.5 MB 的书只下 **0.78 MB（6.8%）** | 源码 + 实测 `[R4][M4]` |
| 分块加载省不省内存 | ❌ **不省**。`new Uint8Array(length)` 按全长预分配；实测下 2 MB 与下 11.5 MB 的 RSS 差 7 MB（205 vs 212） | 源码 + 实测 `[R5][M4]` |
| 中文书不加 `cMapUrl` 会怎样 | ❌ **文本层直接是空字符串**，不是乱码。实测 `""` vs `"第三章 进程与线程"` | **实测** `[M5]` |
| 上千项的树在 React 里 | 扁平化 + 虚拟列表是标准做法，但**折叠状态下通常只有几十行可见**——虚拟化的触发条件是「全部展开」，不是「书很长」 | `[E3][E5]` |
| `chunkDocument` 跑 3000 页 | pdf.js 侧 **3.2 s / 峰值 390–446 MB**，可控；**真正的墙在后面**：5,800–19,000 块 → embedding **2–7 分钟**、索引缓存 **27–88 MB 的单个 JSON**，比论文差两个数量级 | 实测 + 外推 `[M6][R43]` |

**优先级方案见 §6，一共五档，每档写清前提和代价。**

---

## 1. pdf.js 到底给了什么（A）

### 1.1 `getOutline()` 的完整返回结构 —— `count` 有，而且是有符号的

worker 侧构造 outline item 的那段（`Catalog.#readDocumentOutline`）逐字段列出来是这样 `[R1]`：

```js
const count = outlineDict.get("Count");
const outlineItem = {
  action, attachmentId, attachment, dest, url, unsafeUrl, newWindow, setOCGState,
  title: typeof title === "string" ? stringToPDFString(title) : "",
  color: rgbColor,
  count: Number.isInteger(count) ? count : undefined,   // ← 关键
  bold: !!(flags & 2),
  italic: !!(flags & 1),
  items: []
};
```

三件事：

1. **`/Count` 被原样透出，包括负号。** PDF 规范里 outline item 的 `/Count`：正数 = 打开时可见的后代数，负数 = **默认折叠**（其绝对值是展开后会露出来的后代数）。pdf.js 不做任何归一化，`Number.isInteger` 一关，负数照样进来。**「默认折叠状态」可以从 PDF 里读出来，不用我们瞎猜。**
2. **叶子节点没有 `count`**（`undefined`）——`/Count` 只在有子项时才写。所以 `count === undefined` ≠ 展开，是「没有子项」。
3. **TS 类型比实际返回值少几个字段。** `types/src/display/api.d.ts` 的 `getOutline()` 声明里有 `title/bold/italic/color/dest/url/unsafeUrl/newWindow/count/items` `[R6]`，但**没有** `action`、`setOCGState`、`attachment*`——而 worker 确实会返回它们。要用 `action` 得自己扩类型。

**实测验证（合成书，1212 项）`[M2]`：**

```
count!==undefined: 132  （= 12 章 + 120 节，与生成时一致）
count<0:           131  （只有第 1 章我故意写成 +10）
sample root :  {"title":"…Chapter 1","count":10, "items":"[10]"}
sample root2:  {"title":"…Chapter 2","count":-10,"items":"[10]"}
```

**真实论文里也确实有 `[M3]`：**

| 文件 | outline | 带 `count` 的项 | 例子 |
| --- | --- | --- | --- |
| `1512.03385.pdf`（ResNet）| **null** | — | — |
| `1706.03762.pdf`（Attention）| 22 项 / 4 层 | 4 | *Model Architecture* → **`count: -5`**（默认折叠）|
| `2006.11239.pdf`（DDPM）| 18 项 / 3 层 | 2 | *3 Diffusion models and denoising autoencoders* → **`count: 4`**（默认展开）|

> 注意这两篇的默认状态是**相反**的——同为 pdfTeX 产出，`hyperref` 的 `bookmarksopen` 设置不同。这说明 `count` 不是形式主义，制作方确实在用它表达意图。**默认折叠状态应当读 `count`，不应当写死「全折叠」或「展开到第 N 层」。**

**给实现的直接结论：** `Section` 加两个字段——`count: number | undefined` 与派生的 `defaultCollapsed = (count ?? 0) < 0`。`readOutline` 现在把 `item.count` 整个丢掉了 `[R7]`，加上它是一行的事。

> **一条需要警惕的反面证词。** GROBID 维护者说，拿 `/Outlines` 的**坐标**去定位章节标题时，*"Maybe in 50% of the cases when present, it gives a reliable section hierarchy with the coordinates… The problem is that in the other 50% of the cases, it is crap and noise"* `[E20]`。**这不影响「把目录显示出来」**（目录是作者写的，显示它天然正确），**但直接影响 `Section.y`** ——我们用 XYZ dest 的 y 来把摘录归到小节，`src/clip/outline.ts` 的注释里也写明了这个字段不是装饰 `[R36]`。所以：**`y` 值应当被当成「多半对但可能是噪声」，而不是真值。** 现有代码里 `y === null` 会退化成按页归组 `[R36]`，这个降级是对的；还该加一条**合理性检查**——同一页上多个目录项的 y 必须单调、且落在页面 MediaBox 内，不满足就整页退回按页归组。（这是我的建议，未实测。）

### 1.2 大文档下 `getOutline()` 的代价：一次性、全树、缓存

- **一次性解析整棵树。** `#readDocumentOutline` 是一个 `while (queue.length > 0)` 的 BFS，沿 `/First` 与 `/Next` 走完全部节点才返回；用 `RefSet` 防环 `[R1]`。**没有惰性、没有分页。**
- **worker 侧有缓存。** `get documentOutline()` 用 `shadow(this, "documentOutline", obj)` 把结果钉在实例上 `[R1]`，第二次调用不再解析。
- **主线程侧没有缓存。** `getOutline()` 走的是 `sendWithPromise("GetOutline", null)`，**不是** `#cacheSimpleMethod` `[R8]`——每次调用都会把整棵树重新序列化一遍跨线程传。1212 项传一次实测 2 ms（fake worker，无真实 `postMessage` 序列化成本），**真实 Worker 下会更贵**（推测：整棵树含 1212 个 `Uint8ClampedArray(3)` 的 color，结构化克隆不便宜）。→ **自己缓存一次，别在每次渲染里调。**

**实测 `[M2]`：**

| 页面树形态 | `getDocument` | `getOutline()` 冷 | 第二次 | `getPageLabels()` |
| --- | --- | --- | --- | --- |
| 平衡树 fanout=25 | 39 ms | **18.2 ms** | 2.0 ms | 0.7 ms |
| 扁平 Kids（3000 个直接子节点）| 57 ms | **10.8 ms** | 2.9 ms | 0.7 ms |

**几千项不会卡。** 这条可以从担心清单上划掉。

### 1.3 真正贵的是解 `dest`，而且贵法与直觉相反

我们的 `readOutline` 对每一项都 `await locate()`，里面是 `getDestination`（命名 dest）+ `getPageIndex` `[R7]`。worker 侧 `Catalog.getPageIndex` 是**从页对象沿 `/Parent` 往上爬**，每层把前面兄弟的 `/Count` 加起来，结果进 `pageIndexCache` `[R9]`。

**实测（1212 项全解）`[M2]`：**

| | 冷缓存 | 第二遍（`pageIndexCache` 命中）|
| --- | --- | --- |
| 平衡树 fanout=25 | **27 ms** | 5 ms |
| 扁平 Kids | **6 ms** | 4 ms |

**这个数字要打折看**：Node 里 pdf.js **永远是 fake worker**——`static { if (isNodeJS) { this.#isWorkerDisabled = true; } }` `[R10]`，走 `LoopbackPort`（同线程 + `structuredClone`）`[R11]`。也就是说这 27 ms **不含真实 `postMessage` 的往返延迟**，而我们的 `readOutline` 是 **1212 次串行 await**，每次一个往返。

> **推测（未实测）**：真实 Worker 下单次往返按 0.1–1 ms 计，1212 次串行 = 0.12–1.2 s。这不致命，但没必要——**把 `locate` 改成 `Promise.all` 并行发出**即可，worker 侧本来就是异步排队处理的，`pageIndexCache` 也会让重复的页引用只算一次。这是个一行的改动。

**另一条更省的路：** 若 outline 用的是**命名 dest**（`dest` 是 string），`getDestinations()` 一次拿回整棵 `/Dests` 名字树 `[R8]`，1212 次 `getDestination` 变 1 次。合成样本用的是显式数组 dest，**这条没实测**。

### 1.4 `getPageLabels()`：书的前言页码

- 返回 **`Array<string>`，长度恒等于 `numPages`**，或 `null`（没有 `/PageLabels` 时）。`#readPageLabels` 逐页展开 `/Nums` 数字树，支持 `/S` = `D`(阿拉伯) / `R`,`r`(罗马) / `A`,`a`(字母)，带 `/P` 前缀与 `/St` 起始号 `[R2]`。
- 没有 `/S` 只有 `/P` 时，label = 纯前缀（可能是空串 `""`）——**空串是合法值，别当成「没有 label」**。
- 3000 页的数组 = 3000 个短字符串，实测 **0.7 ms**、内存可忽略 `[M2]`。

**实测（合成书，前 24 页设为小写罗马数字）`[M2]`：**

```
len=3000, [0..3]=["i","ii","iii","iv"], [23..26]=["xxiv","1","2","3"]
```

**三篇论文全部 `pageLabels: null` `[M3]`** —— 论文用不上，书才用得上。这正是「书 vs 论文」的一个真实分界。

**给实现的结论：** 页码输入框与「第几页」的显示，在 `getPageLabels()` 非 null 时应当显示 label；同时**必须保留物理页号**（`Clip.region.page`、`Chunk.page` 都是物理页号，不能改成 label）。两者的映射还有第二个用途——见 §2.3 解析目录页时的「印刷页号 → 物理页号」。

### 1.5 内存相关 API 的真实语义（逐个查源码，不抄博客）

| API | 实际做了什么 | 源码 |
| --- | --- | --- |
| `PDFPageProxy.cleanup(resetStats?)` | **只动主线程**：清 `_intentStates`（operator list）与 `objs`（本页图像等）。**渲染中会返回 `false` 什么都不做**；此时置 `#pendingCleanup`，等 `lastChunk` 到达后自动补做 | `[R12]` |
| `PDFDocumentProxy.cleanup(keepLoadedFonts?)` | 先向 worker 发 `Cleanup`，再对 `#pageCache` 里**每一页**调 `page.cleanup()`（任一页在渲染中就 **throw**），然后清 `commonObjs`、`fontLoader`、`filterFactory`、`TextLayer.cleanup()` | `[R13]` |
| worker 侧 `Cleanup` | `Catalog.cleanup(true)`：清全局 primitive/pattern/unicode 缓存、`globalColorSpaceCache`、`pageKidsCountCache`、`pageIndexCache`、`pageDictCache`、`fontCache`、`builtInCMapCache`、`standardFontDataCache`、`systemFontCache`；`globalImageCache.clear(true)` —— 参数名是 **`onlyData`**，所以**只清像素数据，保留 ref→page 的账本** | `[R14]` |
| **`XRef` 的对象缓存不在清理范围内** | `XRef.#cacheMap` 只在 `indexObjects()`（损坏恢复）里被 clear。`cleanup()` **不碰它**——每个取过的 PDF 对象永久驻留 | `[R15]` |
| `loadingTask.destroy()` | 中止网络请求、终止 worker。**这是唯一能彻底释放的手段** | `[R6]` |
| `GlobalImageCache` 的上限 | `MAX_BYTE_SIZE = 5e7`（**50 MB**）、`MIN_IMAGES_TO_CACHE = 10`、`NUM_PAGES_THRESHOLD = 2`（同一张图至少出现在 2 页才进缓存）| `[R16]` |

`getDocument` 的相关参数，逐条以 JSDoc 原文为准 `[R17]`：

| 参数 | 官方原文（节选） | 对我们的意义 |
| --- | --- | --- |
| `rangeChunkSize` | *"Specify maximum number of bytes fetched per range request. The default value is 65536 (= 2^16)."* | 实测 64 KB 比 256 KB 更省字节（§1.6）|
| `disableStream` | *"Disable streaming of PDF file data. By default PDF.js attempts to load PDF files in chunks."* | **必须开**，否则整份文件照下不误（实测） |
| `disableAutoFetch` | *"Disable pre-fetching… **NOTE: It is also necessary to disable streaming, see above, in order for disabling of pre-fetching to work correctly.**"* | 官方自己写了要配对使用，实测证实 |
| `cMapUrl` / `cMapPacked` | *"The URL where the predefined Adobe CMaps are located. Include the trailing slash."* / packed 默认 `true` | **中文书的生死线**，见 §2.4 |
| `maxImageSize` | *"The maximum allowed image size in total pixels, i.e. width \* height. Images above this value will not be rendered. Use -1 for no limit, which is also the default value."* | 扫描版书的护栏。注意语义是**不渲染**，不是缩放 |
| `standardFontDataUrl` / `wasmUrl` | 标准 14 字体 / JBIG2·OpenJPEG·qcms 的 wasm | 扫描书大量用 JBIG2；不给 `wasmUrl` 会退到 `*_nowasm_fallback.js` |

> **注意 `maxCanvasPixels` 不是 `getDocument` 的参数**，它是 pdf.js **viewer** 的选项（我们没用 viewer），默认 `2 ** 25` = 33,554,432 px；移动端被压到 `5242880`；`maxCanvasDim = 32767`；`capCanvasAreaFactor = 200` `[R18]`。**我们的 `Reader.tsx` 没有任何这类上限** —— 见 §4.3。

### 1.6 本地文件的分块加载：能做，但只有一条路

**结论先说：在 Electron 渲染进程里，`file://` 走不通；必须走 `http://127.0.0.1`。**

三条证据链，全在源码里：

1. `getNetworkStream(url)` 的选择逻辑是 `isValidFetchUrl(url) ? PDFFetchStream : isNodeJS ? PDFNodeStream : PDFNetworkStream` `[R19]`；而 `isValidFetchUrl` 是 `/https?:/.test(protocol)` —— **`file:` 永远为假** `[R20]`。
2. `PDFNodeStream` 确实支持 `file://` 且**有真正的 range reader**（`fs.createReadStream(url, {start, end})`）`[R21]`——但它只在 `isNodeJS` 为真时被选中，而 `isNodeJS` 的定义把 **Electron 渲染进程排除在外**：`!(process.versions.electron && process.type && process.type !== "browser")` `[R22]`。我们的 `BrowserWindow` 是 `nodeIntegration: false, contextIsolation: true` `[R23]`，渲染进程里连 `process` 都没有，更不可能为真。
3. 剩下 `PDFNetworkStream`（XHR），对 `file://` 无从谈起。

**能走的三条路：**

| 路 | 怎么做 | 代价 |
| --- | --- | --- |
| **A. `url: http://127.0.0.1:PORT/bookshelf/<id>/pdf`** ← 推荐 | 主进程那台本机 HTTP server `[R23]` 给这条路由加 `Accept-Ranges: bytes` + 处理 `Range` | 最小。**我们已经有这台 server 了** |
| B. `range: PDFDataRangeTransport` | 自己实现 `requestDataRange(begin, end)`，经 IPC 让主进程 `fs.read` | 要写一层 IPC 与分块协议 |
| C. 现状 `data: bytes` | 全文件进内存 → `LocalPdfManager`，无 range | 首屏要等整份文件 |

**A 的服务端硬性要求**（`validateRangeRequestCapabilities` 逐条）`[R24]`：`Content-Length` 是整数、`length > 2 * rangeChunkSize`（默认即 **> 128 KB**）、`Accept-Ranges: bytes`、`Content-Encoding` 是 `identity`（**别 gzip**）。任一不满足就静默退回全量下载。

**实测（合成书 11.53 MB，本机 HTTP，服务端按背压分块写并观察 abort）`[M4]`：**

| 配置 | 打开 + 第 1 页文本 | 再 `getOutline()` | 再跳到第 1500 页 | 结束时 RSS |
| --- | --- | --- | --- | --- |
| 默认（stream 开、autofetch 开）| 93 ms，**下载 11.53 MB（100%）**，5 请求 | +0 MB | +0 MB | 205 MB |
| **`disableStream` + `disableAutoFetch`** | 27 ms，**下载 0.78 MB（6.8%）**，8 请求 | **+0.13 MB** | **+0.19 MB** | 212 MB |
| 同上 + `rangeChunkSize: 256KB` | 23 ms，下载 1.53 MB，5 请求 | +0 MB | +0.50 MB | 220 MB |

**读法：**

- **默认配置等于没有分块**——full GET 一路跑完。官方 JSDoc 里那句「还必须关掉 streaming」不是可选建议，是必要条件。**实测证实。**
- 关掉之后，打开一本书只需要 **6.8%** 的字节；1212 项的 outline 只多要 **2 个 64 KB 块**（这一条受合成样本影响：我的 outline 对象在文件里是连续的，真实书里可能散落，**推测**会更贵）。
- **默认的 64 KB 比 256 KB 更省**（0.78 vs 1.53 MB）。别调大。
- **但 RSS 几乎没差（205 / 212 / 220 MB）。** 原因在源码里：`ChunkedStream` 的构造函数是 `super(new Uint8Array(length), 0, length, null)` —— **按整个文件长度预分配** `[R5]`。所以：

> **分块加载省的是首屏延迟和磁盘 I/O，不是内存。** 一本 200 MB 的扫描书，不管你下 5% 还是 100%，worker 里都躺着一个 200 MB 的 `Uint8Array`（未写入的页由操作系统惰性提交，所以 RSS 会低于 200 MB，但地址空间是实打实占住的——这一句是**推测**，我只测到 11.5 MB 这个量级上二者差 7 MB）。

补一条：`data: bytes` 这条路上，`data.buffer` 是**放进 transfer list** 的 `[R25]`（JSDoc 也明说 *"they will generally be transferred to the worker-thread… however it will take ownership of the TypedArrays"`），所以渲染进程那份拷贝会被 detach，不会双份。现状不算浪费，只是首屏慢。

**range 模式的一个隐藏代价（源码推断，未实测）：** `NetworkPdfManager.ensure` 捕获 `MissingDataException` → `requestRange` → **`return this.ensure(obj, prop, args)` 从头重来** `[R26]`。`#readDocumentOutline` 是不可中断的整树 BFS，若 1212 个 outline 对象散落在 K 个未加载的块里，这棵树就会被**重新解析 K 次**。合成样本里 outline 连续，只多了 2 个块，所以没暴露。**真实的大部头上这条要实测**。

---

## 2. 没有 TOC 时怎么重建目录（B）

### 2.1 「书有书签、论文没有」这个假设 —— **没查证，而且现有证据指向相反方向**

**先把结论说死：这个假设无人测过。** 没有任何一份公开来源把「书」和「论文」的 `/Outlines` 普及率**分开**测过 `[E8]`。任何大规模 PDF 语料上的 `/Outlines` 普及率统计——SafeDocs / veraPDF / PDF Association / Digital Corpora / GovDocs1 / Common Crawl 相关工作，以及厂商——**都没有发布过** `[E8]`。**这一条不能顺着直觉写成结论。**

**唯一能找到的实测数字，全都来自学术论文的无障碍审计，而且都很高（经转述，本文未独立核对 `[E8]`）：**

| 来源 | 样本 | 有书签的比例 |
| --- | --- | --- |
| Nganji 2015 | n=200（2009–2013 的论文）| **50%** |
| Nganji 2018 | n=200（2014–2018 的论文）| **74.5%** |
| Hovious & Wang 2024 | N=120 | **73.3%** |

**方向是反的。** 如果论文里就有 50–74.5% 带书签，那「论文常常没有」这个前提本身就站不稳；而「书更高」这一半**完全没有数据**。

> **另一 session 自跑的一次抽样**（**不是已发表来源**，样本 **n=400** 的网络 PDF，取自 SafeDocs 的 Common Crawl 语料）：`/Outlines` 存在 **14.6%**、其中非空 **10.6%**、`/StructTreeRoot` **34.4%**；另在该语料 8,410,703 行 `pdfinfo` 元数据上，`Tagged=yes` 占 **34.0%** `[E9]`。**这组数字的性质要说清楚：一次未发表的小样本抽样，测的是「网络上的 PDF」——既不是书也不是论文，与我们的场景不同分布。** 它能说明的只有一件事：在开放网络的 PDF 里，带书签的是少数。它**不能**用来推论中文技术书。

**我自己能证的（实测 `[M3]`，n=3）：** 三篇 pdfTeX 论文里 ResNet **完全没有** outline，Attention/DDPM 有；三篇 `hasStructTree` **全是 false**、`pageLabels` **全是 null**。n=3 说明不了普遍性，但足以说明**「没有 outline」在论文里是正常路径而不是错误**——`readOutline` 的注释已经这么写了 `[R7]`，是对的。

**但 ResNet 那一例的原因值得追一下，因为它改变了这条实测的含义（字节级实测 `[M10]`）：**

- ResNet 的**顶层** `/Info` 是 `Producer: pdfTeX-1.40.12` / `Creator: LaTeX with hyperref package`——看上去和另外两篇同类。
- 但文件里还散落着 **7 个孤立的 `/Info` 字典**，是被合并进来的组件 PDF 留下的：6 个 Visio 图（`Visio-teaser.vsd`、`Visio-arch6.vsd`、`Visio-curves.vsd`…，`Creator: PScript5.dll Version 5.2.2` / `Producer: Acrobat Distiller 11.0 (Windows)`），以及**正文本身**——`/Title (residual_v1_cvpr_edit1b.pdf)`、`/Creator (LaTeX with hyperref package)`、**`/Producer (Acrobat Distiller 11.0 (Windows))`**。
- Attention 全文里 `Distiller` 出现 **0 次**。

**推论（我的，不是实测）：** ResNet 的正文是 hyperref 产出之后又过了一道 PostScript → Distiller，然后被合并成最终文件。hyperref 的 `bookmarks` 选项**默认就是 true** `[E10]`——作者没有关掉它，是**工具链在某一步把 `/Outlines` 丢了**。

> **这条改变了结论的措辞。** 「论文常常没有目录」这个说法把原因归给了「论文」这个类别；实际看到的是「**目录会被 PostScript 往返 / PDF 合并这类操作洗掉**」。同样的事故完全可以发生在书上（出版社把封面、正文、索引分别产出再合并）。**所以更不该按文档类型分支——该分支的是「这个文件里到底有没有」。**

**书这一侧唯一一个真正被测过的数字，来自 INEX：** 其 50,239 本数字化图书的语料里，**约 80% 有印刷的目录页** `[E11]`。**注意它测的是「印刷的目录页」，不是 `/Outlines`**——那批书是扫描的公版书，根本没有书签。但对我们有用的正是这个数：**§2.3 那条「解析目录页」的路，天花板大概是 80%。**

作为对照，Tagged PDF 在学术论文上被反复测过，一致地低：**13.4%**（SciA11y，n=11,397）、**12.6%**（Kumar & Wang，n=19,997，原文 *"74.9% fail to meet any criteria at all"*）`[E12]`。这印证了 §2.2 里给 `/StructTreeRoot` 的判断。

**这个不确定性该怎么落到设计上：不赌任何一边。**

1. **运行时探测，别按文档类型分支。** 开一本文件就依次问：`getOutline()` 是否非空 → 前 `min(20, numPages/5)` 页有没有带 `dest` 的 Link → 有没有可读的目录页文本 → 有没有文本层。**是「书」还是「论文」不该是代码里的一个 if。**
2. **不要为「书一定有书签」做任何优化假设**（比如省掉降级路径、或把目录 UI 做成必然存在）。档 2 的目录页解析不是可选的兜底，它是**主路径的一部分**。
3. **留一条可观测的记录**：每次打开时把「走了哪条路 / outline 项数 / hasStructTree / 有无 pageLabels」记进日志。**我们自己的读者手上那几十本书，就是这个问题上最相关的样本**——与其等文献，不如三个月后回头看自己的日志。这比任何公开语料都更贴近真实分布。

### 2.2 各条路的可靠性排序

| 路 | 拿得到什么 | 前提 | 我的判断 |
| --- | --- | --- | --- |
| **1. `/Outlines`** | 标题 + **物理页号** + 层级 + **默认折叠状态** | 制作方写了书签 | **无可替代。** 唯一直接给出物理页号的路，没有页码偏移问题 |
| **2. 目录页上的 Link annotation** | 标题（文本层）+ **物理页号**（dest） | 目录页是「活的」（可点击） | **被严重低估。** 见 §2.3 |
| **3. 目录页的文本层（点线 + 印刷页码）** | 标题 + **印刷页号** + 缩进层级 | 书前面有印刷目录、文本层可读 | 可行，但要解「印刷页号 → 物理页号」 |
| **4. 字号/字重启发式扫全文** | 候选标题 + 物理页号 | 文本层可读、排版有区分度 | 几千页上代价最高、可靠性最低 |
| **5. `/StructTreeRoot`** | role（`H1`…）+ 内容 id，**不含文本** | Tagged PDF | **不值得做**，见下 |

**为什么把 `/StructTreeRoot` 判死刑（两条源码事实 + 一条实测）：**

- `getStructTree()` 是 **`getStructTree(pageIndex)`，逐页的** `[R8]`。一本 3000 页的书要调 3000 次。
- 返回的 `StructTreeNode` 只有 `{ role, children }`，叶子是 `StructTreeContent = { type, id }` —— **id 是「映射到 text layer 的唯一 id」，不是文本** `[R3]`。要拿到标题文字，还得对同一页再调一次 `getTextContent({ includeMarkedContent: true })`，在 `beginMarkedContentProps` / `endMarkedContent` 之间按 id 拼 `[R27]`。**两趟全文扫描才能得到一份目录。**
- 三篇论文 `hasStructTree` 全 false `[M3]`。

> **公平起见：普及率不是它出局的理由。** `[E9]` 那次抽样里 `/StructTreeRoot` 占 **34.4%**、`pdfinfo` 的 `Tagged=yes` 占 **34.0%**——**不算小**。但 `pdfinfo` 的 `Tagged` 读的是 `/MarkInfo /Marked`，它只说「这份文件声称自己是 tagged 的」，**不保证结构树里有可用的 `H1`…`H6` 层级**。真正让这条路出局的是上面两条 **API 形状**的事实：逐页调用 + 不含文本 + 要配 `includeMarkedContent` 再扫一遍。**即使一本书是 tagged 的，代价也比读它的目录页高一个量级。**

好消息是这个探针**很便宜**：`getMetadata()` 就带 `hasStructTree`（走 `ensureCatalog("hasStructTree")`）`[R28]`，O(1) 判定，**可以留一个开关，等真遇到 Tagged PDF 再说**。

### 2.3 目录页这条路的两个层次（这是我最想推的一条）

**先给外部背书，因为这条路我原本只是凭直觉推的，而它有二十年的评测支持。** INEX / ICDAR 的 Book Structure Extraction 竞赛做的正是这件事——从数字化图书重建带链接的目录。三轮下来组织者的原话是 *"As in the past, the best performing methods are those that focus specifically on ToC pages"* `[E13]`；2013 那届的总结更直接：*"most of the participants focused on detecting ToC pages and exploiting their content. They made no use of the rest of the contents of the books, except for the purpose of page linking"* `[E11]`。**§2.6 会给出反面那一档的分数。**

还有两个可以直接抄的做法：

- **搜索范围**：Wu 等人取前 `min(20, N/5)` 页 `[E14]`。我原先随手写的「前 30 页」对 3000 页的书是 `min(20, 600) = 20`——**比我的 30 还窄**。用他们的公式。
- **页码偏移**：Epita 的做法是「拿书中间某一页的物理页号与它的印刷页号求差，这个差值套用到全书」`[E11]`。与我在层次二里想到的做法同源，但他们只用一个点、我建议用多点投票（见下）。

**层次一：目录页有 Link annotation —— 直接、无歧义、便宜。**

pdf.js 的 `LinkAnnotation` 构造函数调的是**同一个** `Catalog.parseDestDictionary` `[R29]`，也就是说：**link 的 `data.dest` 与 outline item 的 `dest` 是同一种东西，同一套解析代码，同样可以喂给 `getPageIndex`。** 于是：

1. 对前 `min(20, numPages/5)` 页 `[E14]` 逐页调 `page.getAnnotations()`，挑 `subtype === "Link"` 且 `dest !== null` 的；
2. 每个 link 有 `rect`；把同页 `getTextContent()` 里落在这个 rect 内的 `TextItem.str` 拼起来 = 标题；
3. `dest` → `getPageIndex` = **物理页号**，与 `/Outlines` 完全等价；
4. 层级从 `rect` 的左边界（缩进）推。

**这条路我实测过一半（`[M9]`）：** Attention 的 p.2 有 **30 个 Link annotation**，每个都带 `dest`（形如 `"cite.hochreiter1997"`、`"figure.1"` 的**命名 dest**），经 `getDestination` + `getPageIndex` 全部解出了物理页号。论文里这些 link 指向参考文献和图、不是目录——但**机制完全一样**，书的目录页上的 link 只是 `dest` 指向章节而已。

> 顺带印证了 §1.3 的那条：hyperref 用的是**命名 dest**，所以「`getDestinations()` 一次批量取回」这条捷径在真实文件上是有意义的。

**代价：20 页的 `getAnnotations` + `getTextContent`，量级是全书的 0.7%（3000 页全扫才 3.2 s `[M6]`，20 页 ≈ 20 ms）。**

> 文档级的 `getAnnotationsByType(types, pageIndexesToSkip)` 也存在，但它的 handler 会 `for (let i = 0; i < numPages; i++)` 遍历**所有**页 `[R30]`——3000 页上不划算，而 `pageIndexesToSkip` 要传一个 2970 元素的 Set 才能限制范围。**直接对前 20 页逐页 `getAnnotations()` 更简单也更快。**

**层次二：目录页只有文字（点线 + 页码）。**

这时拿到的是**印刷页号**，而摘录、切块、渲染全用**物理页号**（0/1 基的页索引）。差值来自封面、版权页、前言——中文技术书这一段常有十几到几十页。两种解法：

- **`getPageLabels()` 非 null**：反查 label → index。**注意这个映射不是单射**——`#readPageLabels` 只是把 `/Nums` 逐页展开 `[R2]`，一本书里「前言 1、2、3…」与「正文 1、2、3…」会产生**同名 label**（而且 `/S` 缺省时 label 可以是空串）。反查要按「目录项顺序应当单调递增」去挑，不能拿第一个命中的。
- **为 null**：只能标定一个常数偏移。可靠做法是拿目录里的**若干条**去验证——对第 k 条的印刷页号 p，猜偏移 d，去物理页 `p+d` 的文本层里找该条标题；取让最多条目对上的 d。（这是我的设计，**没有一手来源**，属于推测。）

**中文书在这一层的额外麻烦（我的分析，未实测）：**

- **点线**：中文排版的引导符可能是 `.`、`·`、`……`，也可能干脆用空白靠制表位对齐——**不能只匹配 `\.{3,}`**。更稳的信号是「行尾是数字或罗马数字」。
- **编号形式并存**：`第三章` / `第 3 章` / `3.1` / `一、` / `（一）` 会在同一本书里混用（章用汉字、节用阿拉伯数字是常见组合）。层级最好**别从编号推**，从**缩进（x 坐标）**推——那是排版直接给的。
- **繁简**：目录页解析不受影响（原样取字符串），但**检索侧**会：简体 query 打不中繁体正文。这与 outline 无关，属于本文范围之外的既有问题。
- **CJK 断字**：`TextItem` 的切分由 PDF 的 `Tj`/`TJ` 决定，中文常常一个 `TextItem` 就一整行，也可能被逐字拆开。标题拼接必须按 x 坐标聚行（我们已经有 `src/pdf/lines.ts` 干这件事）。

### 2.4 中文书的先决条件：`cMapUrl`（这是个现存 bug）

**这是本轮最要紧的一条实测。**

中文书常见形态：**不嵌入 CJK 字体**，用 `/Type0` + `/Encoding /UniGB-UCS2-H`（或 `GBK-EUC-H`、繁体的 `UniCNS-UTF16-H`）指向 Adobe 的**预定义 CMap**。pdf.js 要靠 `pdfjs-dist/cmaps/` 里的 `.bcmap` 才能把码位映到 CID 再映回 Unicode。

我们现在的调用是 `pdfjs.getDocument({ data: bytes })` `[R31]` —— **没有 `cMapUrl`**。源码路径是：`fetchBuiltInCMap` → `DOMBinaryDataFactory` → `if (!baseUrl) throw new Error("Ensure that the \`cMapUrl\` API parameter is provided.")` `[R32]`。

**实测（自造一份 `UniGB-UCS2-H` + 不嵌入 `STSong-Light` 的中文页）`[M5]`：**

```
Warning: loadFont - translateFont failed: "UnknownErrorException: Ensure that the `cMapUrl` API parameter is provided."
不带 cMapUrl（现状）: ""                    (期望 "第三章 进程与线程") -> ❌
带 cMapUrl        : "第三章 进程与线程"      (期望 "第三章 进程与线程") -> ✅
```

**注意失败方式是「空字符串」，不是乱码，也不是异常。** 页面照常渲染（字形画得出来），文本层却是空的——于是：目录页解析拿到空、`chunkDocument` 切出零块、检索永远查不到、文本流摘录（ADR-0016）全部退化。**而且没有任何报错冒到 UI 上，只有一行 console warning。** 这是最难查的那类故障。

**要打进产物的静态资源**（`pdfjs-dist` 里现成，实测体积）：`cmaps/` **1.6 MB**（169 个 `.bcmap`，含 `UniGB-*`、`GBK-*`、`UniCNS-*`、`Adobe-GB1-UCS2`）、`standard_fonts/` **800 KB**、`wasm/` **1.5 MB**（JBIG2 / OpenJPEG / qcms——**扫描版中文书大量用 JBIG2**）`[M7]`。

> 顺带：`useWorkerFetch` 只在 **`cMapUrl`、`standardFontDataUrl`、`wasmUrl` 三个都提供且都是 http(s)** 时才默认为 true `[R33]`。既然我们已经有本机 HTTP server，把这三个都指过去是最省事的做法，还能让 worker 自己去取、不经主线程中转。

### 2.5 该期待多高的准确率（有二十年的评测数字，别自己拍脑袋）

INEX / ICDAR 的 Book Structure Extraction 竞赛按**三样东西**打分：标题（编辑距离近似匹配）、**层级**（树深度对不对）、**链接**（是不是指到同一张物理页）；三样全对才算一个 **complete entry** `[E11]`。

**ICDAR 2013，967 本书，title-based F-measure（complete entries）`[E11]`：**

| 名次 | 参赛方 | 方法取向 | F |
| --- | --- | --- | --- |
| 1 | MDCS（Microsoft Development Center Serbia）| **目录页** | **43.61%** |
| 2 | Nankai U.（PRC）| **目录页优先**，检测不到才回退全文 | 35.41% |
| 3 | Innsbruck U. | **目录页**（ML 检测目录区 + 模糊逻辑）| 31.34% |
| 4 | Würzburg U. | 目录页 | 19.61% |
| 5 | Epita | 目录页（PDF text box）| 14.96% |
| 6–10 | **GREYC / U. of Caen（5 个 run）** | **全文扫描，完全不找目录页** | **8.81% / 7.91% / 6.21% / 4.71% / 3.79%** |

MDCS 的分项：标题 F **59.59%**、层级 F **47.36%**、链接 F **54.54%**、三项全对 **43.61%**。换成只看链接的 XRCE 指标（标题错不再作废整条），最好的 Innsbruck 到 **67.2%**、MDCS **66.6%** `[E11]`。

**这些是 OCR 扫描书的分数。我们的场景（born-digital、有真文本层）要好得多——同一批作者在 200 本 born-digital 的 CiteSeerX 书上测过 `[E14]`：标题 F **83.1%**、链接 **73.1%**、层级 **71.0%**、三项全对 **56.9%****（同法在 1,040 本 INEX 扫描书上只有 41.8%）。

**读法，三条：**

1. **全自动的天花板是「三项全对 ~57%」（born-digital）/「~44%」（扫描）。** 这不是「差不多能用」，这是**近一半的条目会有某一项错**。**所以自动重建的目录必须标成「自动识别」，而且必须可编辑**——把它做成和 `/Outlines` 一样不可置疑的东西是错的。
2. **标题比层级好认得多**（83% vs 71%）。如果层级信不过，**退化成一层平表也比给错层级好**——`Section.level` 可以先全填 0。
3. **链接（页号）单独看能到 67–73%**，而它正是我们归组摘录真正依赖的东西（`Section.page` / `y`）。这也支持「优先用 Link annotation」——那条路的链接是**精确**的，不是猜的。

### 2.5.1 现成实现：没有一个能直接用

| 工具 | 重建目录？| 面向 | CJK | 许可 / 能不能进 Electron |
| --- | --- | --- | --- | --- |
| **PyMuPDF `get_toc()`** | ❌ 只读现成书签——*"Creates a table of contents (TOC) out of the document's outline chain"* `[E15]` | 任意 | — | AGPL-3.0，Python |
| **pdfplumber** | ❌ 完全没有 outline / toc / heading 相关代码 `[E16]` | — | — | MIT，Python |
| **GROBID** | ⚠️ 只出**平铺**的 section，层级被**移除过** | **论文** | ❌ 官方原文 *"the models are primarily trained on English-language articles, with some German and French"*、*"Quality for other languages is unpredictable"* `[E17]` | Apache-2.0，**Java 服务，~500 MB 镜像，不可嵌入** |
| **docling** | ✅ 2026-06 起有 `heading_hierarchy_model`，**默认关闭** | 任意 | ❌ 编号正则**全是拉丁文**（`^(part\|title\|book)`、`^(chapter)`…），整个文件里 **CJK 码位 0 个** `[E18]` | MIT，Python |
| **marker** | ✅ 对行高做 `KMeans(n_clusters=4)`，输出**平铺**列表 | 任意 | 只声明多语 OCR | 代码 Apache-2.0 / **权重 OpenRAIL-M**，Python |
| **MinerU** | ⚠️ **只有调外部 LLM 才有层级**（`llm_aided.py` 是 `block["level"]` 的唯一写入者，默认走阿里云 API）| 任意 | ✅ CJK 最强 | Apache-2.0 + 用量上限，Python，**需要联网**——与 local-first 直接冲突 |
| **pdf.tocgen** | ✅ 人工先标一次字体过滤器，再全文抓 | born-digital | 无声明 | GPL-3.0，Python |
| **pdf.js** | ❌ 只读 `/Outlines`；**开着一个 issue #17921 要的正是这个功能，2024-04 至今未实现** `[E19]` | — | — | — |

**结论很硬：没有任何 JS / TS / WASM 库能重建层级目录。** 全是 Python / Java / .NET。对一个 local-first 的 Electron 应用，这意味着**要么起一个 Python 边车，要么自己在 pdf.js 之上写。** 考虑到 §2.5 的准确率天花板，**自己写一个「目录页 + Link annotation」的窄实现，比拖进一整个 Python 运行时更划算**——那些库的通用能力我们用不上，而它们的弱项（CJK、层级）恰恰是我们最需要的。

**一条来自 GROBID 维护者的证词，值得整段引：**

> *"Yes, currently the sections are 'flat'. In the past, grobid was actually creating a hierarchy of sections, but it was not working well… Given that it was not reliable, it was removed."*
> *"In my previous approach, I was clustering the section headers based on font size, style and font name to try to identify header 'levels'… But as for you, it was far from perfect. We could also use the PDF outline information… **Maybe in 50% of the cases when present, it gives a reliable section hierarchy** with the coordinates of the section headers. The problem is that in the other 50% of the cases, it is crap and noise…"* `[E20]`

**一个做了十年学术 PDF 解析的项目，试过字号聚类做层级，做不好，删掉了。** 这是 §2.6 那条判断最强的外部支持。

### 2.6 一个反向结论：字号启发式在几千页上不值得做

- **有直接的评测证据，而且难看**：ICDAR 2013 里唯一一支「不找目录页、直接全文扫描」的队伍（GREYC / U. of Caen，用 4 页窗口找大段空白当章节边界）5 个 run 的成绩是 **8.81% / 7.91% / 6.21% / 4.71% / 3.79%**，而目录页派的第一名是 **43.61%** `[E11]`——**差 5 倍**。Nankai 的混合方案更说明问题：*"If a ToC is identified, the ToC area is exploited and the headlines found in the book are ignored… justified by empirical evidence that the method exploiting the analysis of ToC areas performs best"* `[E11]`。
- **GROBID 试过、删了**（§2.5.1 那段引文 `[E20]`）：字号 + 字重 + 字体名聚类做层级，「不可靠，所以移除了」。
- **代价**：要跑全书 `getTextContent`。实测 3000 页 **3.1 s / 峰值 +300 MB** `[M6]`——这还只是**合成的、纯文本、单字体**的书；真实的中文书带嵌入字体和图，会显著更慢更吃内存（§4.1 里 DDPM 25 页就 +326 MB RSS）。
- **信号本身也不够**：`TextItem` 给的是 `str / dir / transform / width / height / fontName / hasEOL` `[R34]`，`styles[fontName]` 给 `{ ascent, descent, vertical, fontFamily }` `[R35]`。**没有任何 bold / weight 字段**——字重只能靠 `fontFamily` 字符串里有没有 `Bold`/`Hei`/`Black` 来猜，而中文书的黑体常叫 `SimHei`、`STHeiti`、`FZHei`、`MicrosoftYaHei-Bold`，没有统一命名。
- **对比**：目录页那条路只要读 20 页，信号是「作者亲手写下的目录」而不是我们猜的。

**所以：字号启发式应当是最后一档，而且应当限定在「书没有 outline、也没有目录页」这个交集上——那大概率是一份扫描件，而扫描件根本没有文本层，启发式无从谈起。** 换句话说，**这一档的适用面比看上去窄得多，优先级应当排到最后，甚至可以先不做**。

---

## 3. 可折叠大纲的数据结构与虚拟滚动（C）

> 本节的库与模式部分依据并行调研的一手结论，引用键 `[E…]` 见 [Sources](#sources)。

### 3.1 先说一句不受欢迎的话：1000 项**折叠着**只有几十行

一个 2–4 层的书目录，折叠到章一级通常是 **20–80 行**。1000+ 这个数只有在「全部展开」时才出现。**所以虚拟化的触发条件是「展开全部」这个按钮，不是「这本书很长」。** 如果不提供「展开全部」，可以完全不虚拟化。

能找到的最硬的一手阈值不是来自 React 或任何虚拟化库，而是 Chrome Lighthouse 的 `dom-size` 审计：body 超过 **~800 个节点**告警、超过 **~1,400 个**报错 `[E3]`。一行大纲若是 `treeitem` + 折叠按钮 + icon + 标题 + 页码，约 5–8 个节点 → 全展开 1212 项 ≈ **6,000–9,700 节点**，是报错线的 4–7 倍。**这才是该引用的数字。**

### 3.2 扁平化 + 虚拟列表：两个独立实现给出同一个结构

`react-arborist` 的 `flattenTree` 是这个模式的最小参考实现（25 行）`[E4]`：先序遍历，**只有 `node.isOpen` 才递归进子节点**，产出 `Array<{ id, level, isOpen, isLeaf, rowIndex, … }>`；`level` 直接变 `paddingLeft`。`headless-tree` 的 `ItemMeta` 是同一个形状，另外带 `setSize` / `posInSet`——那两个是 `role="treeitem"` 的 ARIA 必需项 `[E5]`。

**对我们的意义：** `Section[]` 现在已经是**拍平且按阅读顺序排好的**，还带 `level` 与 `path` `[R36]`——**结构上已经就位了**，缺的只是「按展开状态过滤」这一步纯函数：

```
visibleSections(sections, expanded) → Section[]
```

它是纯函数、可测试，应当放在 `src/clip/outline.ts` 旁边（与 `groupClipsBySection` 同一层），不进 `app/react/`。

### 3.3 库的选择

仓库现状：**React 19.2.6，零虚拟化依赖、零树依赖** `[E6]`——任选一个都是新依赖。

| 候选 | 是否有 tree | 可变高度 | 判断 |
| --- | --- | --- | --- |
| **TanStack Virtual 3.14.9** | ❌ 只有扁平列表（官方 React 示例目录里**没有 tree**）| ✅ `estimateSize` + `measureElement` | **扁平化之后我们本来就只需要扁平列表**。headless、MIT、peer 含 React 19、10–15 kb `[E1]` |
| **react-window 2.3.0** | ❌ | ✅ `useDynamicRowHeight`（2.2.0 起，内置 `ResizeObserver`，**v2 起不再需要 AutoSizer**）| 零运行时依赖、更小；官方明写*"Dynamic row heights are not as efficient as predetermined sizes"*；它的 `key` 选项要在展开/折叠改变行集时重置测量 `[E2]` |
| react-arborist 3.16.0 | ✅ 现成的树（键盘导航、`role="tree"`、搜索、DnD）| ❌ 行高要预先知道 | 依赖 **react-window v1**（不是 v2）+ react-dnd 14 + redux 5，为一个侧栏引入这些不划算 `[E4]` |
| react-virtuoso 4.x | ❌（`GroupedVirtuoso` 的 API 是 `groupCounts: number[]`，**只有一层**分组）| ✅ | 形状不对，2–4 层的树映射不上 `[E7]` |

**我的建议：先不引任何虚拟化库。** 折叠状态下几十行，普通渲染完全够。**等真加了「展开全部」再引 TanStack Virtual**——因为那时我们喂给它的已经是一个扁平数组，接入成本很低。这是一个可以推迟的决定，推迟本身没有代价。

### 3.4 折叠状态存哪

三个库都只暴露一个「app 自己持有的可序列化 id 集合」，**没有任何一手来源讲持久化**（`react-arborist` 是 `OpenMap = { [id: string]: boolean }`，还刻意分成 `unfiltered` / `filtered` 两份，这样搜索过滤不会毁掉手动展开的状态；`headless-tree` 是 `expandedItems: string[]`）`[E4][E5]`。

**关键是 id 怎么取，这一条我们有具体风险：**

- **不能用数组下标。** 重新解析、换一版 PDF，下标就错位。
- **不能只用标题。** 上千项的中文书里「小结」「习题」「参考文献」会重复几十次。
- **也不宜直接用现在的 `path`（祖先标题数组）。** `src/clip/outline.ts` 的 `isAncestor` 已经在用标题路径判祖先关系了 `[R36]`——在 22 项的论文上没问题，在 1212 项的书上，同一章下两个同名兄弟节点就会互相冒充。
- **建议：树中的下标路径 `"2/5/1"`**（第 3 章 → 第 6 节 → 第 2 小节）。稳定、短、天然唯一、天然带层级。这个 id 顺便也能修 `isAncestor` 的重名隐患。

**默认值来自 `count`（§1.1）**：没有存过状态时，`defaultCollapsed = (count ?? 0) < 0`。存过就用存的。落盘位置与 clip / index 缓存同层（`.library/<docId>/`）。

---

## 4. 几千页 PDF 的内存（D）

### 4.1 pdf.js 的内存模型：谁住在哪、什么时候放

**主线程持有：**

- `WorkerTransport.#pageCache: Map<pageIndex, PDFPageProxy>` —— **无上限**，`getPage()` 取过的每一页永久驻留，只有 `startCleanup()` 或 `destroy()` 才清 `[R13]`。3000 页全扫一遍就是 3000 个 proxy。
- 每个 `PDFPageProxy._intentStates` 里的 **operator list**（渲染指令数组）与 `objs`（本页解出来的图像）。这是渲染后的大头。
- `commonObjs`（跨页共享的字体等）、`fontLoader` 挂在 DOM 上的 `@font-face`。

**worker 持有：**

- `ChunkedStream` / `Stream` 的**整份文件字节**（range 模式下也按全长预分配，§1.6）。
- `XRef.#cacheMap`：**取过的每个 PDF 对象，永久**，`cleanup()` 不清 `[R15]`。
- `Catalog` 上一堆 `shadow` 缓存（`documentOutline`、`pageLabels`、`destinations`…）与 `pageDictCache` / `pageIndexCache` / `pageKidsCountCache`。
- `fontCache`、`builtInCMapCache`、`standardFontDataCache`、`globalImageCache`（≤ 50 MB）。

**实测：主线程侧的渲染残留（用 `getOperatorList()` 隔离出 pdf.js 自己的保留量，不掺 canvas 分配器噪声）`[M8]`：**

| 样本 | `page.cleanup()` | 之后 heapUsed | 之后 RSS |
| --- | --- | --- | --- |
| 合成书 500 页（纯文本）| 否 | 12 → **55 MB** | 147 → 256 MB |
| 合成书 500 页 | **是** | 12 → **36 MB** | 145 → **219 MB** |
| DDPM 25 页（带图）| 否 | 11 → 22 MB | 141 → **467 MB** |
| DDPM 25 页 | **是** | 11 → 17 MB | 139 → **392 MB** |

**读法：**

- **`page.cleanup()` 确实有效**：纯文本页省掉 ~35% 的 heap，带图页省掉 ~23% 的 RSS。**渲染完一页就该调**（它在渲染中会自己返回 false 并延后，不会打断渲染 `[R12]`）。
- **带图的页极贵：DDPM 25 页就吃掉 326 MB RSS，≈ 13 MB/页。** 一本带插图的技术书连续翻 100 页而不清理，就是 GB 级。
- **`doc.cleanup()` 之后 heapUsed 全部回到 13–14 MB**——JS 堆是能收回的。
- **RSS 收不回来**（cleanup 后仍是 255 / 467 MB）。V8 与原生分配器不把已提交的页还给操作系统。**所以指标要看峰值，不是稳态。**

### 4.2 `chunkDocument` 在 3000 页上会怎样

现状：`for (let page = 1; page <= document.numPages; page++)` 全量 `getPage` + `getTextContent`，结果全存在内存里 `[R37]`。**没有 `page.cleanup()`。**

**实测（合成书 3000 页）`[M6]`：**

| 策略 | 耗时 | gc 后峰值 RSS | 结束时 heapUsed |
| --- | --- | --- | --- |
| 现状（什么都不清）| 3.2 s | **446 MB** | 167 MB |
| 每页 `page.cleanup()` | 3.2 s | **446 MB**（无差别）| 167 MB |
| 每 200 页 `doc.cleanup()` | 3.2 s | **390 MB** | 23 MB |

**`page.cleanup()` 对文本抽取完全没用**——`getTextContent` 走的是流式 reader，不填 `_intentStates`，`cleanup()` 无事可做。**要清的是 worker 侧的 `pageDictCache` / `fontCache`，那只有 `doc.cleanup()` 能做到。**

但即便如此：**pdf.js 这一段不是墙。3.2 秒、峰值 390–446 MB，可以接受。** 墙在后面：

**下面这段是外推，不是实测，所以把假设摊开写。** 合成书是 3,336 字符/页（密集 ASCII），比真实书偏高；而 `packLines` 还有 `OVERLAP_LINES = 2` 的重叠，块数要比「总字符 ÷ 600」更多 `[R37]`。分两种真实形态各算一遍：

| | 合成书（实测字符数）| 3000 页英文技术书 | 3000 页中文技术书 |
| --- | --- | --- | --- |
| 每页字符（假设）| **3,336（实测）** | ~3,000 | ~1,000（汉字） |
| 全书字符 | **10,008,720（实测）** | ~9,000,000 | ~3,000,000 |
| 块数（÷600，再计 ~15% 重叠）| ~19,000 | ~17,000 | **~5,800** |
| embedding 耗时（22 ms/条 `[R43]`）| ~7 min | **~6 min** | ~2–3 min（中文 600 字符 ≈ 400 token，单条更慢，**这一格最不可靠**）|
| 向量（768 维 float32，3,072 B/条）| 58 MB | 52 MB | **18 MB** |
| **索引缓存的单个 JSON**（base64 4,096 字符/条 + 正文）| ~88 MB | ~78 MB | **~27 MB** |

**读法：数量级是 5,000–19,000 块、2–7 分钟、几十 MB 的单个 JSON。** 具体落在哪一格取决于书，但**没有一格是「和论文差不多」**——现在一篇 30 页论文是几百块、几秒钟、几百 KB。**差了两个数量级，这是模型问题不是调参问题。**

三条具体的痛点：

- **`http-index-cache` 是「一个 docId 一个 JSON」**，`load()` 用 `await response.json()` 一次性解析、`save()` 用 `JSON.stringify` 一次性序列化 `[R38]`。几十 MB 的 JSON 在这两步上会产生**数倍于自身的瞬时字符串**。
- **打开即全量**：现在的语义是「开一本书就把全书建成索引」。在论文上这是几秒，在书上这是几分钟的 CPU 占用，而读者只想翻开第 3 章。
- **知识库规模**：`research-local-rag-stack.md` 实测 sqlite-vec 在 1 万条向量上是**暴力全扫**、6.3 ms `[R39]`。一本书就 5,800–19,000 条，**两三本书就逼近那份文档明说「无公开数据」的 10 万条线**。

**结论：`chunkDocument`「开一本书就把全书建成索引」这个模型，在几千页上不成立。** 不是慢一点的问题，是「打开一本书要转几分钟、写一个几十 MB 的 JSON」。**必须改成分段/按需。** 具体见 §6 档 4。

### 4.3 canvas 尺寸与 devicePixelRatio

`Reader.tsx` 现在是 `canvas.width = vp.width; canvas.height = vp.height`，`vp = page.getViewport({ scale })` `[R40]` —— **既不乘 DPR，也没有任何上限。**

canvas 内存是精确可算的：`width × height × 4` 字节。A4（595 × 842 pt）：

| scale | 像素 | 内存 |
| --- | --- | --- |
| 1.0 | 595 × 842 = 0.50 Mpx | **2.0 MB** |
| 1.5（实测用的值）| 893 × 1263 = 1.13 Mpx | **4.3 MB** |
| 2.0 | 1190 × 1684 = 2.00 Mpx | **8.0 MB** |
| 2.0 × DPR 2（Retina）| 2380 × 3368 = 8.01 Mpx | **32.0 MB** |
| 3.0 × DPR 2 | 3570 × 5052 = 18.0 Mpx | **72.1 MB** |

大开本的技术书（比如 8.5×11 in 甚至 B5 横排）还要再乘 1.2–1.5。

**pdf.js viewer 自己的护栏（我们没有，应当抄）`[R18]`：**

- `maxCanvasPixels = 2 ** 25` = **33,554,432 px**（≈ **134 MB** 像素）；iOS / Android 压到 `5242880`（≈ 21 MB）。
- `maxCanvasDim = 32767`（硬件纹理上限）。
- `capCanvasAreaFactor = 200` —— 再叠一层「不超过屏幕面积 × DPR² × 3」。
- 超限时 `OutputScale.limitCanvas()` 把 `sx/sy` 一起压下去 `[R41]`。
- `OutputScale.pixelRatio` 就是 `globalThis.devicePixelRatio || 1` `[R41]`。

**给实现的结论：** 渲染时按 `OutputScale` 的做法算 `sx/sy`，用 `limitCanvas(width, height, 2**25, 32767, 200)` 夹一次，canvas 内部像素用夹过的比例、CSS 尺寸用 `scale` —— 这样既清晰（DPR）又不会在大开本 + 高 DPI 上一页吃掉 72 MB。**我们只渲染一页，所以这不是「几千页」问题，是「一页可能很大」问题**，但它和大部头同时出现。

---

## 5. 边界：没回答的问题，与样本的局限

### 5.1 这份调研没有回答的问题

1. **真实的几千页中文书上的一切数字。** 全部实测都在合成样本或论文上做的。真实书会有：嵌入的 CJK 子集字体（`fontCache` 会大得多）、大量插图（`globalImageCache` 会顶到 50 MB 上限）、可能是扫描件（JBIG2/JPX 解码 + 没有文本层）。
2. **真实书里 outline 对象在文件中的分布**，决定了 range 模式下 `getOutline()` 会触发几次整树重解析（§1.6 末）。
3. **真实 Worker（非 fake worker）下的 IPC 成本。** Node 里 pdf.js 恒用 fake worker `[R10]`，所有跨线程数字都被低估了。1212 项 outline 的结构化克隆、1212 次串行 `getPageIndex` 往返——都要在 Electron 里重测。
4. **命名 dest 在真实**书**上是不是主流形态。** 部分有答案：`[M9]` 实测 hyperref 产出的 link 用的是命名 dest，所以论文侧成立；合成样本用的是显式数组 dest；**Acrobat / InDesign 产出的中文书用哪种，没测**。这决定了 `getDestinations()` 那条批量捷径能不能用。
5. **「书 vs 论文」的 `/Outlines` 普及率。** 这是本轮**最想要而最没拿到**的数字——`[E8]` 的结论是**无人测过**，而且现有的三个论文侧实测（50% / 74.5% / 73.3%）方向与直觉相反。§2.1 给了「不赌任何一边」的设计对策，但那是绕过去，不是回答。
6. **中文书里「不嵌入字体 + 预定义 CMap」这一形态的占比。** §2.4 证明了它一旦出现就是致命的，但**没有占比数据**。
7. **目录页解析在**中文书**上的准确率。** 英文侧有二十年的竞赛数字（§2.5），**中文侧一条都没有**——`[E11]` 的语料里唯一一本中文书被剔除了，其他基准全是英文。我自己也没有中文书样本可测。**这是档 2 唯一一个真正的未知数。**
8. **`page.cleanup()` 在真实渲染路径（`render()` 而非 `getOperatorList()`）下的收益。** 我用 `getOperatorList` 隔离是为了避开 `@napi-rs/canvas` 的原生分配噪声——试过直接渲染，200 页 RSS 到 909 MB，但那基本是 canvas 分配器不还内存，**测不出 pdf.js 自己的量**，所以那组数字作废、不列入本文。

### 5.2 合成样本的局限（明写）

`[M1]` 的合成书是：3000 页 × 40 行 ASCII、单一 base14 字体、无图、content stream 不压缩、传统 xref 表、1212 项 outline 且 outline 对象在文件里连续。它能证的是**结构性**问题（outline 树大小、页面树深度、range 请求模式、页数带来的缓存增长），**不能**外推到字体/图像/压缩带来的开销。凡是依赖这些的结论，我都标了推测或列进了 §5。

另有一处偶然的收获：我把中文标题按原始 UTF-8 字节写进 PDF 字符串（没加 BOM），pdf.js 读出来是 `", 1 à Chapter 1"`。这不是 bug——`stringToPDFString` 只认 **UTF-16BE（`FE FF`）/ UTF-16LE（`FF FE`）/ UTF-8（`EF BB BF`）三种 BOM**，否则一律按 PDFDocEncoding 逐字节查表 `[R42]`。**中文 outline 标题的正确性取决于制作方写没写 BOM**；写错了就是乱码，pdf.js 无从补救。这一条对「中文书的 outline 会不会是乱码」是个真实风险点。

---

## 6. 「几千页的书到底该怎么办」：五档方案

按**做的顺序**排，不是按重要性——每一档都是下一档的前提。

### 档 0 —— 先让中文书的文本层活过来（必做，最便宜）

**做什么：** `getDocument` 补上 `cMapUrl` / `cMapPacked: true` / `standardFontDataUrl` / `wasmUrl`，四个都指向本机 HTTP server 上的静态目录。

**前提：** 把 `pdfjs-dist` 的 `cmaps/`、`standard_fonts/`、`wasm/` 打进产物。

**代价：** 3.9 MB 静态资源 + 一条静态路由 + 四个参数。**这是全文最高性价比的改动。**

**不做的后果（实测，非推测）：** 一大类中文书的 `getTextContent` 返回空字符串，目录页解析、切块、检索、文本流摘录全部静默失效，只在 console 里留一行 warning `[M5]`。

### 档 1 —— 目录折叠：读 `count`，别猜（低风险，收益直接）

**做什么：**
1. `readOutline` 保留 `item.count`，`Section` 加 `count?: number`。
2. `Section` 加稳定 id = 下标路径 `"2/5/1"`；顺便用它替掉 `isAncestor` 里的标题路径比较（上千项时重名会咬人）`[R36]`。
3. 新纯函数 `visibleSections(sections, expandedIds)`，放 `src/clip/outline.ts`，有测试。
4. 默认展开状态 = `(count ?? 0) >= 0`；用户改过的状态落盘到 `.library/<docId>/`。
5. **`locate()` 改成 `Promise.all` 并行**，别 1212 次串行 await。

**前提：** 书自带 `/Outlines`。

**代价：** 很小。实测 1212 项解析 18 ms、解 dest 27 ms（fake worker 折扣见 §5.1 第 3 条）。**先不引虚拟化库**——折叠着只有几十行（§3.1）。

### 档 2 —— 没有 outline 时：解析目录页（这是「书」这条路的主力）

**做什么，按顺序退化（搜索范围一律取前 `min(20, numPages/5)` 页 `[E14]`）：**
1. 逐页 `getAnnotations()`，找带 `dest` 的 `Link` → 文本层取 rect 内文字当标题 → `getPageIndex` 拿**物理页号** → 层级用中文编号（`[E24]` 的 `第X章` / `一、` / `（一）` / `1.1`）为主、rect 左缩进为辅。**页号零歧义。**
2. 没有 link，就在同样这些页的文本层里找「行尾是页码」的行块，标题 = 行首到页码之间（去掉各种引导符），层级同上。
3. 印刷页号 → 物理页号：`getPageLabels()` 非 null 就反查（注意非单射，见 §2.3）；为 null 就用多条目投票标定一个常数偏移（Epita 的做法是单点求差 `[E11]`，多点投票更稳）。

**前提：** 书前面有印刷目录（**约 80% 的书有** `[E11]`），且文本层可读（← 依赖档 0）。

**代价：** 只读 20 页，量级 ~20 ms。

**准确率预期（这一段是这一档最重要的部分）：** 二十年的竞赛数字说，全自动重建在 born-digital 上是**标题 83% / 页号 73% / 层级 71% / 三项全对 57%**，扫描书只有 44% `[E11][E14]`。**近一半的条目会有某处不对。** 由此三条硬约束：

- **必须标成「自动识别」并且可编辑**，不能和 `/Outlines` 混在一起当同一种东西。
- **层级信不过就别给层级**——退成一层平表（`level` 全 0）比给错层级好（标题 83% ≫ 层级 71%）。
- **优先走路线 1**：Link annotation 的页号是**读出来的**不是猜的，只有标题与层级要推。

**我们相对所有现成实现的结构性优势：中文编号有国标 `[E24]`，而 docling / marker 这些的编号正则全是拉丁文 `[E18]`。** 这一档值得自己写，不值得拖一个 Python 边车进来（§7.4）。

### 档 3 —— 内存与加载：改成 range，但别指望它省内存

**做什么：**
1. `pdf-host.open` 从 `{ data: bytes }` 改成 `{ url: apiUrl('/bookshelf/<id>/pdf'), disableStream: true, disableAutoFetch: true }`；本机 server 的这条路由加 `Accept-Ranges: bytes` + `Range` 处理，**别 gzip**（`Content-Encoding` 必须 `identity`）`[R24]`。`rangeChunkSize` **保持默认 64 KB**（实测比 256 KB 省一半字节）。
2. `Reader.tsx`：渲染前按 `OutputScale` 算 DPR，用 `limitCanvas(w, h, 2**25, 32767, 200)` 夹一次 `[R41]`；渲染完（或换页时）对上一页调 `page.cleanup()`。
3. 长时间停留/切书时调 `doc.cleanup()`；换书必须 `loadingTask.destroy()`（RSS 收不回来，只能靠进程内不再增长）。

**前提：** 本机 HTTP server 支持 Range（我们已经有这台 server `[R23]`）。

**代价与收益（实测）：** 首屏从「等整份文件」变成「下 6.8%」；**内存不省**（`ChunkedStream` 按全长预分配 `[R5]`）。**这一档的价值是首屏延迟，不是内存——别把它当内存方案卖。**

**风险：** range 模式下 `MissingDataException` 会让整树 BFS 重来（§1.6 末），真实书上要实测。

### 档 4 —— 索引：这一档是真正的墙，必须改模型

**现状在 3000 页上的算术（实测 + 外推，逐格假设见 §4.2 那张表）：** **5,800–19,000 块** → **2–7 分钟 embedding** + **27–88 MB 的单个 JSON 缓存**（一次性 `JSON.parse` / `stringify`）`[M6][R38][R43]`。对照一篇 30 页论文：几百块、几秒、几百 KB。**差两个数量级，不是调参能救的。**

**可选的方向（本文不替它做决定，需要单独一轮设计）：**

| 方向 | 前提 | 代价 |
| --- | --- | --- |
| **按 Section 分段建索引**：只对读者当前所在的章/节建索引，翻到哪建到哪 | 有目录（档 1 或档 2） | 检索范围变成「读过的部分」，与「全书问答」的期望不符——**要先想清产品语义** |
| **分片持久化**：索引缓存从一个 JSON 改成按段/按页范围分片 | 无 | `IndexCache` 接口要改（现在是 `load(): Chunk[] | null` / `save(chunks)` `[R38]`），是个真实的接口变更 |
| **后台增量建索引**：打开就在后台慢慢跑，带进度与可中断 | 无 | 几分钟的 CPU 占用要让读者能看见、能停 |
| **只索引正文、跳过前言/索引/参考文献** | 有目录 | 省 10–20%，杯水车薪 |
| **落到 sqlite-vec 而不是 JSON** | 见 `research-local-rag-stack.md` | 单本 5,800–19,000 条仍在暴力全扫的舒适区，但**两三本书就逼近 10 万条那条无公开数据的线** `[R39]` |

**我的判断：档 4 应当先做「分片持久化 + 后台增量 + 可中断」这三件，把「打开一本书 = 转几分钟」变成「打开就能读，索引在后台长」。** 「按 Section 分段」是个产品决定，不该由性能倒逼。

### 明确不做的两件事

- **`/StructTreeRoot` 重建目录。** 逐页 API、不含文本、要两趟全文扫描，实测三篇论文全 false `[M3][R3][R8]`。留一个 `getMetadata().hasStructTree` 的 O(1) 探针记日志就够了，真遇上再说。
- **字号/字重启发式扫全文。** 代价是全书 `getTextContent`，信号是 `fontFamily` 字符串猜字重（`TextItem` 根本没有 weight 字段 `[R34]`），而它的适用面是「没有 outline **且** 没有目录页」——那多半是扫描件，本来就没有文本层。**排最后，可以先不做。**

---

## 7. 中文这一侧：文献几乎空白，但社区已经给出了答案

### 7.1 学术上没人做过中文书的目录抽取

- **没有任何中文图书目录抽取的基准。** INEX 是**纯英文**——2013 那届甚至把语料里**唯一一本中文书剔除了**（`beikokunouraomo00miyarich`，与一本重复书一起被移出 1,000 本的集合）`[E11]`。HRDoc / Comp-HRDoc / HierDoc 全是英文论文 `[E21]`。OmniDocBench 中英平衡且有 `book` 子类，但它评的是文本 / 表格 / 公式 / 阅读顺序，**不评目录层级** `[E22]`。
- **唯一一个亮眼的中文数字，读的时候要连着它的坑一起读。** Cao 等人在 **1,030 份 CNINFO 招股书 / 年报**上做「变深度逻辑层级抽取」，最好的 2step-HELD 拿到 **0.9731**（英文 HKEX 年报只有 0.7301、arXiv 论文 0.9578）`[E23]`。**别读成「中文更容易」**——他们自己写了 *"we conclude 44 types of patterns to represent the item number in headings"*，而英文集上 *"most headings do not match any regex"*。**中文金融公告是模板化的；CSAPP 不是。** 而且它要 42.58 s/篇、2×Titan 1080Ti。

### 7.2 中文编号是比字号更强的信号

**GB/T 15834-2011 把层级钉死为 `一、` → `（一）` → `1.` → `（1）`，再往下是 `①` / 小写拉丁字母** `[E24]`；书在这之上还有 `第X章` / `第X节`，同时并行使用 `1.1` / `1.1.1`。

**这比字号可靠，而且现成的工具全都漏掉了它**——docling 的编号正则是 `^(part|title|book)` / `^(chapter)` / `^(article|section|clause|…)`，整个 557 行的文件里 **CJK 码位 0 个**；它的 style 兜底用 `isalpha()` / `isupper()` 判全大写，**对汉字是空操作** `[E18]`。

> 这修正了我在 §2.3 里的说法。我原先写「层级最好别从编号推，从缩进推」。**更准确的说法是：中文书的编号形式是有国标的，比英文的更规整，应当作为层级的主信号；缩进作为交叉验证。** 需要小心的只是「章用汉字数字、节用阿拉伯数字」这类混用——但那是**可枚举**的，不是开放集。

### 7.3 中文社区早就在做，而且做法与 INEX 的结论一致：解析目录页

四个项目，全部**只解析目录页**，没有一个走全文字号扫描 `[E25]`：

| 项目 | 做法 | 许可 | 能不能用 |
| --- | --- | --- | --- |
| **chroming/pdfdir**（811★）| 自动读目录页（PaddleOCR 优先，回退 Tesseract）+ **自动推算页差** | GPL-3.0 | Python / 桌面 |
| **wmjordan/PDFPatcher**（12,618★）| OCR 图片目录页 | 无 LICENSE 文件 | **Windows / .NET only** |
| **NatsUIJM/autoContents** | 调 Qwen API | **专有非商业** | 需联网 |
| **ifnoelse/pdf-bookmark**（1,014★）| 人工粘贴「章节序号 标题 页码」 | MIT | Python |
| **oomol-lab/pdf-craft**（6,136★）| `toc_assumed=True` 统计式检测目录页 | MIT | **要 CUDA** |

**`pdfdir` 的两条已知失败模式，正好是我们要处理的两条 `[E25]`：**

> *"一般图书非正文部分（如序言，目录等）没有标页码或使用另一套页码标记，本程序将这些目录默认链接到第一页"*
> *"有些正文中的目录没有标页码，程序会将该条目录链接到上一个有页码的标题页"*

第一条正是 §2.3 层次二的「印刷页号 ↔ 物理页号」问题（而**我们比它多一张牌：`getPageLabels()`**——它是从图片 OCR 出发的，拿不到这个）；第二条说明「目录项没有页码」是常态，降级策略必须内建。

### 7.4 对我们的净结论

1. **没有一个现成实现能进 Electron**（全是 Python / Java / .NET / 要 CUDA / 要联网）。**要么起边车，要么自己写。**
2. **自己写是可行的，因为需要的信号 pdf.js 全都给了**：`getAnnotations()` 的 Link + `dest`（`[M9]` 实测可用）、`getTextContent()` 的 `str` / `transform` / `height` / `fontName` + `styles[].fontFamily`、`getPageLabels()`。**而且我们要做的是一个窄实现（目录页 + 中文编号），不是一个通用文档理解系统。**
3. **中文编号（GB/T 15834）是我们相对所有现成工具的结构性优势**——它们全是拉丁编号正则，我们从第一天就按中文写。

---

## Sources

### 一手源码（`node_modules/pdfjs-dist@6.2.108`，路径相对仓库根）

- `[R1]` `Catalog.documentOutline` / `#readDocumentOutline`：`node_modules/pdfjs-dist/build/pdf.worker.mjs:40439-40536`。`count: Number.isInteger(count) ? count : undefined` 在 **40510**；BFS 队列 40463–40535；`shadow(this, "documentOutline", obj)` 在 40449。
- `[R2]` `Catalog.pageLabels` / `#readPageLabels`：`pdf.worker.mjs:40840-40927`（`new Array(this.numPages)` 在 40857；`D`/`R`/`r`/`A`/`a` 分支 40899–40921；`pageLabels[i] = prefix + currentLabel` 在 40923）。
- `[R3]` `StructTreeNode` / `StructTreeContent` 类型：`node_modules/pdfjs-dist/types/src/display/api.d.ts`，`StructTreeNode = { children, role }`、`StructTreeContent = { type, id }`，`id` 注释原文 *"unique id that will map to the text layer."*
- `[R4]` `PDFNodeStream` 只支持 `file://` 且带 range reader：`pdf.mjs:14067-14176`（`assert(url.protocol === "file:", "PDFNodeStream only supports file:// URLs.")` 在 14073；`PDFNodeStreamRangeReader` 用 `fs.createReadStream(url, {start, end})` 在 14130+）。
- `[R5]` `ChunkedStream` 按全长预分配：`pdf.worker.mjs`，`class ChunkedStream extends Stream { constructor(length, chunkSize, manager) { super(new Uint8Array(length), 0, length, null); … } }`。
- `[R6]` `getOutline()` 的 TS 声明与 `loadingTask.destroy()`：`types/src/display/api.d.ts:964-995`（`OutlineNode` typedef 含 `@property {number | undefined} count`）、`:823-827`（*"Abort all network requests and destroy the worker."*）。
- `[R7]` 我们自己的 `readOutline` / `locate`：`pdfstudio/app/react/outline.ts`（丢掉了 `item.count`；`for … await locate()` 串行）。
- `[R8]` `PDFDocumentProxy` 的方法分派：`pdf.mjs:16703-16756`——`getDestinations` / `getPageLabels` / `getStructTree(pageIndex)` / `getOutline` 均为 `sendWithPromise` 直发，**只有** `hasJSActions` / `getDocJSActions` / `GetOptionalContentConfig` / `GetMetadata` 等走 `#cacheSimpleMethod`。
- `[R9]` `Catalog.getPageIndex`：`pdf.worker.mjs:41424+`（先查 `pageIndexCache`，否则沿 `/Parent` 上爬并累加兄弟 `/Count`）。
- `[R10]` Node 下恒用 fake worker：`pdf.mjs:16015-16020`，`static { if (isNodeJS) { this.#isWorkerDisabled = true; … } }`；`#setupFakeWorker` 在 16144+。
- `[R11]` `LoopbackPort`：`pdf.mjs`，`postMessage` 用 `structuredClone` + `Promise.resolve().then(...)`，同线程投递。
- `[R12]` `PDFPageProxy.cleanup` / `#tryCleanup`：`pdf.mjs:15855-15881`（渲染中返回 `false`；`_renderPageChunk` 在 `lastChunk` 时补做）。
- `[R13]` `WorkerTransport.startCleanup`：`pdf.mjs:16779-16796`（先 `Cleanup` 给 worker，再遍历 `#pageCache` 逐页 `cleanup()`，任一失败即 throw；随后清 `commonObjs` / `fontLoader` / `#methodPromises` / `filterFactory` / `TextLayer.cleanup()`）；`#pageCache = new Map()` 在 16216，`getPage` 写缓存在 16642-16665。
- `[R14]` worker 侧 `Catalog.cleanup`：`pdf.worker.mjs:41201-41223`（`globalImageCache.clear(manuallyTriggered)`，而 `clear(onlyData = false)` 在 `onlyData` 为真时**只清 `_imageCache`**、保留 `_refCache`）；`PDFDocument.cleanup` 在 60258；`clearGlobalCaches` 在 38714。
- `[R15]` `XRef.#cacheMap` 只在 `indexObjects()` 里 clear：`pdf.worker.mjs:58210-58260` 与 `58521`。
- `[R16]` `GlobalImageCache` 常量：`pdf.worker.mjs:31957-31960`，`NUM_PAGES_THRESHOLD = 2`、`MIN_IMAGES_TO_CACHE = 10`、`MAX_BYTE_SIZE = 5e7`。
- `[R17]` `DocumentInitParameters` JSDoc 全文：`types/src/display/api.d.ts:600-700`。
- `[R18]` viewer 的 canvas 上限（**不是** `getDocument` 参数）：`node_modules/pdfjs-dist/web/pdf_viewer.mjs`——`maxCanvasPixels` 默认 `2 ** 25`（:4563），移动端 `compatParams.set("maxCanvasPixels", 5242880)`（:4378），`maxCanvasDim: 32767`（:4413），`capCanvasAreaFactor: 200`（:4455）。
- `[R19]` `getNetworkStream`：`pdf.mjs:14178`。
- `[R20]` `isValidFetchUrl`：`pdf.mjs:1394-1397`，`return /https?:/.test(res?.protocol ?? "")`。
- `[R21]` 同 `[R4]`。
- `[R22]` `isNodeJS` 的定义：`pdf.mjs:29`，含 `!(process.versions.electron && process.type && process.type !== "browser")`。
- `[R23]` 我们的 Electron 配置与本机 HTTP server：`pdfstudio/electron/main.ts`（`createServer` :54、`server.listen(0, "127.0.0.1")` :74、`nodeIntegration: false, contextIsolation: true` :104-105）。
- `[R24]` `validateRangeRequestCapabilities`：`pdf.mjs`——要求 `Content-Length` 为整数、`length > 2 * rangeChunkSize`、`!disableRange`、`isHttp`、`Accept-Ranges === "bytes"`、`Content-Encoding === "identity"`。
- `[R25]` `data.buffer` 进 transfer list：`pdf.mjs:15313`，`sendWithPromise("GetDocRequest", docParams, data ? [data.buffer] : null)`。
- `[R26]` `NetworkPdfManager.ensure` 的 `MissingDataException` 重试：`pdf.worker.mjs:60691-60705`（`await this.requestRange(ex.begin, ex.end); return this.ensure(obj, prop, args);`）。
- `[R27]` `getTextContentParameters.includeMarkedContent` 与 `TextMarkedContent`：`types/src/display/api.d.ts:280`、`:343-356`（`type` ∈ `beginMarkedContent` / `beginMarkedContentProps` / `endMarkedContent`）。
- `[R28]` `hasStructTree` 随 `getMetadata` 返回：`pdf.mjs:16759-16771`；worker 侧 `handler.on("GetMetadata")` → `ensureCatalog("hasStructTree")`（`pdf.worker.mjs:64470+`）。
- `[R29]` `LinkAnnotation` 用同一个 `Catalog.parseDestDictionary`：`pdf.worker.mjs:55390-55410`。
- `[R30]` `GetAnnotationsByType` 遍历全部页：`pdf.worker.mjs:64377+` 的 handler，`for (let i = 0, ii = numPages; i < ii; i++)`，只有 `pageIndexesToSkip` 能跳过。
- `[R31]` 我们的 `getDocument` 调用：`pdfstudio/app/react/pdf-host.ts:19`，`pdfjs.getDocument({ data: bytes })`。
- `[R32]` CMap 取不到时抛错：`pdf.worker.mjs:34251-34272`（`fetchBuiltInCMap`）+ `pdf.mjs:8990-9008`（``throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`)``）；`cMapUrl: null` 的默认值在 `pdf.worker.mjs:34019`。
- `[R33]` `useWorkerFetch` 的默认推导：`pdf.mjs:15245`，要求 `BinaryDataFactory === DOMBinaryDataFactory && cMapUrl && cMapPacked && standardFontDataUrl && wasmUrl` 且三个 URL 都通过 `isValidFetchUrl`。**注意这与 JSDoc 的说法不一致**——`[R17]` 里写的是 *"The default value is `true` in web environments and `false` in Node.js."*，实际代码里浏览器环境下不给这三个 URL 就是 `false`。以代码为准。
- `[R34]` `TextItem` 类型：`types/src/display/api.d.ts:312-341`（`str` / `dir` / `transform` / `width` / `height` / `fontName` / `hasEOL`——**无 weight / bold**）。
- `[R35]` `TextStyle` 类型：`types/src/display/api.d.ts:361-376`（`ascent` / `descent` / `vertical` / `fontFamily`）。
- `[R36]` 我们的 `Section` 与 `isAncestor`：`pdfstudio/src/clip/outline.ts`（`Section` 含 `title/page/y/level/path`；`isAncestor` 按标题路径前缀比较）。
- `[R37]` 我们的 `chunkDocument`：`pdfstudio/src/chat/chunking.ts:43-61`（全页遍历，无 `cleanup`）。
- `[R38]` 索引缓存的形态：`pdfstudio/app/http-index-cache.ts`（单个 JSON、`await response.json()` 一次性载入、向量 base64）。
- `[R39]` sqlite-vec 的规模与延迟：`pdfstudio/docs/research-local-rag-stack.md` §「1 万条向量」表（`float[768]` 30.3 MB / 6.3 ms；**10 万条以上无公开数据**）。
- `[R43]` embedding 的单条耗时：`pdfstudio/docs/research-embedding-shortlist.md` §2.6 本机实测——embeddinggemma-300m ONNX q4、16 条 batch，英文 616 字符段落 **≈22 ms/条**（中文块 token 更多、更慢，该文未测）。
- `[R40]` `Reader.tsx` 的 canvas 尺寸：`pdfstudio/app/react/Reader.tsx:91-95`（`canvas.width = vp.width` 等，无 DPR、无上限）。
- `[R41]` `OutputScale`：`pdf.mjs:1532-1575`（`limitCanvas(width, height, maxPixels, maxDim, capAreaFactor)`；`static get pixelRatio() { return globalThis.devicePixelRatio || 1; }`；`capPixels` 用 `window.screen.availWidth * availHeight * pixelRatio ** 2 * (1 + capAreaFactor / 100)`）。
- `[R42]` `stringToPDFString` 的 BOM 处理：`pdf.worker.mjs`——只识别 `\xFE\xFF`(utf-16be) / `\xFF\xFE`(utf-16le) / `\xEF\xBB\xBF`(utf-8)，否则逐字节查 `PDFStringTranslateTable`（PDFDocEncoding）。

### 本机实测

- `[M1]` **合成样本生成器**：3000 页 × 40 行、单一 base14 字体、无图、不压缩、传统 xref；1212 项 outline（12 章 × 10 节 × 9 小节，第 1 章 `/Count +10`、其余 `-10`）；`/PageLabels` 前 24 页 `/S /r`、之后 `/S /D /St 1`。同时产出「平衡页面树 fanout=25」与「扁平 Kids」两版，各 11.5 MB。脚本与样本保留在本次会话 scratchpad。
- `[M2]` **outline / pageLabels / dest 解析实测**（macOS arm64 / Node v24.18.0 / `pdfjs-dist` 6.2.108 legacy build / 2026-08-17）：见 §1.2、§1.3、§1.4 各表。**注意 Node 下 pdf.js 恒用 fake worker `[R10]`，所有跨线程数字被低估。**
- `[M3]` **三篇真实论文的探针**（`pdfstudio/eval/papers/`）：ResNet `outline: null`；Attention 22 项 / 4 层 / *Model Architecture* `count: -5`；DDPM 18 项 / 3 层 / *3 Diffusion models…* `count: 4`；三篇 `hasStructTree` 全 `false`、`MarkInfo` 全 `null`、`getStructTree(0)` 无 role、`pageLabels` 全 `null`；Producer 分别为 `pdfTeX-1.40.12` / `1.40.25` / `1.40.21`。
- `[M4]` **range 加载实测**：本机 `node:http` server，`Accept-Ranges: bytes` + 206；full GET 按 64 KB 分块写并尊重背压，监听 `close` 以捕捉 pdf.js 的 abort（**这一步是关键——一次性 `res.end(buf)` 会把整份文件塞进 socket 缓冲，测不出 abort**）。三组配置的字节数、请求数与 gc 后 RSS 见 §1.6 表。
- `[M5]` **CJK CMap 实测**：手写一页 `/Type0` + `/Encoding /UniGB-UCS2-H` + 不嵌入 `STSong-Light`（CIDSystemInfo `Adobe-GB1-2`），正文 `<第三章 进程与线程>` 以 UCS-2 十六进制写入。不带 `cMapUrl` → `getTextContent` 得 `""` 且 console 出 `loadFont - translateFont failed: "UnknownErrorException: Ensure that the \`cMapUrl\` API parameter is provided."`；带 `cMapUrl` 指向 `node_modules/pdfjs-dist/cmaps/`（`cMapPacked: true`）→ 得 `"第三章 进程与线程"`。
- `[M6]` **3000 页全量 `getTextContent` 实测**：3.2 s、120,000 个 text item、10,008,720 字符；三种清理策略的 gc 后峰值 RSS 与结束时 heapUsed 见 §4.2 表。
- `[M7]` **静态资源体积实测**（`du -sh`）：`cmaps/` 1.6 MB（169 个 `.bcmap`）、`standard_fonts/` 800 KB、`wasm/` 1.5 MB（jbig2 / openjpeg / qcms / quickjs-eval）、`iccs/` 20 KB。
- `[M8]` **渲染残留实测**：用 `page.getOperatorList()`（`render()` 内部填 `_intentStates` 的同一步）隔离 pdf.js 自身保留量，避开 `@napi-rs/canvas` 的原生分配噪声；每次测量前连调两次 `global.gc()`。数字见 §4.1 表。**直接用 `render()` + `createCanvas` 的那组（200 页 → RSS 909 MB）因原生分配器不还内存而无法归因，已作废、不列入本文。**

- `[M9]` **Link annotation 实测**（`1706.03762.pdf`）：p.1 无 annotation；**p.2 有 30 个、全部 `subtype === "Link"`**，`dest` 为命名 dest 字符串（`"cite.hochreiter1997"` / `"cite.gruEval14"` / `"figure.1"` …），带 `rect`；经 `doc.getDestination(dest)` → `doc.getPageIndex(d[0])` 全部解出物理页索引（10 / 10 / 11 / 2 …）。证明 §2.3 层次一的机制在真实文件上成立。

- `[M10]` **ResNet 缺失 outline 的成因，字节级实测**：`1512.03385.pdf` 顶层 `/Info` = `Producer: pdfTeX-1.40.12` / `Creator: LaTeX with hyperref package`；但原始字节里另有 **7 处** `Acrobat Distiller 11.0 \(Windows\)`，各自属于一个孤立的 `/Info` 字典——6 个是 Visio 图（`/Title (Visio-teaser.vsd)`、`(Visio-arch6.vsd)`、`(Visio-curves.vsd)`、`(Visio-block_deeper.vsd)`、`(Visio-cifar1000_all2.vsd)`、`(Visio-std2.vsd)`，`Creator: PScript5.dll Version 5.2.2`），**第 7 个是正文**：`/Title (residual_v1_cvpr_edit1b.pdf)` / `/Creator (LaTeX with hyperref package)` / `/Producer (Acrobat Distiller 11.0 (Windows))`。`1706.03762.pdf` 里 `Distiller` 出现 **0 次**。（`getMetadata().metadata` 三篇均为 `null`，无 XMP。）

### 外部一手来源（虚拟化与树）

- `[E1]` TanStack Virtual v3 官方文档与仓库（`@tanstack/react-virtual` **3.14.9**，MIT，peer `react ^16.8 || ^17 || ^18 || ^19`）：*"TanStack Virtual is a headless UI utility for virtualizing long lists of elements… **It is not a component therefore does not ship with or render any markup or styles for you.**"*；`estimateSize` / `measureElement` / `useCachedMeasurements` / `initialMeasurementsCache` 的定义；**React 示例目录枚举后确认没有 tree 示例**（`chat, dynamic, fixed, infinite-scroll, padding, pretext, scroll-padding, smooth-scroll, sticky, table, variable, window`）：`https://tanstack.com/virtual/latest/docs/api/virtualizer`、`https://github.com/TanStack/virtual/blob/main/examples/react/dynamic/src/main.tsx`
- `[E2]` react-window **2.3.0**（MIT，零运行时依赖，peer `react ^18 || ^19`）CHANGELOG 的 2.0.0 条目原文含 *"Automatically sizing for List and Grid (**no more need for AutoSizer**)"*；动态高度文档原文 *"react-window provides a helper hook called `useDynamicRowHeight`"* 与告警 *"Dynamic row heights are not as efficient as predetermined sizes."*；实现是一个 `Map<number, number>` + 共享 `ResizeObserver`，`key` 选项会重置整张测量表：`https://github.com/bvaughn/react-window/blob/main/CHANGELOG.md`、`https://github.com/bvaughn/react-window/blob/main/lib/components/list/useDynamicRowHeight.ts`
- `[E3]` Chrome Lighthouse `dom-size` 审计原文：warns *"when the body element has more than ~800 nodes"*、errors *"when the body element has more than ~1,400 nodes"*：`https://developer.chrome.com/docs/lighthouse/performance/dom-size`。**这是本节唯一一条有硬数字的一手阈值**——React 官方文档与各虚拟化库的文档里都**没有**任何「多少行该虚拟化」的数字。
- `[E4]` react-arborist **3.16.0**（MIT，仓库 `jameskerr/react-arborist`）的 `flattenTree`（先序遍历，`if (node.isOpen) node.children?.forEach(collect)`）与 `OpenMap = { [id: string]: boolean }` / `OpenSlice = { unfiltered: OpenMap; filtered: OpenMap }`；npm 依赖里是 `react-window ^1.8.11`：`https://github.com/jameskerr/react-arborist/blob/main/modules/react-arborist/src/data/create-list.ts`、`.../src/state/open-slice.ts`
- `[E5]` headless-tree（`@headless-tree/core` 1.7.0，MIT，零依赖）的虚拟化 recipe 原文：*"you can easily pass a flat list to any virtualization library of your choice… **by flattening the tree structure and providing the tree items as flat list**"*、*"render **100k items** while still being performant"*；`ItemMeta = { itemId, parentId, level, index, setSize, posInSet }` 与 `state: { expandedItems: string[] }`：`https://headless-tree.lukasbach.com/recipe/virtualization/`、`https://github.com/lukasbach/headless-tree/blob/main/packages/core/src/features/tree/types.ts`
- `[E8]` **文献缺口（经另一 session 转述，本文未独立核对原始来源）**：① 没有任何公开来源把「书」与「论文」的 `/Outlines` 普及率分开测过；② 大规模 PDF 语料上的 `/Outlines` 普及率统计在 SafeDocs / veraPDF / PDF Association / Digital Corpora / GovDocs1 / Common Crawl 相关工作与厂商发布中**均未找到**；③ 仅有的三个实测均为学术论文的无障碍审计——Nganji 2015（n=200，2009–2013）**50%**、Nganji 2018（n=200，2014–2018）**74.5%**、Hovious & Wang 2024（N=120）**73.3%**。**「未找到」是本条最重要的内容**：这个假设目前既不能证实也不能证伪。
- `[E9]` **另一 session 自行跑的一次抽样，非已发表来源**：SafeDocs 的 Common Crawl 语料中随机 **400** 个网络 PDF——`/Outlines` 存在 **14.6%**、非空 **10.6%**、`/StructTreeRoot` **34.4%**；该语料 8,410,703 行 `pdfinfo` 元数据中 `Tagged=yes` 占 **34.0%**。**测的是开放网络上的 PDF，与「中文技术书」不同分布，不可外推。** 本文只用它说明「带书签的是少数」这一个方向性事实。
- `[E6]` 仓库现状（实测读取）：`package.json` 里 `react` / `react-dom` **19.2.6**，**没有** `pdfstudio/package.json`（共用根 `package.json`），**无任何虚拟化或树依赖**。
- `[E7]` react-virtuoso `GroupedVirtuoso` 的 API 是 `groupCounts: number[]`（单层分组）：`https://virtuoso.dev/react-virtuoso/api-reference/grouped-virtuoso/`

### 外部一手来源（目录重建：文献与实现）

> `[E8]`–`[E25]` 中，除标注「本文自行核对」者外，均由并行调研取回并转述；我逐条核对了**能在本机验证**的部分（`[M10]` 就是对 `[E10]` 那条推论的独立复核，结果**修正**了它的细节——见 §2.1）。

- `[E10]` hyperref 手册：`bookmarks` 选项**默认 true**，原文 *"A set of Acrobat bookmarks are written, in a manner similar to the table of contents"*：`http://ftp.math.utah.edu/pub/texlive/Contents/live/texmf-dist/source/latex/hyperref/doc/manual.tex`
- `[E11]` **Doucet, Kazai, Colutto, Mühlberger,《Overview of the ICDAR 2013 Competition on Book Structure Extraction》**（**本文自行下载并用 pdf.js 抽取全文核对**）：`https://www.cs.helsinki.fi/u/doucet/papers/ICDAR2013.pdf`。
  语料原文 *"a collection of 50,239 digitized out-of-copyright books, provided by Microsoft and the Internet Archive"*；
  **80/20 那条原文**：*"we selected 200 books into the total 1,000 that do not contain a printed ToC… **this ratio of 80:20% of books with and without printed ToCs is proportional to that observed over the whole INEX corpus of 50,239 books**"*；
  评测定义 *"A ToC entry is considered a full match (or complete entry) when both the depth and page number information are correct"*；
  **Table II**（MDCS 分项）Titles 59.59% / Levels 47.36% / Links 54.54% / Complete entries 43.61%；
  **Table III**（title-based，complete entries）MDCS 43.61 / Nankai 35.41 / Innsbruck 31.34 / Würzburg 19.61 / Epita 14.96 / GREYC-run-d 8.81 / -c 7.91 / -a 6.21 / -e 4.71 / -b 3.79；
  **Table IV**（XRCE link-based F）Innsbruck 67.2 / MDCS 66.6 / Nankai 62.4；
  方法学原文 *"most of the participants focused on detecting ToC pages and exploiting their content. They made no use of the rest of the contents of the books, except for the purpose of page linking"*；
  GREYC 原文 *"works on full documents, with no particular focus on ToC pages (with no attempt to detect them)… detect chapter beginnings with a 4-page window"*；
  Nankai 原文 *"If a ToC is identified, the ToC area is exploited and the headlines found in the book are ignored… justified by empirical evidence that the method exploiting the analysis of ToC areas performs best"*；
  Epita 的页码偏移原文 *"using the difference between the effective page number of a page in the middle of the book and its page number in the book. This difference is applied throughout the book"*；
  剔除中文书原文 *"two books were removed… one book in Chinese (named beikokunouraomo00miyarich…)"*。
- `[E12]` Tagged PDF 在学术论文上的普及率：SciA11y（arXiv 2105.00076）**13.4% / n=11,397**；Kumar & Wang（ASSETS '24，arXiv 2410.03022）**12.6% / n=19,997**，原文 *"74.9% fail to meet any criteria at all"*。**两者都不把书签算作评测项**。
- `[E13]` ICDAR 2011 Book Structure Extraction 竞赛综述（Doucet/Kazai/Meunier），原文 *"As in the past, the best performing methods are those that focus specifically on ToC pages"*；2011 年最好成绩 MDCS **F 40.75%**（complete entries）：`https://www.cs.helsinki.fi/u/doucet/papers/ICDAR2011.pdf`
- `[E14]` Wu, Mitra & Giles,《Table of Contents Recognition and Extraction for Heterogeneous Book Documents》，ICDAR 2013：目录页搜索范围 `K = min(20, N/5)`；**Table I**（1,040 本 INEX 扫描书）Titles 77.5 / Links 63.1 / Levels 59.9 / **Complete 41.8%**（对照基线 27.7%）；**Table II**（200 本 born-digital CiteSeerX 书）Titles **83.1** / Links **73.1** / Levels **71.0** / **Complete 56.9%**：`https://clgiles.ist.psu.edu/pubs/ICDAR2013-ToC.pdf`
- `[E15]` PyMuPDF 官方文档 `Document.get_toc()`：*"Creates a table of contents (TOC) out of the document's outline chain."*（**只读现成 outline，不重建**）：`https://pymupdf.readthedocs.io/en/latest/document.html`
- `[E16]` pdfplumber 仓库：无 outline / bookmark / toc / heading 相关实现，只暴露带 `fontname` + `size` 的 `chars`：`https://github.com/jsvine/pdfplumber`
- `[E17]` GROBID 官方 FAQ：*"GROBID is designed for scholarly articles"*、*"the models are primarily trained on English-language articles, with some German and French"*、*"Quality for other languages is unpredictable"*、*"For books, you can use the `start` and `end` page parameters to process individual chapters"*；端到端评测页自述全文结构 *"is not reliable in the current state"*：`https://grobid.readthedocs.io/en/latest/Frequently-asked-questions/`
- `[E18]` docling `heading_hierarchy_model.py`（2026-06 起，**默认关闭**：*"When disabled (default), all detected headings remain at level 1."*）；优先级为 bookmarks（*"the most authoritative signal: the outline is the document's own declared hierarchy"*）→ 编号 → 字体样式；**编号正则全为拉丁文**、全文件无 CJK 码位：`https://github.com/docling-project/docling/blob/main/docling/models/stages/heading_hierarchy/heading_hierarchy_model.py`
- `[E19]` pdf.js issue #17921「从字体特征推断标题层级」——2024-04 开至今**未实现**：`https://github.com/mozilla/pdf.js/issues/17921`
- `[E20]` GROBID 维护者 kermitt2 在 issue #1074 的回复（章节层级为何被移除、以及 PDF outline 坐标的可靠性）：`https://github.com/kermitt2/grobid/issues/1074`
- `[E21]` HRDoc（AAAI 2023，arXiv 2303.13839，2,500 篇 ACL/arXiv **英文论文**）、Detect-Order-Construct（arXiv 2401.11874，Comp-HRDoc 上 Micro-STEDS 0.8605）、Multimodal Tree Decoder / HierDoc（arXiv 2212.02896，650 篇论文，TEDS 87.2%）——**全部面向英文论文，无一面向图书或中文**。
- `[E22]` OmniDocBench（arXiv 2412.07626）：中英平衡、含 `book` 子类，但评的是文本 / 表格 / 公式 / 阅读顺序，**不含目录层级**。
- `[E23]` Cao 等,《Extracting Variable-Depth Logical Document Hierarchy from Long Documents》，JCST 37(3) / arXiv 2105.09297：中文集 = 1,030 份 CNINFO 招股书与年报，2step-HELD **0.9731**（英文 HKEX 0.7301 / arXiv 论文 0.9578）；原文 *"we conclude 44 types of patterns to represent the item number in headings"*，英文集上 *"most headings do not match any regex"*；42.58 s/篇、2×Titan 1080Ti。
- `[E24]` **GB/T 15834-2011《标点符号用法》** 规定的层次序号：`一、` → `（一）` → `1.` → `（1）`，再往下 `①` / 小写拉丁字母。
- `[E25]` 中文社区的目录工具（**全部基于目录页解析**）：`https://github.com/chroming/pdfdir`（GPL-3.0，811★，PaddleOCR 优先 + 自动推算页差；README 明列两条失败模式）、`https://github.com/wmjordan/PDFPatcher`（12,618★，Windows/.NET，无 LICENSE 文件）、`https://github.com/NatsUIJM/autoContents`（Qwen API，**专有非商业**）、`https://github.com/ifnoelse/pdf-bookmark`（MIT，1,014★）、`https://github.com/oomol-lab/pdf-craft`（MIT，6,136★，`toc_assumed=True`，**需 CUDA**）。

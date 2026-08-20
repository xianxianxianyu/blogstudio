# 网页上的摘录锚点：没有页码矩形可用之后

- **问题来自一个新场景**：PDF Studio 现在的摘录锚点是「页码 + 矩形」，在 PDF 上**永远有效**——PDF 的页面几何是文件的一部分，不随窗口、不随时间变。现在要在同一个应用里开任意网站、同样拖框产生摘录，而**网页没有这样的坐标**：站点改版、窗口一变宽、图片懒加载，矩形就指向别处了。这份调研要回答的是：那把锚点换成什么。
- **方法：一手来源。** W3C 的结论全部来自规范原文（`annotation-model` / `annotation-vocab` / `media-frags` / `selectors-states` 的 W3C Recommendation 与 WG Note），带 URL 与 anchor。Hypothesis 的结论全部来自**本机 clone 的完整 git 历史**（`hypothesis/client`，`HEAD = b4d085a2`，2026-07-30，15,652 个提交），标到文件与行号。**它的博客只在一处被引用——为了证明那篇《Fuzzy Anchoring》里一个评测数字都没有**（§2.6）；其余一律以源码为准，不引二手总结。Electron 的结论全部来自官方文档（`v43.4.1` tag 下的 `docs/`，与线上 `electronjs.org/docs/latest` 逐字比对过），个别文档没写的地方标注为**源码级结论**并给出 Chromium/Electron 的源码位置。
- **凡是数字，标清来源。** 「有出处的数字」标出处；「我自己推的」写推测；**「没人量过」就写没人量过**——这一条在本文里出现的次数比我预期的多得多，见 §5。
- **本仓库现状**（实测读取）：`electron` **43.4.0**（`node_modules` 里装的版本）；`BrowserWindow` 的 `webPreferences` 只设了 `nodeIntegration: false, contextIsolation: true`，**没有 preload、没有 `webviewTag`**（默认 `false`）`[P1]`。摘录的领域模型是 `Region { page, rect, pixels, lines? }` 与 `Anchor { page, rect }`，`Rect` 是**页面坐标、原点左下** `[P2]`。
- **检索时间：** 2026-08-20。引用键 `[W…]`（W3C 规范）/ `[H…]`（Hypothesis 源码）/ `[E…]`（其他外部一手来源）/ `[P…]`（本仓库现状）见 [Sources](#sources)。

---

## 0. 结论先行

**一句话：网页上没有「永远有效」的锚点，这件事不能靠选更好的选择器解决——只能靠换一种失败模型。PDF 那套「锚点要么对要么是 bug」的假设必须整个丢掉，换成「锚点是一次带证据的检索，可能失败，失败是一等状态」。而对**不含文字的框**，业界（包括 Hypothesis 自己）在普通网页上**根本没有解**——那一块应该老实地存成截图，而不是假装它有锚点。**

| 问题 | 结论 | 强度 |
| --- | --- | --- |
| W3C 规范有没有给选择器的健壮性排序 | ❌ **没有**。全文 `grep -i 'robust\|brittle\|fragil\|stable'` 只有 2 处实质命中，唯一的定性评价是说 `TextPositionSelector` *"very brittle"* | 规范原文 `[W1]` |
| 规范怎么说「多选择器并用」 | 只有 `MAY be 0 or more` + **`Consuming user agents MUST pick one of the described segments, if they are different.`** —— 要求挑一个，**但没说按什么规则挑**。全文**没有一个 `"selector": [...]` 数组的示例** | 规范原文 `[W2]` |
| 规范推荐的组合 | 只有三条，且**都不是**业界常用的那条：TextPosition **+ State**、FragmentSelector 优于裸 IRI fragment、RangeSelector 两端同类。**「TextQuote + TextPosition 双写」不是 W3C 的建议**，是实现惯例 | 规范原文 `[W3]` |
| Hypothesis 实际用哪几种 | **三种全存**：`RangeSelector`（简化 XPath）/ `TextPositionSelector` / `TextQuoteSelector`。fallback 顺序 **Range → Position → Quote** | 源码 `[H1]` |
| 它的 `RangeSelector` 是 W3C 的那个吗 | ❌ **不是**。W3C 的字段是 `startSelector`/`endSelector`（嵌套 Selector 对象），Hypothesis 的是 `startContainer`/`endContainer`（**字符串 XPath**）。**同名不同物** | 源码 + 规范 `[H2][W4]` |
| 前两种选择器在它那里算不算锚点 | ❌ **算加速器**。Range/Position 的结果必须逐字等于存下的 `exact`，不等就当失败继续退（`maybeAssertQuote`）。**真正的锚点只有引文** | 源码 `[H1]` |
| 模糊匹配是不是 `diff-match-patch` 的 `match_main` | ❌ **2020-12-10 起不是了**。换成了 `approx-string-match`（Myers 1999 bit-parallel）。仓库里 `diff-match-patch` 现在出现 **0 次** | 源码 + 提交历史 `[H6][H7]` |
| 今天的容差参数 | **`maxErrors = Math.min(256, quote.length / 2)`** —— 引文长度的一半。**没有分数阈值**：只要有候选就采纳，宁可锚错不愿锚不上 | 源码 `[H8]` |
| 历史上 dmp 的参数（问题里问的那个） | `Match_Distance = textContent.length * 2`（首锚），随后 `Match_Distance = 64`（后续 32 字符切片）；`Match_Threshold` **从未显式设置**，用 dmp 默认 | 源码 `[H6]` |
| 同一段文字出现多次怎么办 | 打分：引文 **50** / prefix **20** / suffix **20** / 位置 **2**。位置项来自 `TextPositionSelector.start`，**除以全文长度**归一化——**页面越长越没用** | 源码 `[H8]` |
| Hypothesis 的 orphan 率有没有公开数据 | ❌ **官方从未公布过任何比率**。博客《Fuzzy Anchoring》零评测数字；`product-backlog#954` 承诺过收集数据、**数据从未出现**且 issue 已 CLOSED | `[E9][E5]` |
| 那有没有别人量过 | ✅ 有一份：2015 年全站 20,133 条标注中 **22%** 的引文已不再逐字出现在页面上（**逐字子串搜索，不是模糊锚定**，是「页面变了」的上界）；拆开是**约 10% 链接腐烂 + 约 12% 内容变更** | `[E6]` + 我的算术 |
| 模糊匹配能从那 22% 里救回多少 | ❌ **没人量过。这是本文最想要而没拿到的数** | §5.5 |
| 不含文字的框，Hypothesis 怎么锚 | ❌ **普通网页上它不做**。`HTMLIntegration.supportedTools()` 返回 **`['selection']`**；`describe()` 遇到非 `Range` 直接 `throw new Error('Unsupported region type')`。`ShapeSelector` **只在 PDF 里**（且要 feature flag） | 源码 `[H11][H12]` |
| 图像区域规范上能用什么 | 位图只有 **FragmentSelector（`xywh=`）** 与 **SvgSelector** 两条，且规范矩阵把它们标成 MUST 实现；CSS/XPath/TextQuote/TextPosition 全是 ✘ | 规范原文 `[W5]` |
| 「截图 + 感知哈希」有人在用吗 | ❌ **没有**。唯一系统描述它的是一份 **Abandoned 的微软专利**；且有实测表明它原理上就不成立——**缩放能扛（pHash 94% 精确匹配），裁剪与加边框直接崩到噪声底（PDQ 0.000%）**，而「改版」恰好就是后者 | `[E30][E32][E33]` |
| 选择器抗改版有没有实测 | ✅ **有，但来自 Web 测试不是标注**：相邻两个 release 间，**`id` 失效 < 2%、链接文本 12%、Name·CSS ~20%、相对 XPath 50%、绝对 XPath 78%**。**是下界，且迁移到标注是我的类比** | `[E34]` |
| `xywh=` 的精度上限 | ABNF 是 **`1*DIGIT`——只能非负整数**。`percent:` 只能整数百分比，要亚百分点精度只能用 `pixel:` 并另存原图尺寸 | 规范原文 `[W6]` |
| Electron 该用 `<webview>` 还是 `WebContentsView` | **`WebContentsView`**。`<webview>` 官方明文 *"We currently recommend to not use the `webview` tag"*；`BrowserView` 自 **Electron 30** 起废弃 | 官方文档 `[E10][E11]` |
| 注入脚本该走哪条路 | **preload（隔离世界）**。`webContents.executeJavaScript` 跑在**主世界**（源码确认 `ISOLATED_WORLD_ID_GLOBAL`），第三方页面能 hook 你的一切 | 文档 + 源码 `[E12]` |
| `capturePage` 的坐标单位 | **`rect` 是 DIP，返回位图是物理像素**（按 `device_scale_factor` 放大）。Retina 上 `getSize()` ≠ `toBitmap()` 的实际宽高。**官方文档没写这一条** | **源码级** `[E13]` |
| 跨源 iframe 能不能读 | 页面内脚本**不能**；**主进程能**——官方示例就是从主进程枚举 reddit 页面里的 youtube 子框架并 `executeJavaScript` | 官方文档 `[E14]` |

**结论与方案见 §5：§5.2 是选择器组合，§5.5 单列「已知的数」与「没人量过的数」，§5.7 是四档方案。**

---

## 1. W3C Web Annotation 的选择器模型

> 全部来自 W3C Recommendation 原文（2017-02-23）与 Media Fragments URI 1.0（2012-09-25）。引用键 `[W…]`。

### 1.1 八种选择器的确切字段

先给一条贯穿全部的上位约定——`selector` 属性本身的定义 `[W2]`：

> *"There MAY be 0 or more selector relationships associated with a Specific Resource. Multiple Selectors SHOULD select the same content, however some Selectors will not have the same precision as others. **Consuming user agents MUST pick one of the described segments, if they are different.**"*

JSON key 的权威出处是 JSON-LD context 文件本身（`http://www.w3.org/ns/anno.jsonld`）`[W7]`，与 selector 相关的映射全集：

```
"selector":      {"@type": "@id", "@id": "oa:hasSelector"},
"refinedBy":     {"@type": "@id", "@id": "oa:refinedBy"},
"startSelector": {"@type": "@id", "@id": "oa:hasStartSelector"},
"endSelector":   {"@type": "@id", "@id": "oa:hasEndSelector"},
"conformsTo":    {"@type": "@id", "@id": "dcterms:conformsTo"},
"value":         "rdf:value",
"exact": "oa:exact",  "prefix": "oa:prefix",  "suffix": "oa:suffix",
"start":         {"@id": "oa:start", "@type": "xsd:nonNegativeInteger"},
"end":           {"@id": "oa:end",   "@type": "xsd:nonNegativeInteger"},
```

逐个列出来（M = MUST，S = SHOULD，A = MAY）：

| Selector | 字段 | 规范原文（节选） |
| --- | --- | --- |
| **FragmentSelector** `[W8]` | `value` **M**、`conformsTo` **S** | *"A resource which describes the Segment through the use of the fragment component of an IRI."*；`conformsTo` — *"SHOULD have exactly 1 conformsTo link to the specification that defines the syntax of the fragment"* |
| **CssSelector** `[W9]` | `value` **M** | *"A CssSelector describes a Segment of interest in a representation that conforms to the Document Object Model through the use of the CSS selector specification."* 例：`"#elemid > .elemclass + p"` |
| **XPathSelector** `[W10]` | `value` **M** | *"An XPathSelector is used to select elements and content within a resource that supports the Document Object Model via a specified XPath value."* 例：`"/html/body/p[2]/table/tr[2]/td[3]/span"` |
| **TextQuoteSelector** `[W11]` | `exact` **M**、`prefix` **S**、`suffix` **S** | *"This Selector describes a range of text by copying it, and including some of the text immediately before (a prefix) and after (a suffix) it to distinguish between multiple copies of the same sequence of characters."* |
| **TextPositionSelector** `[W1]` | `start` **M**、`end` **M**（`xsd:nonNegativeInteger`） | *"…recording the start and end positions of the selection in the stream."*；左闭右开 |
| **DataPositionSelector** `[W12]` | `start` **M**、`end` **M** | *"…works at the byte in bitstream level rather than the character in text level."* |
| **SvgSelector** `[W13]` | `value` **A**（！） | *"An SvgSelector defines an area through the use of the Scalable Vector Graphics [SVG11] standard."*；`type` 那条写的是 **`MUST include SvgSelector`**（唯一允许多值 type 的），`value` 是 **MAY**（SVG 可外链） |
| **RangeSelector** `[W4]` | `startSelector` **M**、`endSelector` **M** | *"…identify the beginning and the end of the selection by using **other Selectors**."*；*"Both startSelector and endSelector SHOULD be of the same class."*；左闭右开 |

**`RangeSelector` 这一条要单独盯一眼：它的两个字段是嵌套的 Selector 对象，不是字符串。** §2.1 会说明 Hypothesis 用了同一个名字装了完全不同的东西。

`TextQuoteSelector` 还带三条与匹配语义直接相关的规范性要求 `[W11]`：

> *"The selection of the text MUST be in terms of unicode code points (the "character number"), not in terms of code units… Selections SHOULD NOT start or end in the middle of a grapheme cluster. The selection MUST be based on the logical order of the text, rather than the visual order, especially for bidirectional text."*

> *"The text MUST be normalized before recording in the Annotation. Thus HTML/XML tags SHOULD be removed, and character entities SHOULD be replaced with the character that they encode."*

> *"**If, after processing the prefix, exact, and suffix, the user agent discovers multiple matching text sequences, then the selection SHOULD be treated as matching all of the matches.**"*

**最后这条对中文有实际后果**：unicode code point 而非 UTF-16 code unit，意味着 emoji 与增补平面汉字（扩展 B 区以上的生僻字）算 **1** 而不是 2。JS 的 `String.length` 是 code unit，直接拿去当 `start`/`end` **就是不合规**——而 Hypothesis 的类型注释里写的正是 *"UTF-16 character offsets"* `[H2]`。两边都能自洽，但**跨实现交换数据时这是个真实的错位**。

### 1.2 「多个选择器并用」：规范说得比想象中少

有两种截然不同的机制，共用不同的属性，常被混为一谈。

**（a）`refinedBy` —— 串联，逐级缩小范围。** `[W14]`

> *"refinedBy — The relationship between a broader selector and the more specific selector that SHOULD be applied to the results of the first. A Selector MAY be refinedBy 1 or more other Selectors. **If more than 1 is given, then they are considered to be alternatives that will result in the same selection.**"*

规范自己的例子（Example 29）是 `FragmentSelector` 里再 `refinedBy` 一个 `TextQuoteSelector`：

```json
"selector": {
  "type": "FragmentSelector",
  "value": "para5",
  "refinedBy": {
    "type": "TextQuoteSelector",
    "exact": "Selected Text",
    "prefix": "text before the ",
    "suffix": " and text after it"
  }
}
```

**注意 `refinedBy` 一个属性承担了两种语义：嵌套（串联，细化）与同层多值（并联，等价备选）。**

**（b）`selector` 数组 —— 并联，同一片段的多种描述。** `[W2]`

规范性的只有上面引过的那句 `MUST pick one`。非规范性的导言里另有一句：

> *"Multiple Selectors can be given to describe the same Segment in different ways **in order to maximize the chances that it will be discoverable later**, and that the consuming user agent will be able to use at least one of the Selectors."*

**三件必须如实说明的事：**

1. 规范**没有**写「客户端用它能处理的那个」。最接近的就是上面那句，而且它不含 RFC 2119 关键词，是描述意图不是要求。
2. 唯一带 MUST 的行为要求是「多个选择器解析结果**不一致时必须挑一个**」（不能取并集），**但规范完全没说按什么规则挑**。这是实现方必须自己定策略的地方——也正是本文 §5.2 要回答的。
3. **规范全文没有任何一个 `"selector": [...]` 数组形式的 JSON 示例**（对 Data Model 与 Selectors and States 全文 grep `'"selector": \['`，零命中）`[W2]`。数组的合法性来自 `MAY be 0 or more` 加 JSON-LD 的 `"@type": "@id"`，不来自一个可以照抄的样例。

### 1.3 规范推荐的组合：只有三条，且都不是那条

穷举全文，够得上「推荐组合」的只有 `[W3]`：

1. **TextPositionSelector + State**（`[W1]`）：*"…it is RECOMMENDED that a State be additionally used to help identify the correct representation."*
2. **FragmentSelector 优先于裸 IRI fragment**（`[W8]`）：*"It is RECOMMENDED to use FragmentSelector as a consistent method compatible with other means of describing SpecificResources, rather than using the IRI with a fragment directly."*
3. **RangeSelector 两端同类**（`[W4]`）：*"Both startSelector and endSelector SHOULD be of the same class."*

> **业界人人在做的「TextQuoteSelector + TextPositionSelector 双写」，不是 W3C 的推荐。** 它是 Hypothesis 等实现的惯例。Example 29 里的 `FragmentSelector` + `refinedBy: TextQuoteSelector` 是一个 Example，而规范 1.3 节明说 *"all authoring guidelines, diagrams, examples, and notes in this specification are non-normative"*——**Example 不构成推荐。**

第 1 条那个 `State` 值得多看一眼，因为它是规范对「网页会变」这件事**唯一**的正面回应。4.3 节导言 `[W15]`：

> *"Web resources change over time, and a State might be used to describe how to recover the intended previous version."*

也就是说：**规范给「文档变了怎么办」开的药方是「记下当时是哪一版，然后去把那一版取回来」（`TimeState` 指向 Memento / Web Archive），而不是「让选择器更聪明」。** 这条路对一个 local-first 的桌面应用其实是通的——见 §5.7 档 2。

### 1.4 健壮性排序：**W3C 从来没有发布过**

这是本节最需要如实交代的结论。

对 Data Model 全文做大小写不敏感的 `grep -iE 'robust|brittle|fragil|stable|unstable|resilien|survive'`，**全文仅 3 处命中**，其中 1 处是 W3C Recommendation 的样板文字（*"It is a stable document…"*）。剩下两处 `[W1]`：

**（1）TextPositionSelector 的 Note：**

> *"The use of this Selector does not require text to be copied from the Source document into the Annotation graph, unlike the Text Quote Selector, but is **very brittle** with regards to changes to the resource. Any edits or dynamically transcluded content may change the selection, and thus it is RECOMMENDED that a State be additionally used to help identify the correct representation."*

**（2）RangeSelector 节首：** *"…making it difficult to construct a single selector that **robustly** describes the correct content."*

对 **Selectors and States**（W3C Working Group Note，2017-02-23，`[W16]`）做同样的 grep，命中**完全相同的这两句**——因为该 Note 是逐句抽取自 Recommendation，没有新增任何鲁棒性论述。它自己就这么写：

> *"This document does not define any new approach to selection… The current document only "extracts" Selectors and States from that data model."*

**Web Annotation Protocol 全文 `grep -ci selector` = 0** `[W17]`——别去那里找。

所以：

> **不存在 W3C 的选择器健壮性排序。**规范里唯一一处对某个选择器抗变更能力的定性评价，就是把 `TextPositionSelector` 称为 `very brittle` 并建议配 State。`TextQuoteSelector` 更稳这一点，规范只是把它当作 TextPosition 的对照物顺带提及（*"unlike the Text Quote Selector"*），**并未断言谁比谁更鲁棒**。CssSelector、XPathSelector、FragmentSelector、SvgSelector、RangeSelector、DataPositionSelector 的抗变更能力，规范一个字都没评价。

**那有没有权威的「实现指南」补上这一课？** 找过了，结论同样是否定的，而且证据挺硬：

- **Apache Annotator ——「W3C 选择器的参考实现」那个位置上唯一的 ASF 项目 —— 已于 2025-08-11 从 Apache 孵化器退休** `[E1]`。它 2016-08-30 进孵化器，**熬了近九年没有毕业**。它的定位原文是 *"provides libraries to enable annotation related software, with an initial focus on identification of textual fragments in browser environments"* `[E2]`，README 里**没有**任何关于选择器组合或 fallback 顺序的指南。
- 规范里那三条 *"commonly supported features"* 的 Note（CSS / XPath / SVG）讲的是 **interoperability between systems**（跨实现互操作），**不是**抗页面变更 `[W9][W10][W13]`。
- XPathSelector 那条 HTML5 parser 的 Note `[W10]` —— *"the HTML5 specification allows parsers to add elements into the DOM that are considered to be missing. XPaths SHOULD be constructed to include these elements"* —— 讲的是「同一份文档在不同解析器下不一致」，与「文档随时间变化」是**两个问题**。

**任何形如「TextQuote > Fragment > CSS > XPath > TextPosition」的排序，都是实现社区经验，不是 W3C 立场。写进我们的文档时必须这么标注。**

顺带一条**规范性**的东西，容易被误当成健壮性排序，别搞混：Data Model 附录 A 有一张「媒体类型 × 选择器」适用矩阵，并在 1.3.1 节赋予它规范效力 `[W5]`——*"A conforming implementation MUST implement that particular combination if it handles the corresponding media type."* 那是 **relevance / conformance**，**不是 robustness**。与我们相关的三行：

| 媒体类型 | Fragment | CSS | XPath | TextQuote | TextPosition | DataPosition | Svg |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **HTML (text/html)** | ✔︎ | ✔︎ | ✔︎ | ✔︎ | ✔︎ | ✘ | ✘ |
| **位图 (image/png, jpeg, gif, tiff)** | ✔︎ | ✘ | ✘ | ✘ | ✘ | ? | ✔︎ |
| **PDF (application/pdf)** | ✔︎ | ✘ | ✘ | ✔︎ | ✔︎ | ✘ | ✘ |

**位图那一行是 §3 的全部前提：规范性地只有 FragmentSelector 与 SvgSelector 两条路。**

> **顺手记一条对 §3 致命的事实：`SvgSelector` 在 `text/html` 那一行是 ✘。** 规范 1.3.1 节对 ✘ 的规定是 *"Conforming implementations SHOULD ignore that particular combination."* `[W5]` 也就是说——**在一个 HTML 页面上用 SvgSelector 画一个区域，是不合规的**。规范认为网页上的区域应当先落到某个 `<img>`（一个独立的 image 资源）上，再对那个资源用 Fragment/Svg。**规范里没有「网页上的任意矩形」这个概念。**

---

## 2. Hypothesis 实际怎么做（读源码，不读它的博客）

> 本节全部结论来自 `github.com/hypothesis/client` 的**完整 git 历史**（本机 clone，`HEAD = b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a`，2026-07-30，15,652 个提交）。行号对应该 commit。引用键 `[H…]`。

### 2.1 它只用三种选择器，而且三种全部一起存

`describe()`（把一个 DOM `Range` 变成选择器数组）在 `src/annotator/anchoring/html.ts:115-134` `[H1]`：

```ts
export function describe(root: Element, range: Range) {
  const types = [
    MediaTimeAnchor,
    RangeAnchor,
    TextPositionAnchor,
    TextQuoteAnchor,
  ];
  const result = [];
  for (const type of types) {
    try {
      const anchor = type.fromRange(root, range);
      if (anchor) {
        result.push(anchor.toSelector());
      }
    } catch {
      // If resolving some anchor fails, we just want to skip it silently
    }
  }
  return result;
}
```

**每一条标注都同时存下三种选择器**（`MediaTimeSelector` 只在带 `data-time-start` 属性的字幕页面上才产出，普通网页没有）。任何一种构造失败就静默跳过。

三种的确切形状，逐字抄自 `src/types/api.ts:58-88` `[H2]`：

```ts
export type TextQuoteSelector = {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
};

export type TextPositionSelector = {
  type: 'TextPositionSelector';
  start: number;
  end: number;
};

export type RangeSelector = {
  type: 'RangeSelector';
  startContainer: string;
  endContainer: string;
  startOffset: number;
  endOffset: number;
};
```

**这里有一个必须点破的事实：Hypothesis 的 `RangeSelector` 不是 W3C 的 `RangeSelector`。** W3C 那个的字段是 `startSelector` / `endSelector`，值是**嵌套的 Selector 对象** `[W4]`；Hypothesis 这个的字段是 `startContainer` / `endContainer`，值是**字符串形式的简化 XPath**。名字撞了，形状完全不同。W3C 里真正对应的东西叫 `XPathSelector`（`{type, value}`）。**照着 W3C 规范写 parser 去读 Hypothesis 的数据会直接崩。**

而且那个 XPath 也不是标准 XPath。`xpathFromNode` 产出的是 `/tag[index]/tag[index]` 这种「simple XPath」，`src/annotator/anchoring/xpath.ts:79-95` 的注释原文 `[H3]`：

> *"A _simple XPath_ is a sequence of one or more `/tagName[index]` strings. Unlike `document.evaluate` this function: - Only supports simple XPaths - Is not affected by the document's _type_ (HTML or XML/XHTML) - Ignores element namespaces… - Is case-insensitive for all elements"*

解析时先试自己写的 `evaluateSimpleXPath`，不是 simple XPath 才退回 `document.evaluate` `[H3]`。**它有意避开浏览器的 XPath 引擎**——因为 HTML 与 XHTML 下 `document.evaluate` 的行为不一致。

`prefix` / `suffix` 各取 **32 个字符**，硬编码在 `TextQuoteAnchor.fromRange`，`src/annotator/anchoring/types.ts:190-199` `[H4]`：

```ts
// Number of characters around the quote to capture as context. We currently
// always use a fixed amount, but it would be better if this code was aware
// of logical boundaries in the document (paragraph, article etc.) …
const contextLen = 32;
```

注释里那句 *"it would be better if this code was aware of logical boundaries"* 是他们自己留的账——32 是个凑合的数，不是调出来的最优值。

### 2.2 fallback 顺序：**Range → Position → Quote**，而且 quote 是裁判

`anchor()` 在 `src/annotator/anchoring/html.ts:36-113` `[H1]`。它不是 if/else，是一条 **`promise.catch()` 链**：

```ts
// From a default of failure, we build up catch clauses to try selectors in
// order, from simple to complex.
let promise: Promise<Range> = Promise.reject('unable to anchor');

if (range)    promise = promise.catch(() => …RangeAnchor…      .then(maybeAssertQuote));
if (position) promise = promise.catch(() => …TextPositionAnchor….then(maybeAssertQuote));
if (quote)    promise = promise.catch(() => …TextQuoteAnchor…);
```

**顺序是：RangeSelector（XPath）→ TextPositionSelector（字符偏移）→ TextQuoteSelector（模糊匹配）。**

关键不在顺序，在 `maybeAssertQuote`：

```ts
const maybeAssertQuote = (range: Range) => {
  if (quote?.exact && range.toString() !== quote.exact) {
    throw new Error('quote mismatch');
  } else {
    return range;
  }
};
```

**前两条快路的结果必须逐字等于存下来的 `exact`，否则算失败、继续往下退。** 换句话说：

> **XPath 与字符偏移在 Hypothesis 里不是「锚点」，是「加速器」。真正的锚点是引文；前两者只是省下一次全文模糊搜索的捷径，而且每次都要拿引文验一遍。**

`guest.ts:906-916` 把这条写成了规则 `[H5]`：

> *"Annotations must have either a quote or a shape selector. For annotations of text, the quote is used to verify anchoring with other selector types."*

代码里也确实拒收没有 quote 的标注——`target.selector.some(s => s.type === 'TextQuoteSelector' || s.type === 'ShapeSelector')` 为假就直接返回一个无 region 的空 anchor `[H5]`。

还有一处交叉喂料：`anchor()` 在收集选择器时会做 `options.hint = position.start` `[H1]`，把 TextPositionSelector 的起点当成模糊搜索的**位置先验**传给 TextQuoteAnchor。**即使 position 这条路失败了，它记的那个数字仍然在帮 quote 消歧。** 这是「多选择器并用」最实在的一个例子——不是「谁先成功用谁」，是**失败的那个也在给成功的那个提供信息**。

### 2.3 模糊匹配：**不是 `diff-match-patch`，2020 年底换掉了**

**问题里那个假设在 2020-12-10 就不成立了。** 有确切的提交：

| 时间 | 提交 | 事件 |
| --- | --- | --- |
| 2013-03-04 | `cd5586afe` | *"Fuzzy anchoring finally fully functional."* —— 引入 diff-match-patch |
| 2015-05-21 | `4eb465065` | *"Use vanilla diff-match-patch"* —— 删掉自己 fork 的 `dom_text_matcher.js` / `text_match_engines.js`（2,702 行） |
| 2015-07-14 | `4d0019c94` | *"Switch to new standalone anchoring libs"* —— 移到 `dom-anchor-text-quote` |
| 2020-05-26 | `fc73d74a5` | *"Remove unused diff-match-patch dependency"* |
| **2020-12-10** | **`d2e9f195c`** | ***"Add new fuzzy quote matching implementation"*** |
| 2020-12-01 | `5d43b47bd` | *"Remove unused dom-anchor-text-quote dependency"* |

`[H6]`。现在整个仓库里 `diff-match-patch` 出现 **0 次**（`grep -rn` 实测）。

`d2e9f195c` 的提交信息原文（Robert Knight）`[H6]`：

> *"Implement a `matchQuote` function which will be used to replace `dom-anchor-text-quote` for finding the best match for annotation quotes in the document text. The new implementation is based on the `approx-string-match` library and provides several improvements over the existing one: - Better performance when there are many differences between the quote and closest document text - It will be easier for us to tune the degree of mismatch allowed between the quote and document text and how candidate matches are ranked"*

**现在用的是 `approx-string-match@^2.0.0`** `[H7]`，作者也是 Robert Knight（Hypothesis 的工程师）。它实现的是 **Myers 1999 的 bit-parallel 近似串匹配**，README 原文 `[E4]`：

> *"A Fast Bit-Vector Algorithm for Approximate String Matching Based on Dynamic Programming," vol. 46, no. 3, pp. 395–415, 1999.*

期望复杂度 `O((k/w) * n)`，`w = 32`。API 是 `search(text, pattern, maxErrors) → Match[]`，`Match = { start, end, errors }` `[E4]`。

**注意这是 Levenshtein 编辑距离下的「最多 k 个错」，与 diff-match-patch 的 bitap + `Match_Threshold` 打分是两套东西。** 所以问题里问的 `matchDistance` / `matchThreshold` 在**今天的 Hypothesis 里根本不存在**。

#### 今天的容差参数（逐字，`src/annotator/anchoring/match-quote.ts`）`[H8]`

```ts
const maxErrors = Math.min(256, quote.length / 2);
```

**引文长度的一半，上限 256 个编辑距离。** 这个数字比大多数人猜的松得多——一段 200 字符的引文允许改 100 个字符。他们自己把权衡写在旁边：

> *"This choice involves a tradeoff between: - Recall (proportion of "good" matches found) - Precision (proportion of matches found which are "good") - Cost of the initial search and of processing the candidate matches"*

先做一次 `indexOf` 的精确搜索，**只要有精确命中就完全不跑近似搜索**（`search()` 的前 20 行）；精确命中会返回**全部**位置，不是第一个。

#### 排序权重（这才是真正的「参数」）`[H8]`

```ts
const quoteWeight = 50;  // Similarity of matched text to quote.
const prefixWeight = 20; // Similarity of text before matched text to `context.prefix`.
const suffixWeight = 20; // Similarity of text after matched text to `context.suffix`.
const posWeight = 2;     // Proximity to expected location. Used as a tie-breaker.
```

得分 = 加权和 / 92，取最高者。各项：

- `quoteScore = 1 - match.errors / quote.length`
- `prefixScore` / `suffixScore`：把 `text` 里匹配位置前后各取 `prefix.length` / `suffix.length` 个字符，与存下的 prefix/suffix 再算一次编辑距离相似度（`textMatchScore`）
- `posScore = 1.0 - |match.start - hint| / text.length`

**没有阈值。** `matchQuote` 只在「引文为空」或「一个候选都没有」时返回 `null`；只要 `approxSearch` 吐出至少一个候选，**分数再低也会被采纳**。这是个重要的设计选择：**Hypothesis 宁可锚错，也不愿意锚不上。**

### 2.4 同一段文字出现多次：靠 prefix/suffix 打分 + position 当 tie-breaker

这就是 §2.3 那张权重表在干的事，路径完整走一遍是这样：

1. `search()` 找到 N 个精确命中（`indexOf` 全找）；
2. 每个候选算 `scoreMatch`：引文本身都是满分（errors=0），**区分度全部来自 prefix(20) + suffix(20)**；
3. prefix/suffix 也一样时（比如页面上有两处一模一样的完整段落），**`posWeight = 2` 的位置项做最后的裁决**——而这个 `hint` 来自 `TextPositionSelector.start` `[H1]`。

**所以「多选择器并用」在 Hypothesis 这里的真实作用，一大半是消歧，不是 fallback。** 只有 `TextQuoteSelector` 一条时，重复文本上它只能靠 32 字符的上下文；配上 `TextPositionSelector`，就多了一个「原来大概在第几个字符」的先验。

注意 `posScore` 的归一化除的是 `text.length`（全文长度）——**页面越长，位置项的区分力越弱**。在一篇 20 万字符的长文里，偏 2000 个字符只扣 `2 × 0.01 = 0.02` 分，而 92 分的总分里这点差距几乎为零。**位置消歧在长页面上基本失效**，这是源码直接读出来的性质，不是推测。

> **一处与 W3C 规范的冲突值得记下。** 规范说 *"If, after processing the prefix, exact, and suffix, the user agent discovers multiple matching text sequences, then the selection SHOULD be treated as matching all of the matches."* `[W11]`——**全部命中**。Hypothesis 是 `scoredMatches.sort(...); return scoredMatches[0]` `[H8]`——**只取一个**。业界最大的实现没有遵守这条 SHOULD。

### 2.5 它给「锚不上」留的两个出口

- **`ANCHORING_TIMEOUT = 500`**（毫秒），`src/sidebar/store/modules/annotations.ts:314` `[H9]`。超过 500 ms 还没锚上就先标成 `timeout`，注释原文 *"If anchoring fails to complete in a reasonable amount of time, then we assume that the annotation failed to anchor. If it does later successfully anchor then the status will be updated."*
- **状态是三态**：`type AnchorStatus = 'anchored' | 'orphan' | 'timeout'` `[H9]`。UI 上 orphan 进一个单独的 tab（`SidebarTabs.tsx`），引文用 `p-redacted-text` 样式打码显示 `[H10]`。

**「锚不上」在 Hypothesis 里是一个被正面设计过的一等状态，不是异常。** 这一点比任何算法细节都值得抄。

### 2.6 失效率：**Hypothesis 自己从没公布过任何比率**

**先把「找不到」这件事说清楚，因为它本身就是结论的一部分。**

**（a）官方博客那篇《Fuzzy Anchoring》确实存在，但里面一个评测数字都没有。** `web.hypothes.is/blog/fuzzy-anchoring/`，csillag，**2013-04-22** `[E9]`。它描述的四级 fallback（Range → Position → **Context-first Fuzzy** → **Selector-only Fuzzy**）与今天源码里的三级链（§2.2）同源；用的还是 *"a modified version of the google-diff-match-patch library"* 与 Bitap——**这份 2013 年的博客描述的正是 2020 年被换掉的那套**（§2.3）。全文唯一的数字是实现常量，而它十三年没变过：

> *"TextQuoteSelector : this selector stores three strings: exact : the selected text itself prefix : the (32-char long) text immediately before the selected text suffix : the (32-char long) text immediately after the selected text"*

**没有失效率、没有语料规模、没有 benchmark。**

**（b）他们自己也想要这个数。** `hypothesis/product-backlog#954`，标题《annotations can fail to anchor, yet not be reported as orphans》，judell 开于 **2019-02-08**，**现已 CLOSED** `[E5]`。2019-02-20 他写下 *"I will now gather data, from both the PDF and HTML domains"* —— **数据始终没有出现在这个 thread 里**。2020-11-04 又写：

> *"**It would sure be nice to have** telemetry that can capture a much wider and clearer view of anchoring outcomes"*

**分寸要拿准：这是一句愿望表述，不等于官方声明「我们没有遥测」。** 但它足以说明：**这个数至少没有公开过。**

**（c）同一条 issue 还给出了一个方向性事实**：judell 原文 *"these anchoring failures are not reported as orphans by the client"* `[E5]`。**也就是说，任何基于「Orphans tab 计数」得出的比率都是低估。**

**（d）没有任何公开来源做过 `TextQuoteSelector` 与 `TextPositionSelector` 的成功率对照实验。** §5 里「引文比偏移更耐改版」这个人人都在用的排序，**没有一手实测支持**——它来自「偏移在任何编辑下都必然移位」这个演绎，不是量出来的。

---

#### 2.6.1 唯一一份大规模实测：ODU 的两篇，但它量的不是锚点

**Aturban, Nelson & Weigle，《Quantifying Orphaned Annotations in Hypothes.is》**，arXiv:1512.06195v1，2015-12-19 `[E6]`。摘要原文：

> *"We investigate the prevalence of orphaned annotations, where neither the live Web page nor an archived copy of the Web page contains the text that had previously been annotated in the Hypothes.is annotation system (containing 20,953 highlighted text annotations). We found that **about 22% of highlighted text annotations can no longer be attached to their live Web pages**. Unfortunately, only about **12%** of these annotations can be reattached using the holdings of current public web archives, leaving the remaining **88%** of these annotations orphaned. For those annotations that are still attached, **53% are in danger of becoming orphans** if the live Web page changes."*

**口径（数字看着互相矛盾，是因为分母不同；下表的分母逐条标出）`[E6]`：**

| | 值 | 分母 |
| --- | --- | --- |
| 抓取时间 | **2015 年 8 月** | — |
| 全部公开标注 | 33,946 | — |
| 其中带 `TextQuoteSelector` | **20,953** | — |
| 剔除不可解析 URI（820 条）后的**分析集** | **20,133** | ← **下面全部以此为分母** |
| 目标页已 4xx/5xx | 1,966（**10%**） | /20,133 |
| 仍能贴回去 | 15,773（**78%**） | /20,133 |
| **贴不回去** | **4,360（22%）** | /20,133 |
| 这 4,360 里能靠 web archive 救回的 | 547（**12%**） | /4,360 |
| 最终 orphan | 3,813（**19%**） | /20,133 |
| 仍贴得上、但**没有任何存档副本**（濒危） | 8,357（**53%**） | /15,773 |
| 同一批濒危数换个分母 | 8,357（**41%**） | /20,133 |

前作 **TPDL 2015**（同作者，语料是 2015 年 1 月的 **6,281** 条）：orphan **27.3%**、可恢复 **3.5%**、濒危 **61%** `[E6]`。

> ⚠️ **TPDL 那篇正文有一处笔误**：写作 *"only allow 61% of these to be re-attached"*，与同篇摘要的 *"about 3.5%"* 直接冲突；61 ÷ 1,715 = 3.56%，所以正文那个 61% 应当是「61 **条**」，百分号是笔误。**这是核查者的推断，论文没有勘误；arXiv 版同一位置已改成 12%。**

**三条读法，第一条最重要。**

**1. 这 22% 衡量的是「那段文字是不是还一字不差地在页面上」，不是 Hypothesis 锚点的表现。** 方法学原文 `[E6]`：

> *"for HTML web resources, we extract only the text after cleaning it by removing all HTML tags, extra white-space characters, and others… After extracting the text either from a standard HTML web page or a PDF file, **we search for the highlighted annotation text. If the text is not found, the annotation is considered not attached.**"*

**这是逐字子串搜索。而模糊锚定存在的全部意义，正是熬过这种变化**——§2.3 那个 `maxErrors = quote.length / 2` 会救回其中一部分。

> ⚠️ **必须严格把握分寸：论文从来没有说过自己「没有使用 fuzzy anchoring」。** 这个判断是**从方法描述推出来的**，另加一条佐证——对两篇全文做词频检查，`fuzzy` = 0、`diff-match` = 0、`approximat*` = 0 `[E6]`。**不能写成「作者声明未使用模糊锚定」。**

**所以：22% 是「页面变了」的上界，不是 `TextQuoteSelector` 的失效率。模糊匹配能救回其中多少——没人量过。这是本文最想要而没拿到的那个数。**

**2. 22% 里有将近一半根本不是锚点问题。** 用论文自己的数算（**这是我的算术**）：4,360 里有 1,966 是**页面整个没了**（4xx/5xx），剩下 `4,360 − 1,966 = 2,394` 才是「页面还在、文字逐字找不到了」——占 20,133 的 **11.9%**。

> **拆开之后画面完全不同：约 10% 是链接腐烂（任何锚点方案都救不了），约 12% 是内容变了（好的锚点有机会救回一部分）。把 22% 整个记成「锚点技术的失败率」是读错了。**

**3. 论文自己的结论是「存证据」，不是「更好的选择器」。** 摘要末句 *"This points to the need for archiving the target of an annotation at the time the annotation is created."* `[E6]` 那个 53% 的含义也要读准——正文写的是 *"53% of the currently attached annotations could potentially become orphans if their live Web resources change, **because there are no archived versions of the annotated resources available**"* `[E6]`。**它量的是「有没有存档」，不是「会不会失败」。**

**局限三条：** ① 2015 年的 Hypothesis 用的还是 diff-match-patch 那套，今天换过了；② 它是从外部复现，不是读客户端运行时状态；③ 语料混着 HTML 与 PDF，论文没分开报。

#### 2.6.2 官方仓库里确实躺着一批原始数据（但官方从未从中得出过比率）

`github.com/hypothesis/anchoring-test-tools` 是 Hypothesis 官方 org 下的仓库 `[E28]`。`results/` 只有唯一一次提交：**2019-09-19，Robert Knight，*"Add results from running tests on sep-2019-pdf-urls.txt test set"***。README 明说测试语料是 *"real annotations created by Hypothesis users in public groups"*。

两个 JSON 是**同一批 235 个 URL 跑两种 PDF.js 渲染器版本**（`via` 与 `via-pdfjs2`），**不是时间前后对比**。逐条求和 `[E28]`：

| 渲染器 | 可用文档 | anchored | orphan | 比率 |
| --- | --- | --- | --- | --- |
| via（pdfjs1） | 211 / 235 | 7,482 | 48 | **0.64%** |
| via-pdfjs2 | 219 / 235 | 7,691 | 90 | **1.16%** |

**这两个数必须带四个折扣，否则会被严重误读：**

1. **这两个百分比是核查者的算术。Hypothesis 从未表述过任何比率。**
2. **分布极度偏斜，中位数文档的 orphan 数是 0**（pdfjs1 的 211 条里 **207 条零 orphan**）。单个 researchgate URL（1 anchored / 33 orphan，几乎肯定是登录墙导致 PDF 根本没加载）一家就贡献了 48 里的 33。**剔除它之后 pdfjs1 = 0.20%、pdfjs2 = 0.74%。**
3. **加载彻底失败的条目不在分母里**（典型形态是 `{'error': 'waiting for selector … timeout 30000ms'}`）——**那比 orphan 更糟，却没被计入。**
4. **语料只有 PDF，不含 HTML。** 而 PDF 的文本层是文件的一部分、不随时间变——**这批数几乎不能说明网页的情况。**

再叠上 §2.6(c) 那条「锚定失败不一定被报成 orphan」`[E5]`，**0.64% / 1.16% 是低估的低估**。

> **净结论：Hypothesis 生态里唯一一批官方原始数据，测的是 PDF、样本 235 个 URL、且系统性低估。它不能回答「网页标注多久会失效」。**

#### 2.6.3 二十六年前有过一次真实语料的测量

**Phelps & Wilensky，《Robust Intra-document Locations》，WWW9，2000** `[E29]`：

> *"…of **754** annotations that needed repositioning because the referenced man pages underwent change out of control of the annotator, **742** annotations were automatically repositioned, leaving **12** to be reapplied by the user."*

= **98.4%**（百分比是核查者的算术）。**但作者自己在同一段就把限定写死了**——该实现是 TkMan 里的 *"prototype, less sophisticated implementation"*，且作者自陈这些结果 *"are no substitute for actual measurement"* `[E29]`。语料是 Unix man page，**与现代网页完全不同分布**。

> 顺带订正一条常见说法：Berkeley 技术报告版（CSD-00-1091）与 D-Lib 版**确实没有**测量值，只有 WWW9 版有。D-Lib 版的正确 URL 是 `.../july00/wilensky/07wilensky.html`（很多地方写的 `phelps/07phelps.html` 是 404）`[E29]`。

### 2.7 更外围但更可靠的两个数：网页到底变得多快

既然锚点失效的根因是「页面变了」，这两个数决定了失效率的量级下限。**它们不是关于标注的，但它们是关于标注寿命的。**

| 来源 | 样本 | 数字 |
| --- | --- | --- |
| **Fetterly et al.，《A large-scale study of the evolution of web pages》**，Software: Practice and Experience 34(2)，2004 `[E7]` | **1.5 亿**个网页，每周抓一次，连抓 **11 周** | 每周约 **3%** 的页面发生**实质性**改动 |
| **Jones, Nelson, Van de Sompel et al.，《Scholarly Context Adrift》**，PLOS ONE 11(12)，2016 `[E8]` | **241,091** 条学术论文中的 URI 引用（1997–2012） | **76.35%** 发生 **content drift**（页面还在，内容已不是被引用时那个） |

**读法：** 每周 3% 的实质改动率，一年下来绝大多数页面都动过；而学术引用这种「本该稳定」的场景，十几年尺度上 76% 内容漂移。**这两个数不能直接换算成 orphan 率**（页面改了不等于被标注那段改了），但它们说明：**「网页摘录的锚点会失效」不是边缘情况，是主线剧情。**

---

## 3. 图片 / 区域（不是文字）怎么锚

### 3.1 规范给的两条路，而网页上那条是关着的

§1.4 末尾那张适用矩阵是本节的全部前提 `[W5]`：

- **位图**（`image/gif`、`image/jpeg`、`image/png`、`image/tiff`）：**只有 `FragmentSelector` 与 `SvgSelector` 是 ✔︎**；CSS / XPath / TextQuote / TextPosition 全是 ✘。
- **`text/html`：`SvgSelector` 是 ✘。**

而 1.3.1 节对 ✘ 的规定是 *"Conforming implementations SHOULD ignore that particular combination."* `[W5]`

> **也就是说：规范里没有「网页上的任意矩形」这个东西。** 规范设想的路径是「网页里有一个 `<img>`，它是一个**独立的资源**，有自己的 URL 与媒体类型；你对**那个资源**用 Fragment 或 Svg」。**框住一块横跨若干 `<div>` 的版面区域——规范没有为它准备任何东西。**

**`FragmentSelector` 用于图像区域**，写法是 `conformsTo` 指向 Media Fragments、`value` 写 `xywh=` `[W8]`：

```json
{
  "type": "FragmentSelector",
  "conformsTo": "http://www.w3.org/TR/media-frags/",
  "value": "xywh=100,100,300,300"
}
```

**注意规范自己没有给出这个组合的完整 JSON 示例。** `xywh` 在 Data Model 全文只出现两处——`conformsTo` 候选表里的一行（`Media | http://www.w3.org/TR/media-frags/ | Example: xywh=50,50,640,480`），以及 Example 4 里的**裸 IRI fragment 写法**（`"id": "http://example.com/image1#xywh=100,100,300,300"`），而后者正是规范建议改掉的反面写法 `[W8]`。上面这段是我按规范的两个部件拼的。

**`xywh` 的语法约束比想象中紧** `[W6]`：

> *"Rectangle selection is denoted by the name xywh. The value is an optional format `pixel:` or `percent:` (defaulting to `pixel`) and 4 comma-separated integers. The integers denote x, y, width and height, respectively, with x=0, y=0 being the top left corner of the image."*

ABNF 是 `1*DIGIT` —— **只能非负整数，不允许小数、不允许负号**。于是：

- **`percent:` 只能整数百分比。** 一张 2000 px 宽的图，1% = 20 px，框选边界的量化误差就是 20 px。
- **要精度只能用 `pixel:`，但那样就绑死一个具体分辨率。** 规范自己写了 `[W6]`：*"If the clipping region is pixel-based and the image is multi-resolution (like an ICO file), the fragment MUST be ignored… More generally, pixel-clip an image that does not have a single well defined pixel resolution (width and height) is not recommended."*

> **`srcset` 响应式图片正好就是「没有单一明确分辨率」的情形。** 规范这句话等于说：**对响应式图片，`pixel:` 形式的 `xywh` 不该用**；而 `percent:` 又只有整数精度。**这是规范层面的死结，不是实现没做好。**

**`SvgSelector`** 是非矩形区域的唯一选项，但它的规范描述松得没法互操作 `[W13]`。唯一的坐标系约束是：

> *"The dimensions of the SVG shape or canvas MUST be relative to the dimensions of the Source resource, such that scaling the shape's size to the full size of the image correctly describes the desired area."*

**规范没规定 `viewBox` 必须写、没规定用绝对像素还是 0–1 归一化，而且它的两个示例里 SVG 内容都是 `"<svg:svg> ... </svg:svg>"` 占位** `[W13]`——**没有一个完整可运行的例子。** 对一份 2017 年的 Recommendation 来说，这基本等于「自己看着办」。

### 3.2 Hypothesis 的答案：**普通网页上它不做，而且是有意不做**

这是本节最硬的证据，因为它来自源码而不是表态。

**（1）普通网页上只有文字选区。** `HTMLIntegration` `[H11]`：

```ts
describe(root: Element, region: Range | Shape): Selector[] {
  if (region instanceof Range) {
    return describe(root, region);
  } else {
    throw new Error('Unsupported region type');
  }
}
…
supportedTools(): AnnotationTool[] {
  return ['selection'];
}
```

`VitalSourceContentIntegration`（电子书）同样只返回 `['selection']` `[H11]`。

**（2）只有 PDF 有 rect / point，而且还锁在 feature flag 后面** `[H12]`：

```ts
supportedTools(): AnnotationTool[] {
  const imageAnnotation = this._features?.flagEnabled('pdf_image_annotation');
  if (imageAnnotation) {
    return ['selection', 'rect', 'point'];
  } else {
    return ['selection'];
  }
}
```

**（3）这不是没来得及做，是明确划出的边界。** 引入 `ShapeSelector` 那个提交（`cae60a329`，2025-04-04，Robert Knight）的信息原文 `[H16]`：

> *"- Add a new `ShapeSelector` selector type which represents a 2D region of a document. For paged media the coordinates are relative to the selected page.*
> *- Support describing (ie. serializing) shapes in the PDF integration*
> *- **Throw exceptions in the HTML and VitalSource integrations if passed a shape, since that is not yet supported.**"*

同一个提交还坦白了另一件事：

> *"Anchoring of this selector is not yet implemented, so **the annotation will become an orphan after the page is reloaded**."*

**这个提交是 2025-04-04。本文读的 HEAD 是 2026-07-30——十六个月过去，HTML 那边仍然是 `throw new Error('Unsupported region type')`，PDF 那边仍然锁在 flag 后面。** 这不是「还没排上」，这是**一个投入了一年多的团队给出的判断**。

**而且服务端连开关位都留好了、就是没实现。** Hypothesis 的服务端 `h` 里两个 flag 都定义了 `[E40]`：

```python
"html_image_annotation": "Support image annotations in HTML",
"pdf_image_annotation":  "Support image annotations in PDFs",
```

但在 client 仓库里 `grep -rn "html_image_annotation" src/` —— **0 命中**。**网页图像标注：规划了、开了 flag 位、没实现。**

**（4）它的 `ShapeSelector` 为什么在 PDF 上成立、在网页上不成立。** 看类型定义就清楚 `[H13]`：

```ts
export type ShapeSelector = {
  type: 'ShapeSelector';
  shape: Shape;                 // rect{left,top,right,bottom} | point{x,y}
  anchor?: 'page';              // ← 取值只有 'page' 一种
  view?: { left; top; right; bottom };
  text?: string;                // "The text contained inside this shape."
};
```

JSDoc 把道理讲得很清楚 `[H13]`：

> *"Shape selectors should be defined using the **natural coordinate system** for the anchor element in the document, enabling an annotation made in one viewer to be resolved to the same location in a different viewer, with different view settings (zoom, rotation etc.)… - For PDFs, PDF user space coordinates (points), with the origin at the bottom-left corner of the page. - For images, pixels with the origin at the top-left"*

**关键词是 "natural coordinate system"。** PDF 页有 crop box，图片有 intrinsic size——**它们自带一个不随渲染变化的坐标系**。而**一个 HTML 页面没有**：它的布局是视口宽度、字体、CSS 与页面自身脚本共同算出来的结果。`anchor` 字段的取值只有 `'page'`，**根本没有「某个 HTML 元素」这个选项**——一旦锚到 HTML 元素，坐标就又回到了「随布局变」。

锚定时它还硬性要求配一个页码 `[H14]`：

```ts
if (shapeSelector) {
  if (!pageSelector) {
    throw new Error('Cannot anchor a shape selector without a page');
  }
  return anchorShape(pageSelector, shapeSelector);
}
```

**`ShapeSelector` 从来不单独工作——它总是「页码 + 页内坐标」。这正是我们 PDF 那套 `Anchor { page, rect }` `[P2]`，一模一样。**

> **Hypothesis 独立地走到了与我们相同的 PDF 方案，也独立地得出了「这套东西搬不到网页上」的结论。这是本文对 §5 最强的一条外部支持。**

**（5）它给区域标注加的那一样东西，值得抄。** `ShapeSelector.text` —— *"The text contained inside this shape."* `[H13]`。产出时用 `textFromRect(textLayer, rect)` 把框内文字一并存下 `[H14]`。**这是把「区域」偷偷转成「引文」的后门**：即使坐标失效，框里那段文字仍可拿去做 TextQuote 匹配。

> **但这条后门对中文是坏的。** 抓框内文字的实现是 `textInDOMRect` `[H15]`，它 `textNode.data.split(/\b/)` 按**词边界**切，再逐词求 `getBoundingClientRect()` 与框求交。**实测：`"第三章 进程与线程，本章讨论调度器的实现。".split(/\b/)` 返回整串一个元素** `[M1]`——JS 的 `\b` 基于 ASCII `\w`，汉字之间没有词边界。**于是中文文本节点在这个实现里不可分：框住半行会把整节点的字全抓进来，或者一个字都抓不到（取决于整块外接矩形与框有没有交集）。要抄这条后门，必须换成按字符或 `Intl.Segmenter` 切，不能照抄 `/\b/`。**

### 3.3 「截图 + 感知哈希」有没有人真的在用？—— **查过了，没有**

这是本节最需要如实回答的问题，答案是否定的，而且否定得相当干净。

**（a）唯一系统描述这个想法的文献是一份专利，而且它被放弃了。**

**《Robust anchoring of annotations to content》**，US20060080598A1，Microsoft，发明人 **David Bargeron、Alice Jane Brush、Anoop Gupta**，申请日 **2005-11-29**，公开日 **2006-04-13** `[E30]`。它描述的正是这个方案：

> *"Color histogram, number of pixels in the region, recognizable/trackable objects in the region, motion flow, edge features, wavelet signatures, or various other standard image processing features. These features can then be used to re-anchor the annotation to the correct portion of the image."*

**法律状态：Abandoned（放弃），从未授权。** 也没有任何证据表明它进过产品 `[E30]`。

> **值得注意的是发明人**：Bargeron 与 Brush 正是 CHI 2001《Robust Annotation Positioning in Digital Documents》的作者——**做文字锚定做得最深的那批人，想到了用图像特征锚区域，然后放弃了。**

**（b）现役的标注系统一个都没这么做。** 逐个核对的结果：

| 系统 | 图片/区域锚点 | 出处 |
| --- | --- | --- |
| **Hypothesis** | **普通网页上不支持**；PDF 上是「页码 + PDF user space 矩形」，无任何图像特征 | 源码 `[H11][H12][H14]` |
| **Zotero** | 标注类型有 `image`(3) / `ink`(4)；位置存在 `annotationPosition` 这个**不透明 JSON 字符串**里（含 `rects` 或 `paths`），上限 `ANNOTATION_POSITION_MAX_SIZE = 65000` 字节；**并且给 `image`/`ink` 标注缓存一张渲染好的 PNG**（`getCacheImagePath` / `saveCacheImage`）。**存的是坐标 + 像素，没有任何感知哈希或特征匹配** | 源码 `[E31]` |
| **Zotero 的网页快照** | **快照里根本没有区域标注。** 源码注释逐字：*"snapshot annotations are CssSelectors, possibly refined by TextPositionSelectors"*，紧跟着两行 *"Skipping: XPath Selector"* / ***"Skipping: Data Position Selector, SVG Selector, Range Selector"***。而且**完全不重锚**——一次 `querySelector`，找不到就 `console.error` 放弃 | 源码 `[E31]` |
| **W3C 参考实现**（Apache Annotator） | **项目已于 2025-08-11 退休**，且只做 *"textual fragments"* | `[E1][E2]` |

**（c）视觉回归测试（Percy / Applitools / Playwright 的 `toHaveScreenshot`）不是同一个问题，别拿来当先例。** 它们比对的是**同一个页面的两个版本**，对应关系是**已知的**（同一个测试、同一个选择器、同一个视口）。而重新锚定要解的是**在一个已经改过的页面里去找一块区域**——**没有已知的对应关系**。**前者是「比对」，后者是「检索」。**

**（d）Zotero 的做法反而是最值得抄的那个，而且我们已经在做。** 它对图像标注的策略是「**存坐标 + 存像素**」，**不试图重新定位**。这与我们现在的 `Region.pixels` / `ClipContent.screenshot` `[P2]` 完全一致。

**（e）而且它不只是「没人做」——有实测数据表明它在原理上就不成立。**

**Meta 的 PDQ 白皮书有一整节叫 `CROPS: OUT OF SCOPE`** `[E32]`：

> *"In the Design Goals section at the start of this document, we already **threw in the towel on hard crops**: they are outside the domain of fast, syntactic matchers such as PDQ. And here we see quantitative data on that: from the distance-histograms of the previous section we see that **pairwise distances between these images are generally within the realm of distances between random images**."*

**独立评测给了具体数字。** McKeown & Buchanan，*Hamming distributions of popular perceptual hashing techniques*，arXiv:2212.08035，语料 Flickr 1 Million `[E33]`。归一化 Hamming 距离（0 = 相同，0.5 ≈ 随机）与精确匹配率：

| 算法 | 形变 | 距离 mean | 精确匹配率 |
| --- | --- | --- | --- |
| pHash | **scale** | 0.0020 | **94.01%** |
| pHash | compression | 0.0053 | **83.90%** |
| pHash | **crop** | **0.1686** | **0.043%** |
| pHash | border | 0.2656 | 0.000% |
| PDQ | **crop** | **0.3255** | **0.000%** |
| PDQ | border | 0.3949 | 0.000% |
| blockhash | scale | 0.0013 | **85.44%** |
| blockhash | **crop** | 0.1668 | 0.018% |

**这张表把问题分成了两半，结论正好相反：**

- **缩放与重压缩：几乎无损。** pHash 94% 精确匹配。→ **响应式图片的多分辨率问题，感知哈希其实能解。**
- **裁剪与加边框：崩到噪声底。** PDQ 裁剪后距离 **0.3255**，而随机图约 0.5、它自己的加边框是 0.3949——**精确匹配率 0.000%**。

> **而「改版」在像素上的表现恰恰就是裁剪与加边框**：模块换个 padding、套个卡片、改个圆角、换个宽高比。**感知哈希擅长的那一半（缩放）不是我们的问题，我们的问题正好落在它明确放弃的那一半。**

**（f）就算想做，浏览器还有两道墙。**

其一，**跨源图片读不到像素**。HTML 规范 §4.12.5.6 `[E39]`：

> *"All bitmaps start with their `origin-clean` set to true. The flag is set to false when cross-origin images are used. The `toDataURL()`, `toBlob()`, and `getImageData()` methods check the flag and will throw a `"SecurityError"` DOMException rather than leak cross-origin data."*

**网页上的图绝大多数在 CDN 上、跨域、没有 CORS 头——算不出哈希。**（这一条同时也是 SingleFile 保存 canvas 会静默失败的原因。）

其二，**`capturePage` 只截可见区域**（§4.4），要给整页做视觉指纹得滚动分段截再拼。

**（g）浏览器厂商自己也是这个判断。** Chrome 的 Text Fragments 解释文档把「滚动到一张图」列为 **Future Work**，并说明了为什么当初放弃 CSS 选择器路线 `[E38]`：

> *"Text snippets, which can be searched asynchronously and are generally less security sensitive, became our preferred solution. As an additional bonus, **we expect text snippets to be more stable** and easier to understand by non-technical users."*

**「我们预期文本片段比 CSS 选择器更稳定」——这是实现者的判断，不是博客观点。** 顺带：Web 平台**原生没有任何指向「图片某个区域」的方式**——WHATWG 的 fragment 解析只认 `id`、`<a name>`，加上后来的 `#:~:text=`；而 `#xywh=` 只对 `image/*` 有定义，**对 `text/html` 根本没有定义**，且实测只有 Firefox 147+ 在 SVG 上支持 `[E37]`。

### 3.4 那网页上的一个纯图框，到底还剩什么

**先说死：没有可靠的持久锚点。** 下面是**按可靠性递减**的三档，全部**是我的设计推论，没有一手数据支持任何一档的成功率**（见 §5）。

| 档 | 用什么 | 什么时候成立 | 什么时候必然失效 |
| --- | --- | --- | --- |
| **A. 框正好落在一个 `<img>` 上** | 图片的**绝对 URL** + 框在**图片自身 intrinsic 坐标系**里的归一化比例（0–1，不是 `xywh` 的整数百分比） | 图片 URL 稳定 | ① CDN 换 hash 文件名 ② `srcset` 在不同视口给不同图 ③ 懒加载时 `src` 还是占位符（真地址在 `data-src`） |
| **B. 框落在有语义标识的容器上** | `CssSelector` 指到容器 + 框相对**容器**的归一化比例 + **容器内的文字**（当 §3.2(5) 那种后门） | 容器有 `id` / 稳定 `class` / `data-*` | 改版。而且**容器高度会随视口宽度变**，纵向比例本身就不稳 |
| **C. 什么都没有**（canvas、纯背景图、跨多个 `div` 的版面区域） | **只有截图 + URL + 时间戳** | — | **一定回不去。这一档不该假装有锚点。** |

**这三档各自的前提，现在有实测数字可以钉住：**

- **A 档赌的是图片 URL 稳定，而规范层面它就不稳定。** WHATWG 的 adaptive-images 示例本身就是反例 `[E37]`：宽视口给 **300×150** 的 `a-rectangle.png`，窄视口给 **100×100** 的 `a-square.png`——**同一个 `<img>`，长宽比和构图裁剪都不同**。规范还写明浏览器 *"may at any time"* 重新选源，尤其是 *"when the user changes the viewport's size"*。**普及率**（Web Almanac 2024）`[E36]`：移动端 **42%** 的页面用 `srcset`（其中 `w` 描述符占 62–64%）、**9.3%** 用 `<picture>`、约 **35%** 用 `loading=lazy`。
- **懒加载会让 `src` 在解析时压根不是真的。** 这不是理论问题——浏览器工程师就是撞上它才放弃了按 `src` 定位图片。WICG 那条 issue 里，提议者自己贴了亚马逊的反例 `[E38]`：`src` 是一个 `grey-pixel.gif` 占位符，真地址在 `data-src` 里，而且尾巴上带着 `._CR0,0,220,220_PT0_SX220__.jpg`——**CDN 把裁剪和尺寸编进了文件名**。该 issue 已于 2023-12 关闭，Chrome 方留言 *"I'm not currently working on this."*
- **`alt` 文本作为兜底标识也只有一半的时候能用。** WebAIM Million 2026（6,660 万张图）`[E35]`：**16.2%** 的首页图片缺 alt（已排除 `alt=""`）；有 alt 的里面还有 **10.8%** 是 *"questionable or repetitive"*——原文结论是 *"more than one in four images on popular home pages have missing, questionable, or repetitive alternative text."* Web Almanac 2024 口径不同、更悲观：***"45 percent of `<img>` elements don't have any alt text"*** `[E36]`。**两个数口径不一，我不做调和，都列出。** 注意「repetitive」那一条尤其致命——**当锚点要的是唯一性，而 alt 常常在页内重复。**
- **`<canvas>` 连元素内容都没有。** HTML 规范 §4.12.5 `[E39]`：*"the canvas element **represents embedded content consisting of a dynamically created image, the element's bitmap**"*，而 *"The contents of the canvas element, if any, are the element's **fallback content**."* **一张 Chart.js 图表，DOM 里可锚的只有一个空的 `<canvas>` 元素。** CSS 背景图更惨——没有元素、没有 `src`、没有 `alt`，而规范自己在推荐把装饰性图片放进 CSS。
- **也别指望用图片的字节哈希当锚。** SRI 至今**不支持 `img`** `[E39]`：*"A future revision of this specification is likely to include integrity support for all possible subresources, i.e., a, audio, embed, iframe, **img**, …"* —— **页面上没有任何地方记录了这张图的字节。**

**一条来自现役系统的正面借鉴：把参考坐标系一起存下来。** Hypothesis 的 `ShapeSelector.view` 是这么做的 `[H13]`；Wikimedia Commons 的 `{{ImageNote}}` 模板更直白——除了 `x/y/w/h`，还把 `dimx`（整图宽）与 `dimy`（整图高）列为 **required** `[E41]`。**矩形数值单独没有意义，必须带上「当时那张图多大」。** 我们的 A 档要存 `naturalWidth`/`naturalHeight` 就是这个道理。

**三条落地约束：**

1. **绝不用视口像素坐标。** 它是视口宽度、字体、CSS 的函数，换台机器就错。要用就用**相对某个自带坐标系的元素**的归一化比例——这正是 Hypothesis `ShapeSelector` 那句 "natural coordinate system" `[H13]` 的意思。
2. **A 档要把图片的 intrinsic 尺寸一起存下来**（`naturalWidth` / `naturalHeight`）。否则下次拿到的是 `srcset` 里另一档分辨率时，连该按什么基准换算都不知道。
3. **C 档必须在 UI 上和 A/B 档区分开。** 一条永远回不去的摘录，不该和能回去的长得一样。

---

## 4. Electron 里加载任意网站

> 引文取自 `electron/electron` 仓库 **`v43.4.1`** tag 下的 `docs/`，并与线上 `electronjs.org/docs/latest` 逐字比对一致（抓取日 2026-08-20）。本仓库装的是 **43.4.0** `[P1]`，同一大版本。文档没写、只有源码能证的地方，我明确标成**源码级结论**。

### 4.1 `<webview>` 已被官方明文劝退；`BrowserView` 已废弃

**`<webview>` 页面开头第一个 Warning 段，逐字** `[E10]`：

> *"Electron's `webview` tag is based on Chromium's `webview`, which is undergoing dramatic architectural changes. This impacts the stability of `webviews`, including rendering, navigation, and event routing. **We currently recommend to not use the `webview` tag** and to consider alternatives, like `iframe`, a `WebContentsView`, or an architecture that avoids embedded content altogether."*

同页还说明它默认就是关的：*"By default the `webview` tag is disabled in Electron >= 5. You need to enable the tag by setting the `webviewTag` webPreferences option"* `[E10]`。**我们现在没开，这是对的** `[P1]`。

**`BrowserView` 的废弃通知** `[E11]`：

> *"The `BrowserView` class is deprecated, and replaced by the new `WebContentsView` class."*

废弃版本：`browser-view.md` 的 YAML history 指向 PR 35658、`breaking-changes-header: deprecated-browserview`，而 breaking-changes 文档里 `### Deprecated: BrowserView` 一节位于 `## Planned Breaking API Changes (30.0)` 之下 —— **Electron 30.0 废弃** `[E11]`。

**`WebContentsView` 是净推荐。** 官方顶部示例逐字 `[E15]`：

```js
const { BaseWindow, WebContentsView } = require('electron')
const win = new BaseWindow({ width: 800, height: 400 })
const view1 = new WebContentsView()
win.contentView.addChildView(view1)
view1.webContents.loadURL('https://electronjs.org')
view1.setBounds({ x: 0, y: 0, width: 400, height: 400 })
```

**一个必须记住的坑**（`BaseWindow` 文档）`[E16]`：

> *"Unlike with a `BrowserWindow`, if you don't explicitly close the `webContents`, you'll encounter memory leaks."*

对我们尤其要紧——**读者会开很多标签页**。每关一个 view 都得 `view.webContents.close()`。

**API 完整度也倒向 `WebContentsView`。** `<webview>` 上的方法签名比 `webContents` 版少东西 `[E10]`：没有 `executeJavaScriptInIsolatedWorld`；`insertCSS(css)` **没有 `cssOrigin` 选项**；`capturePage([rect])` **没有 `opts`**。要拿全量 API 只能 `getWebContentsId()` 再到主进程 `webContents.fromId()`。加上 *"Most methods called on the webview from the host page require a synchronous call to the main process"* `[E10]`——**每次调用一次同步 IPC，在拖框这种高频交互上不能接受。**

> 唯一一处官方把两者并列的地方是 security 文档 `[E3]`：*"To display remote content, use the `<webview>` tag or a `WebContentsView` and make sure to disable the `nodeIntegration` and enable `contextIsolation`."* 但 `<webview>` 自己的页面明说别用。**两份文档合起来，净推荐是 `WebContentsView` + `nodeIntegration: false` + `contextIsolation: true`。**

### 4.2 注入我们自己的选区叠层：三条路，隔离级别完全不同

| 手段 | 跑在哪个世界 | 第三方页面能否干扰 | 官方原文 |
| --- | --- | --- | --- |
| **`preload`** | **隔离世界**（`contextIsolation: true` 时） | ❌ 不能 | *"Specifies a script that will be loaded **before other scripts run in the page**."* `[E17]` |
| `webContents.executeJavaScriptInIsolatedWorld(worldId, scripts)` | **指定的隔离世界** | ❌ 不能 | *"Works like `executeJavaScript` but evaluates `scripts` in an isolated context."* `[E12]` |
| `webContents.executeJavaScript(code)` | **主世界**（= 页面自己的世界） | ✅ **能** | *"Evaluates `code` in page."* `[E12]` |

**第三行是这一节最重要的一条，而且文档没有明说。** `executeJavaScriptInIsolatedWorld` 的参数描述里写 *"`worldId` Integer - The ID of the world to run the javascript in, **`0` is the default world**, `999` is the world used by Electron's `contextIsolation` feature"* `[E12]`，已经蕴含了 `executeJavaScript` = world 0 = 主世界。源码可以坐实（`shell/browser/api/electron_api_web_frame_main.cc`，v43.4.1）`[E12]`：

```cpp
->ExecuteJavaScriptForTests(
    code, user_gesture, true /* resolve_promises */,
    /*honor_js_content_settings=*/true, content::ISOLATED_WORLD_ID_GLOBAL,
```

> **`executeJavaScript` 注入的代码与第三方页面的脚本共处同一个世界。页面可以 hook 你调用的任何内置函数——`Range.prototype.toString`、`Element.prototype.getBoundingClientRect`、`JSON.stringify` 全都可以被改。** 一个恶意站点完全可以让你的摘录存下与用户所选完全不同的文字。**选区叠层必须走 preload。**

`contextIsolation` 的确切语义（默认 **`true`**）`[E18]`：

> *"Whether to run Electron APIs and the specified `preload` script in a separate JavaScript context. **Defaults to `true`.** The context that the `preload` script runs in will only have access to **its own dedicated `document` and `window` globals**, as well as its own set of JavaScript builtins (`Array`, `Object`, `JSON`, etc.), which are all invisible to the loaded content… **This option uses the same technique used by Chrome Content Scripts.**"*

**最后那句是关键：Chrome Content Script 模型 = JS 全局对象与 builtins 分离，但 DOM 是共享的。** 所以选区叠层完全可以在 preload 的隔离世界里读 `document.getSelection()`、插 `<div>` 画高亮，而页面改不了我们的 `Array.prototype`。这正好是我们要的隔离级别。

样式用 `insertCSS(css, { cssOrigin: 'user' })` `[E19]`：

> *"`cssOrigin` string (optional) - Can be 'user' or 'author'. Sets the cascade origin of the inserted stylesheet. Default is 'author'."*

**`'user'` origin 的层叠优先级高于页面的 author 样式**，叠层不会被目标站点的 CSS 干掉。返回一个 key，用 `removeInsertedCSS(key)` 撤销。

**`sandbox: true`（默认，自 Electron 20）对 preload 的硬限制** `[E20]`——这是实现上最容易翻车的一条：

> *"A `require` function similar to Node's `require` module is exposed, but can only import a subset of Electron and Node's built-in modules: `electron` (following renderer process modules: `contextBridge`, `crashReporter`, `ipcRenderer`, `nativeImage`, `webFrame`, `webUtils`), `events`, `timers`, `url`"*

> *"Because the `require` function is a polyfill with limited functionality, you will not be able to use CommonJS modules to separate your preload script into multiple files. **If you need to split your preload code, use a bundler such as webpack or Parcel.**"*

**净后果：叠层 preload 里没有 `fs`、没有 `path`，一切落盘走 IPC 回主进程；而且必须打包成单文件。** 我们已经有 Vite，多加一个 preload entry 而已。

### 4.3 安全边界：官方清单 20 条

security 文档的清单是 **20 条**（不是常见说法里的 17–19 条）`[E3]`。全部列出，与我们相关的展开：

| # | 条目 | 默认值 | 我们要做什么 |
| --- | --- | --- | --- |
| 1 | Only load secure content | — | 只允许 `https:`，`http:` 至少要提示 |
| 2 | Do not enable Node.js integration for remote content | `nodeIntegration: false`（自 5.0.0 默认） | **保持**（现状已是 `[P1]`） |
| 3 | Enable context isolation | `contextIsolation: true`（自 12.0.0 默认） | **保持**（现状已是 `[P1]`） |
| 4 | Enable process sandboxing | `sandbox: true`（自 20.0.0 默认） | **保持**——但要意识到 §4.2 那条 preload 限制 |
| 5 | `ses.setPermissionRequestHandler()` | **默认全部批准！** | **必须自己写**，见下 |
| 6 | Do not disable `webSecurity` | `webSecurity: true` | **保持** |
| 7 | Define a Content-Security-Policy | — | 对第三方站点**不适用**（那是站点自己的事）；但要给**我们自己的**渲染进程加 |
| 8 | Do not enable `allowRunningInsecureContent` | `false` | 保持 |
| 9 | Do not enable experimental features | `experimentalFeatures: false` | 保持 |
| 10 | Do not use `enableBlinkFeatures` | — | 保持 |
| 11 | `<webview>`: Do not use `allowpopups` | — | 不用 `<webview>`，N/A |
| 12 | `<webview>`: Verify options before creation | — | 同上；但若将来开了 `webviewTag`，必须写 `will-attach-webview` |
| 13 | Disable or limit navigation | — | `will-navigate` / `will-frame-navigate` |
| 14 | Disable or limit creation of new windows | — | `setWindowOpenHandler`，默认 deny |
| 15 | Do not use `shell.openExternal` with untrusted content | — | 「在系统浏览器里打开」这个功能要验 URL |
| 16 | Use a current version of Electron | — | 43.4.0，OK |
| 17 | Validate the `sender` of all IPC messages | — | **每个 handler 验 `senderFrame`** |
| 18 | Avoid `file://`, prefer custom protocols | — | 我们已经走本机 HTTP server `[P1]` |
| 19 | Check which fuses you can change | — | 打包时的事 |
| 20 | Do not expose Electron APIs to untrusted web content | — | **叠层 preload 只暴露最小 API** |

**第 5 条要单独说，因为默认值是反直觉的** `[E21]`：

> *"**By default, Electron will automatically approve all permission requests** unless the developer has manually configured a custom handler."*

而且**两个 handler 都要写，不能共用一张表** `[E21]`：

> *"**you must also implement `setPermissionCheckHandler` to get complete permission handling.** Most web APIs do a permission check and then make a permission request if the check is denied."*

两者的 permission 取值列表**不同**：`check` 版多了 `hid` / `serial` / `usb` / `deprecated-sync-clipboard-read`，少了 `display-capture` / `window-management` / `keyboardLock` / `speaker-selection` `[E21]`。**对一个「读者随手开任意网站」的应用，正确的默认是全 deny，需要时再放行。**

**第 20 条对我们的叠层特别相关** `[E3]`：

> *"Exposing raw APIs like `ipcRenderer.on` is dangerous because it gives renderer processes direct access to the entire IPC event system… The first argument to IPC event callbacks is an `IpcRendererEvent` object, which includes properties like `sender` that provide access to the underlying `ipcRenderer` instance. Even if you only listen for specific events, passing the callback directly means the renderer gets access to this event object."*

即：`contextBridge` 里**不能**写 `onX: (cb) => ipcRenderer.on('x', cb)`，必须写 `onX: (cb) => ipcRenderer.on('x', (_event, value) => cb(value))`——**把 event 对象剥掉**。

**最后，三条必须原样引给决策者看的官方表态。**

（a）security 文档 Preface `[E3]`：

> *"be aware that **displaying arbitrary content from untrusted sources poses a severe security risk that Electron is not intended to handle**. In fact, the most popular Electron apps (Atom, Slack, Visual Studio Code, etc) display primarily local content… if your application executes code from an online source, it is your responsibility to ensure that the code is not malicious."*

（b）清单第 12 条结尾 `[E3]`：

> *"Again, this list merely minimizes the risk, but does not remove it. **If your goal is to display a website, a browser will be a more secure option.**"*

（c）sandbox 文档 `## A note on rendering untrusted content` `[E20]`：

> *"Rendering untrusted content in Electron is still somewhat uncharted territory… **Some security features in Chrome (such as Safe Browsing and Certificate Transparency) require a centralized authority and dedicated servers, both of which run counter to the goals of the Electron project. As such, we disable those features in Electron**, at the cost of the associated security they would otherwise bring."*

> **这一条要写进产品决策里，不是技术细节：我们做的「浏览器」没有 Safe Browsing、没有 Certificate Transparency，而且 Electron 官方明说这个场景不是它的设计目标。** 这不阻止我们做——Beaker Browser 就在文档里被点名为「有人做成了」的例子——但它意味着**默认应当只开我们信任的一小撮站点，「任意网站」是一个用户明确打开的开关，不是默认行为**。

### 4.4 跨源：iframe 读不到，但主进程能；截图有个坐标坑

**（1）注入的脚本读不到跨源 iframe。** 这是 Chromium 的同源策略，Electron 文档没有单独重述——唯一相关的官方表态是 `webSecurity` 的定义（*"When `false`, it will disable the same-origin policy"* `[E22]`）与 `<webview>` 那句 *"the behavior of `webview` is very similar to a cross-domain `iframe`"* `[E10]`。**别去关 `webSecurity`**（清单第 6 条）。

**（2）但主进程可以，而且官方示例就是这么演示的。** `webFrameMain` 文档给了两个例子 `[E14]`，一个是往 twitter.com 导航后的 frame 里注入并改 DOM，另一个是**枚举 reddit 页面里的 youtube 跨源子框架**：

```js
const youtubeEmbeds = win.webContents.mainFrame.frames.filter((frame) => {
  try {
    const url = new URL(frame.url)
    return url.host === 'www.youtube.com'
  } catch { return false }
})
```

**官方示例本身就在从主进程读取一个跨源子框架的 `frame.url` 并对其 `executeJavaScript`，没有任何同源检查。** 原因很简单：主进程持有的是浏览器侧的 `RenderFrameHost` 句柄，同源策略是渲染进程内的概念，管不到它。

遍历用 `frame.framesInSubtree`（*"containing every frame in the subtree of `frame`, including itself"*），当前聚焦的用 `webContents.focusedFrame`（*"the currently focused frame in this WebContents. Can be the top frame, an inner `<iframe>`, or `null`"*）`[E14]`——**后者对选区工具正合适：用户在哪个 iframe 里划选，就用哪个 frame 去执行。**

有一个生命周期陷阱要防 `[E14]`：

> *"`frame.detached` — A `Boolean` representing whether the frame is detached from the frame tree. If a frame is accessed while the corresponding page is running any unload listeners, it may become detached as the newly navigated page replaced it in the frame tree."*

**若要 preload 在每个 iframe 里都跑起来**（选区可能落在嵌入的视频、评论区里），唯一的开关是 `nodeIntegrationInSubFrames` `[E22]`：

> *"**Experimental option** for enabling Node.js support in sub-frames such as iframes and child windows. All your preloads will load for every iframe, you can use `process.isMainFrame` to determine if you are in the main frame or not."*

代价写在 `webContents.ipc` 的文档里 `[E23]`：

> *"In most cases, only the main frame can send IPC messages. However, if the `nodeIntegrationInSubFrames` option is enabled, it is possible for child frames to send IPC messages also. In that case, handlers should check the `senderFrame` property of the IPC event to ensure that the message is coming from the expected frame."*

**即：每个第三方 iframe（包括广告位）都拿到了 IPC 通道。** 于是清单第 17 条从「建议」变成「必须」。这个选项标着 Experimental。**建议先不开**——第一版只支持主框架内的选区，够用了。

**（3）`capturePage` 的坐标单位：文档没写，源码写了。**

签名 `[E24]`：

> *"`contents.capturePage([rect, opts])` — `rect` Rectangle (optional) - The area of the page to be captured. `opts.stayHidden` boolean (optional) - Keep the page hidden instead of visible. Default is `false`. `opts.stayAwake`… Returns `Promise<NativeImage>`. Captures a snapshot of the page within `rect`. Omitting `rect` will capture the whole visible page."*

而 `Rectangle` 结构文档**全文只有四行，没有任何单位说明** `[E25]`：

> *"`x` number - The x coordinate of the origin of the rectangle (**must be an integer**). `y` … `width` … `height` …"*

**这是官方文档的一个真实缺口。** 源码给出答案（`shell/browser/api/electron_api_web_contents.cc`，`WebContents::CapturePage`，v43.4.1）`[E13]`：

```cpp
// By default, the requested bitmap size is the view size in screen
// coordinates.  However, if there's more pixel detail available on the
// current system, increase the requested bitmap size to capture it all.
gfx::Size bitmap_size = view_size;
const float scale = display::Screen::Get()
                        ->GetDisplayNearestView(native_view)
                        .device_scale_factor();
if (scale > 1.0f)
  bitmap_size = gfx::ScaleToCeiledSize(view_size, scale);
```

**源码级结论，三条：**

1. **`rect` 是 DIP / screen coordinates**（与 `view->GetViewBounds()` 同一坐标系），**不是物理像素**。DIP 的官方定义在 screen 文档：*"Device-independent pixel (DIP) points are virtualized screen points scaled based on the DPI of the display."* `[E26]`
2. **返回的位图按 `device_scale_factor` 放大。** Retina（scale = 2）上请求 `400×300` 的 rect，实际 bitmap 是 `800×600` 物理像素。
3. 所以 **`image.getSize()` 返回 DIP 尺寸，`image.toBitmap()` 的 buffer 却是物理像素尺寸——HiDPI 下两者不相等**。用 `image.getScaleFactors()` 拿倍率对齐 `[E27]`。

**`rect` 还必须是整数**（`must be an integer` `[E25]`）——而浏览器里 `getBoundingClientRect()` 返回的是小数。**取整方向要一致**（建议 `floor(x), floor(y), ceil(right)-floor(x), ceil(bottom)-floor(y)`，宁可多截一像素也别少截），否则框选的边缘会被切掉。

还有一条 v43 的行为变更要记（`nativeImage.toBitmap()` 的 YAML history，PR 48178）`[E27]`：**`Normalized NativeImage.toBitmap() pixel data to sRGB by default.`** —— 如果将来要拿截图做像素级比对（§3 的感知哈希那条路），这个色彩空间归一化会影响结果。

**（4）最后一个坑：`capturePage` 只能截「可见的」那部分。** 文档原文 *"Omitting `rect` will capture the whole **visible** page"* `[E24]`。**滚动位置之外的内容截不到**——要截一个高过视口的框，得先滚动再分段截、自己拼。这对「整页截图当证据」那条路是实打实的工作量。


---

## 5. 结论：网页摘录的锚点该怎么设计

### 5.1 先把最重要的一句说死

**PDF 的锚点是一个坐标；网页的锚点是一次检索。** 差别不在精度，在**失败模型**：

| | PDF | 网页 |
| --- | --- | --- |
| 锚点是什么 | `{ page, rect }`，文件里的客观事实 | 一组**关于内容的描述**，下次要拿去**找** |
| 会不会失败 | 不会。失败 = bug | **会。失败是正常路径** |
| 失败了怎么办 | 修 bug | **要有状态、有 UI、有证据** |
| 谁判定对不对 | 不需要判定 | **需要裁判**（Hypothesis 用引文原文当裁判 `[H1]`） |

**现在的 `Anchor { page, rect }` `[P2]` 不能直接扩展到网页——不是字段不够，是它没有「可能找不到」这个概念。**

### 5.2 推荐的选择器组合与 fallback 顺序

存的时候（`describe`），**一条网页摘录同时写下四样**：

| # | 存什么 | 对应 W3C | 作用 | 会不会失效 |
| --- | --- | --- | --- | --- |
| 1 | `exact` + `prefix` + `suffix`（各 32 字符） | `TextQuoteSelector` `[W11]` | **唯一真正的锚点** | 原文被改写才失效 |
| 2 | `start` / `end`（正文字符偏移） | `TextPositionSelector` `[W1]` | **加速器 + 消歧先验**，不是锚点 | 页面一改就失效，**预期内** |
| 3 | CSS 选择器路径 | `CssSelector` `[W9]` | **加速器**：把搜索范围从整页缩到一个容器 | 改版就失效，**预期内** |
| 4 | 框内像素 + 正文快照 + 视口宽度 + 时间 | 规范里没有对应物 | **证据**，不是锚点 | 不会失效（它不参与定位） |

找的时候（`anchor`），顺序 **3 → 2 → 1**，**每一步的结果都要拿 1 去验**：

```
CssSelector 命中容器 → 在容器内找 exact       ┐
TextPositionSelector 给出 [start,end)         ├→ 逐字等于 exact？ 是 → anchored
                                              ┘                    否 → 继续退
全文模糊搜索 exact（prefix/suffix/position 打分）→ 分数 ≥ 阈值？ 是 → anchored
                                                              否但有候选 → fuzzy（要人确认）
                                                              无候选 → orphan
```

**四条理由：**

1. **「引文是锚点、其余是加速器」不是我的发明，是 Hypothesis 的架构，写在它源码注释里** `[H5]`：*"Annotations must have either a quote or a shape selector. For annotations of text, the quote is used to verify anchoring with other selector types."* 它的 `maybeAssertQuote` 会把前两条快路的结果拿去与 `exact` 逐字比对，不等就当失败 `[H1]`。**这是本文能找到的、经过最大规模实际使用检验的设计。**

2. **为什么用 `CssSelector` 而不是 Hypothesis 那个 XPath。** 它存的 `RangeSelector` 装的是 `/tag[index]/tag[index]` 形式的简化 XPath `[H3]`，对**结构位置**敏感——目标元素前面多插一个 `<div>`，索引全错。CSS 选择器可以带 `id` / `class` / `data-*`，**对结构不敏感、对语义敏感**。W3C 适用矩阵里 `text/html` 那行 CSS 与 XPath 都是 ✔︎ `[W5]`，规范地位相同。

   **这一条有实测支持，来自 Web 测试而不是标注领域** `[E34]`：Leotta 等人在 8 个开源 Web 应用的**相邻两个 release** 之间检验了 1,110 个定位符，绝对 XPath **78% 失效**、相对 XPath **50%**；前作在 2,735 个定位符上的分项更清楚——**`id` 失效 < 2%、链接文本 12%、Name/CSS 约 20%、XPath 67%**。原文 *"we found that id locators are the most robust, with less than the 2% of the 459 used id locators broken"*、*"67% of the 177 XPath locators were broken from a release to the next one"*。

   > **读法要克制两点：**（a）这是**相邻 release** 的数字，不是「改版」的数字——真正的重新设计只会更差，**这是下界**；（b）它量的是 Web 测试里的元素定位，不是标注锚定，**迁移过来是我的类比**。但方向足够硬：**带 `id` 的选择器比结构式路径稳一个数量级以上**，所以生成 `CssSelector` 时应当**优先取 `id` / 稳定 `data-*`，把 `:nth-child` 链当最后手段**。

3. **为什么 `TextPositionSelector` 明知会失效还要存。** 因为它**失效之后仍然有用**：Hypothesis 把它当模糊搜索的位置先验（`options.hint = position.start` `[H1]`），在「同一段文字页面上出现多次」时充当 tie-breaker。**成本是两个整数，收益是消歧。** 但要清楚极限：`posScore` 除以全文长度归一化 `[H8]`，**页面越长这一项越接近无用**。

4. **为什么不存 W3C 的 `RangeSelector`。** 它要求两端各嵌一个 Selector `[W4]`，复杂度翻倍，而我们的选区绝大多数落在同一个块级元素里——一个 `CssSelector` 指到容器就够了。

> **一条要写进代码注释的提醒：不要照抄 Hypothesis 的 `RangeSelector` 这个名字。** 它与 W3C 的 `RangeSelector` 同名不同物（`startContainer`/`endContainer` 字符串 vs `startSelector`/`endSelector` 嵌套对象）`[H2][W4]`。要么用 W3C 语义，要么换名字，**别制造第三种「RangeSelector」**。

### 5.3 具体参数：抄多少、改多少

| 参数 | Hypothesis 的值 `[H4][H8]` | 我们该用 | 理由 |
| --- | --- | --- | --- |
| `contextLen` | 32 | **32 照抄** | 实测：32 字符在中文里≈一整句，信息量远大于英文的 ~7 个词 `[M1]`。**这一条中文占便宜** |
| `maxErrors` | `min(256, quote.length / 2)` | **中文收紧到 `/4`** | 实测：21 字的中文摘录按原式允许改 **10.5** 个字 `[M1]`。**这是推测，无实测支持，见 §5.5** |
| 打分权重 | quote 50 / prefix 20 / suffix 20 / pos 2 | **照抄** | 没有数据支持改 |
| 分数阈值 | **没有**（有候选就采纳） | **要加一个** | 见下 |
| `ANCHORING_TIMEOUT` | 500 ms `[H9]` | 照抄 | — |

**「要加阈值」是我与 Hypothesis 的唯一实质分歧，理由是产品形态不同：**

Hypothesis 是**公共标注层**——锚错了，用户看到高亮划在旁边一句上，自己会发现，代价小。我们是**个人知识库**：摘录会被 `promote` 进知识图谱、切块做 embedding、被检索出来当证据 `[P2]`。**一条锚错的摘录会污染下游一整条链路，而且没人会去核对。** 宁可多几个 orphan，也不要静默的错锚。

**具体建议：`normalizedScore < 0.7` 不自动采纳，降级成 `fuzzy` 状态、要人确认。这个 0.7 是我拍的，没有任何一手数据支持——见 §5.5。**

### 5.4 文字区域与图片区域：必须分成两条路

最硬的证据是**业界最大的实现在普通网页上根本不做图片区域**（§3.2），而 W3C 适用矩阵里 `text/html` 那行 `SvgSelector` 是 ✘ `[W5]`——**规范里压根没有「网页上的任意矩形」。**

好消息是：**我们已经有 ADR-0016 那条分流，它在网页上同样成立** `[P3]`：

> *"选择方式由**拖动起点**推断：起点落在文字上走文本流（跟阅读顺序、可跨行），落在空白或图上走矩形。"*

这条决策原本是为了解决「矩形跨行会框进邻行的字」，**但它恰好也是网页锚点唯一可行的分流点**：

| 起点落在 | 走哪条 | 锚点 | 失效模型 |
| --- | --- | --- | --- |
| **文字上** | 文本流选区 | §5.2 的四件套 | 会失效，但有三级 fallback |
| **图 / canvas / 空白** | 矩形 | §3.4 的 A/B/C 三档 | **C 档没有锚点，只有证据** |

**两条硬约束：**

1. **C 档必须在 UI 上与 A/B 档区分开。** 一条永远回不去的摘录，不该和能回去的长得一样。
2. **要抄 `ShapeSelector.text` 那条后门**（把框内文字一并存下，`[H13]`），**但必须换掉 `/\b/` 的切词方式**——实测它在中文上把整个文本节点当成一个不可分的词 `[M1]`。

### 5.5 数字：哪些是已知的，哪些没人量过

**这一节是本文最重要的部分。凡是下面「没人量过」的，任何人（包括我）给出的数都是猜的。**

#### 已知、有出处的数字

| 数字 | 是什么 | 出处 |
| --- | --- | --- |
| **22%**（4,360 / 20,133） | 2015 年 8 月 Hypothesis 全站带引文的标注中，**被标注的文字已不再逐字出现在页面上**的比例。**这是逐字子串搜索的结果，不是模糊锚定的结果**，是「页面变了」的上界 | `[E6]` |
| **19%**（3,813 / 20,133） | 上述扣掉能从 web archive 救回的之后 | `[E6]` |
| **10%**（1,966 / 20,133） | 目标页已 4xx/5xx（**纯链接腐烂，与锚点无关**） | `[E6]` |
| **11.9%**（2,394 / 20,133） | 「页面还在、文字逐字找不到」——**我从上面两个数相减得到的，论文没有直接给** | 我的算术，基于 `[E6]` |
| **53%**（8,357 / 15,773） | 仍贴得上、但**没有任何存档副本**。量的是「有没有存档」，**不是「会不会失败」** | `[E6]` |
| **27.3%** / n=6,281 | 同作者前作（TPDL 2015，2015 年 1 月语料）的 orphan 率 | `[E6]` |
| **0.64% / 1.16%** | Hypothesis 官方 `anchoring-test-tools` 仓库 2019-09 那批 **235 个 PDF URL** 的 orphan 比例。**四个折扣见 §2.6.2**：是核查者的算术（官方从未表述过比率）、分布极偏（中位数为 0，单个 URL 贡献 48 里的 33）、加载失败的不在分母里、**语料只有 PDF 不含 HTML** | `[E28]` |
| **98.4%**（742 / 754） | Phelps & Wilensky 2000 在 **Unix man page** 语料上的自动重定位成功率。作者自陈是 *"prototype, less sophisticated implementation"* 且 *"no substitute for actual measurement"* | `[E29]` |
| **每周 ~3%** | 1.5 亿网页、11 周，发生**实质性**改动的比例 | `[E7]` |
| **76.35%**（241,091 条） | 学术论文 URI 引用的 content drift 比例（1997–2012） | `[E8]` |
| **< 2% / 12% / ~20% / 50% / 67–78%** | `id` / 链接文本 / Name·CSS / 相对 XPath / 绝对 XPath 在**相邻两个 release** 间的失效率（n = 1,110 与 2,735，8 个 Web 应用）。**是 Web 测试领域的数，迁移到标注是我的类比；且「相邻 release」是下界** | `[E34]` |
| **crop 时 pHash 精确匹配 0.043% / PDQ 0.000%**；**scale 时 pHash 94% / blockhash 85%** | 感知哈希在各类形变下的存活率（Flickr 1M）。**缩放几乎无损，裁剪与加边框直接崩到噪声底** | `[E33]` |
| **16.2% / 45%** | 首页图片缺 `alt` 的比例（WebAIM Million 2026，6,660 万张图 / 排除 `alt=""`）与 `<img>` 无 alt 的比例（Web Almanac 2024，口径不同，两个都列） | `[E35][E36]` |
| **42% / 9.3% / ~35%** | 移动端页面用 `srcset` / `<picture>` / `loading=lazy` 的比例（Web Almanac 2024） | `[E36]` |
| **32 / 50 / 20 / 20 / 2 / 500 ms / `min(256, len/2)`** | Hypothesis 的全部锚定常量 | 源码 `[H4][H8][H9]` |
| **2 处** | W3C Data Model 全文提及选择器鲁棒性的实质次数（唯一定性评价是 `TextPositionSelector` *"very brittle"*） | `[W1]` |

#### 没人量过的（**不要用猜测填空**）

| 问题 | 状态 |
| --- | --- |
| **Hypothesis 真实的 orphan 率** | ❌ **官方从未公布过任何比率。** 博客《Fuzzy Anchoring》没有一个评测数字 `[E9]`；`product-backlog#954` 里承诺过「I will now gather data」，**数据从未出现**，且该 issue 已 CLOSED `[E5]` |
| **模糊匹配能从那 22% 里救回多少** | ❌ **本文最想要而没拿到的数。** ODU 那两篇用的是逐字匹配，模糊锚定的增量**无人量过** |
| **`TextQuoteSelector` vs `TextPositionSelector` 的成功率对照** | ❌ **没有任何公开实验。**「引文比偏移更耐改版」是演绎，不是实测 |
| **`CssSelector` vs `XPathSelector` 在**标注**场景的抗改版能力** | ⚠️ **间接有数**（Web 测试领域，见上表 `[E34]`），**但没有人在标注场景直接量过**。把它迁移过来是我的类比 |
| **W3C 的选择器健壮性排序** | ❌ **规范从来没有发布过** `[W1][W16]`。任何形如「TextQuote > CSS > XPath > TextPosition」的排序都是社区经验，不是 W3C 立场 |
| **网页（HTML）标注的失效率** | ❌ 唯一的官方原始数据只有 PDF `[E28]`；ODU 那两篇混着 HTML 与 PDF 但**没分开报** `[E6]` |
| **中文网页上引文匹配的表现** | ❌ **一条都没有。** §5.3 那个 `maxErrors` 改成 `/4`、§5.3 那个 0.7 阈值，**全是我拍的** |
| **图片区域重新锚定的成功率** | ❌ **无从量起——没有人在做这件事**（§3.3）。唯一系统描述该方案的是一份 **Abandoned 的微软专利** `[E30]` |
| **感知哈希在真实改版场景下的表现** | ⚠️ **形变层面有数**（`[E33]`，且结论是负面的：裁剪/加边框必崩）；但**没有任何标注系统在用，所以没有场景内的端到端测量** |
| **懒加载 / `srcset` 下图片 URL 的稳定性** | ⚠️ **普及率有数**（`srcset` 42%、`<picture>` 9.3%、`loading=lazy` ~35%，`[E36]`），**但「同一张图的 URL 在多久内会变」没有任何公开统计** |
| **CDN 资源 URL 的实际 churn 率** | ❌ 没有公开数据 |

### 5.6 哪些情况必然失效，代价是什么

**每一条都是「必然」，不是「可能」。**

| 情况 | 为什么必然 | 代价 |
| --- | --- | --- |
| **原文被改写** | `exact` 找不到，模糊搜索也超容差 | **变 orphan。任何方案都一样。** 但摘录内容本身还在（我们存了原文与截图） |
| **整页重写 / 站点关停 / 付费墙** | URL 还在，内容没了。**实测占比约 10%** `[E6]` | 同上。**唯一补救是我们自己存了什么** |
| **`TextPositionSelector` 失效** | 页面任何增删都会挪动偏移 | **零代价**——它本就只是加速器 |
| **`CssSelector` 失效** | 改版必然改 class / 结构 | **零代价**——同上 |
| **纯图片框、图片 URL 变了** | CDN 换 hash、`srcset` 换档、懒加载占位 | **必然失效且没有 fallback。这条摘录永远回不去原位** |
| **窗口宽度变了** | 响应式重排 | 文字**无影响**（引文与偏移都与布局无关）；**矩形是致命的** |
| **同一段文字多次出现且上下文相同** | 打分区分不开 | 位置项兜底，但长页面上位置项接近无效 `[H8]`。**可能锚到另一处** |
| **跨源 iframe 里的选区** | 页面内脚本读不到 `[E22]` | 第一版**不支持**（只做主框架）。要支持得开 `nodeIntegrationInSubFrames`，代价是每个第三方 iframe 拿到 IPC 通道 `[E22][E23]` |
| **高过视口的框** | `capturePage` 只截可见部分 `[E24]` | 要滚动分段截再拼。**工作量实打实** |

**一条必须写进产品说明的话：**

> **网页摘录不保证能回到原位。它保证的是：原文逐字、当时的截图、当时的 URL 与时间。「跳回原文」是尽力而为的功能，不是承诺。**

这不是妥协，是**唯一诚实的说法**——连规范给「文档会变」开的药方都不是让选择器更聪明，而是「记下当时是哪一版，然后把那一版取回来」（`State` / `TimeState`，`[W15]`）；ODU 那篇论文的结论也是同一句：*"This points to the need for archiving the target of an annotation at the time the annotation is created."* `[E6]`

### 5.7 分档方案

**档 0 —— 先把失败变成一等状态（在写任何选择器之前做）**

**做什么：** 给摘录加锚定状态，与现有的 `state` / `important` 两根轴正交：

```ts
type AnchorStatus = "anchored" | "fuzzy" | "orphan" | "pending";
```

抄 Hypothesis 的三态 `[H9]` 再加一个 `fuzzy`（模糊命中但分数不够，需确认）。UI 上 orphan 单独一栏、引文打码——也是抄它的 `[H10]`。

**前提：** 无。纯模型改动。**代价：** 很小。**但这一档不做，后面全白做**——没有地方安放「找不到」这个结果。

---

**档 1 —— 文字摘录：四件套 + 三级 fallback**

**做什么：** §5.2 那张表逐条实现。`matchQuote` 可以照 `approx-string-match` 自己写（Hypothesis 的 `match-quote.ts` 只有 163 行 `[H8]`）。

**前提：** 档 0。**代价：** 一个零依赖的小库 + 两个纯函数（`describe` / `anchor`），可测试、不进 `app/react/`。

---

**档 2 —— 存证据：把「回不去」的代价降到最低**

**做什么：** 三样，按性价比排序：

1. **框内像素**——**已经有了**（`Region.pixels` `[P2]`）。**这是我们相对 Hypothesis 的结构性优势**：它是 Web 服务，存不起每条标注的截图；我们是 local-first 桌面应用，**本来就在存**。Zotero 对图像标注也正是这么做的 `[E31]`。
2. **正文全文快照**（纯文本）。几十 KB/页，是 orphan 之后唯一能「在当时的页面里重新搜」的东西。**这正是规范 `State` 那条路的本地版** `[W15]`，也是 ODU 论文的结论 `[E6]`。**注意：仓库现在没有 Readability 一类的依赖**（实测 `package.json` 无 `readability`/`cheerio`/`turndown`），这一步要新增一个依赖；好在叠层 preload 里有真实 DOM，可以直接跑。
3. **抓取时的视口宽度 + 时间戳 + 跟完重定向的最终 URL。**

**前提：** 档 0。与档 1 独立，**可以并行做**。**代价：** 磁盘（正文快照几十 KB、截图几百 KB），对本地应用可忽略。

> **这一档的价值判断和别处不一样：它不提高锚定成功率，它降低锚定失败的代价。而既然 §5.5 说明「成功率没人量过」，降低失败代价是比提高成功率更可靠的投资。**

---

**档 3 —— 图片/区域：按 §3.4 的 A/B/C 三档，且必须标注为「弱锚点」**

**前提：** 档 2（C 档完全依赖证据）。**代价：** A/B 两档各自的换算逻辑；C 档几乎零成本（本来就存截图），**但要老实告诉读者它回不去**。

---

**明确不做的三件事：**

1. **不做「感知哈希重新定位」。** 唯一系统描述它的是一份 **Abandoned 的微软专利** `[E30]`，现役标注系统一个都没在用（§3.3）。
2. **不开 `nodeIntegrationInSubFrames`。** 官方标着 Experimental `[E22]`，代价是所有第三方 iframe 拿到 IPC 通道 `[E23]`。第一版只支持主框架选区。
3. **不做「任意网站」的默认开放。** 官方明说 *"If your goal is to display a website, a browser will be a more secure option"*，且 Safe Browsing / Certificate Transparency 在 Electron 里是关掉的 `[E3][E20]`。**默认只开用户显式添加的站点。**

---

## Sources

### W3C 规范原文

> 全部为 2026-08-20 抓取。Data Model 与 Vocabulary 均为 **W3C Recommendation 23 February 2017**；Media Fragments 为 **W3C Recommendation 25 September 2012**；Selectors and States 为 **W3C Working Group Note 23 February 2017**。

- `[W1]` `TextPositionSelector` 的定义、字段与那句 `very brittle` 的 Note：`https://www.w3.org/TR/annotation-model/#text-position-selector`。原文 *"…but is very brittle with regards to changes to the resource. Any edits or dynamically transcluded content may change the selection, and thus it is RECOMMENDED that a State be additionally used…"*。`start`/`end` 的 `xsd:nonNegativeInteger` 约束见 `https://www.w3.org/TR/annotation-vocab/#start`、`#end`。
- `[W2]` `selector` 属性本身的定义与「多选择器」的全部规范文本：`https://www.w3.org/TR/annotation-model/#selectors`。原文 *"There MAY be 0 or more selector relationships associated with a Specific Resource. Multiple Selectors SHOULD select the same content, however some Selectors will not have the same precision as others. Consuming user agents MUST pick one of the described segments, if they are different."*；导言里那句 *"Multiple Selectors can be given to describe the same Segment in different ways in order to maximize the chances that it will be discoverable later…"*。**对全文 grep `'"selector": \['` 零命中——规范没有多选择器数组的示例。**
- `[W3]` 规范里全部三条「推荐组合」：TextPosition+State（`[W1]`）、FragmentSelector 优于裸 IRI fragment（`[W8]`）、RangeSelector 两端同类（`[W4]`）。**穷举，没有第四条。** 1.3 Conformance 节的 *"all authoring guidelines, diagrams, examples, and notes in this specification are non-normative"* 见 `https://www.w3.org/TR/annotation-model/#conformance`。
- `[W4]` `RangeSelector`：`https://www.w3.org/TR/annotation-model/#range-selector`。字段是 `startSelector` / `endSelector`，**值为嵌套的 Selector 对象**；*"There MUST be exactly 1 startSelector associated with a Range Selector."*、*"Both startSelector and endSelector SHOULD be of the same class."*；语义左闭右开。JSON key → 谓词映射（`oa:hasStartSelector` / `oa:hasEndSelector`）见 `[W7]`。
- `[W5]` 「媒体类型 × 选择器」适用矩阵：`https://www.w3.org/TR/annotation-model/#media_selector`（附录 A），规范效力由 `https://www.w3.org/TR/annotation-model/#conformance-requirements-related-to-selectors`（1.3.1）赋予——*"A conforming implementation MUST implement that particular combination if it handles the corresponding media type."* / *"A "✘" sign… Conforming implementations SHOULD ignore that particular combination."*。**本文自行抓取 HTML 并解表核对**（`curl` + 解析 `<tr>`）：`HTML (text/html)` 行 = Fragment ✔︎ / CSS ✔︎ / XPath ✔︎ / TextQuote ✔︎ / TextPosition ✔︎ / DataPosition ✘ / **Svg ✘**；`Image, other than SVG (image/gif, image/jpeg, image/png, image/tiff)` 行 = Fragment ✔︎ / CSS ✘ / XPath ✘ / TextQuote ✘ / TextPosition ✘ / DataPosition ? / **Svg ✔︎**；`PDF (application/pdf)` 行 = Fragment ✔︎ / CSS ✘ / XPath ✘ / TextQuote ✔︎ / TextPosition ✔︎ / DataPosition ✘ / Svg ✘。
- `[W6]` Media Fragments URI 1.0 的 `xywh` 语法：`https://www.w3.org/TR/media-frags/#naming-space`（4.2.2 Spatial Dimension）。原文 *"Rectangle selection is denoted by the name xywh. The value is an optional format pixel: or percent: (defaulting to pixel) and 4 comma-separated integers. The integers denote x, y, width and height, respectively, with x=0, y=0 being the top left corner of the image."*；ABNF `xywhparam = [ xywhunit ":" ] 1*DIGIT "," 1*DIGIT "," 1*DIGIT "," 1*DIGIT` 见 `https://www.w3.org/TR/media-frags/#collected-syntax-uri`——**`1*DIGIT` 即只允许非负整数**。越界裁剪规则见 `#valid-uri-spatial`（6.1.2），非法情形见 `#error-media-spatial`（6.3.3，左上角越界 SHOULD ignore）与 `#error-uri-spatial`（6.2.3，`xywh=4,5,0,3` 因零宽/零高非法）。多分辨率图像：*"If the clipping region is pixel-based and the image is multi-resolution (like an ICO file), the fragment MUST be ignored"*。
- `[W7]` JSON-LD context（JSON key 的权威映射）：`http://www.w3.org/ns/anno.jsonld`。
- `[W8]` `FragmentSelector`：`https://www.w3.org/TR/annotation-model/#fragment-selector`。*"A resource which describes the Segment through the use of the fragment component of an IRI."*；`value` MUST、`conformsTo` SHOULD；`conformsTo` 候选表（含 `Media | http://www.w3.org/TR/media-frags/ | Example: xywh=50,50,640,480` 与 `PDF | http://tools.ietf.org/rfc/rfc3778 | Example: page=10&viewrect=50,50,640,480`）；*"It is RECOMMENDED to use FragmentSelector… rather than using the IRI with a fragment directly."*。裸 IRI fragment 的两条告诫见 `https://www.w3.org/TR/annotation-model/#iris-with-fragment-components`。
- `[W9]` `CssSelector`：`https://www.w3.org/TR/annotation-model/#css-selector` 与 `https://www.w3.org/TR/annotation-vocab/#cssselector`。*"A CssSelector describes a Segment of interest in a representation that conforms to the Document Object Model through the use of the CSS selector specification."*；`value` MUST，无其他字段；Note *"Implementers SHOULD use only commonly supported features of CSS that directly contribute to selection of an element or content, rather than styling or transformation, in order to maximize interoperability between systems."*
- `[W10]` `XPathSelector`：`https://www.w3.org/TR/annotation-model/#xpath-selector` 与 `https://www.w3.org/TR/annotation-vocab/#xpathselector`。`value` MUST；HTML5 parser 的 Note 原文 *"Implementers should note that the HTML5 specification allows parsers to add elements into the DOM that are considered to be missing. XPaths SHOULD be constructed to include these elements, rather than from the element structure in the document."*
- `[W11]` `TextQuoteSelector`：`https://www.w3.org/TR/annotation-model/#text-quote-selector`。`exact` MUST / `prefix` SHOULD / `suffix` SHOULD；三条规范性要求（unicode code points 而非 code units、logical order、normalization）与那条 *"If, after processing the prefix, exact, and suffix, the user agent discovers multiple matching text sequences, then the selection SHOULD be treated as matching all of the matches."*
- `[W12]` `DataPositionSelector`：`https://www.w3.org/TR/annotation-model/#data-position-selector`。*"…works at the byte in bitstream level rather than the character in text level."*
- `[W13]` `SvgSelector`：`https://www.w3.org/TR/annotation-model/#svg-selector`。`type` 那条写的是 **`MUST include SvgSelector`**（全规范唯一允许多值 type 者）；`value` 是 **MAY**；坐标系约束原文 *"The dimensions of the SVG shape or canvas MUST be relative to the dimensions of the Source resource, such that scaling the shape's size to the full size of the image correctly describes the desired area."*；*"It is NOT RECOMMENDED to include style information within the SVG element, nor Javascript, animation, text or other non-shape oriented information."*。**规范的两个示例（Example 26 外链式、Example 27 内嵌式）里 SVG 内容都是 `"<svg:svg> ... </svg:svg>"` 占位，没有给出完整可运行的 polygon 实例。**
- `[W14]` `refinedBy`：`https://www.w3.org/TR/annotation-model/#refinement-of-selection` 与 `https://www.w3.org/TR/annotation-vocab/#refinedby`。*"The relationship between a broader selector and the more specific selector that SHOULD be applied to the results of the first. A Selector MAY be refinedBy 1 or more other Selectors. If more than 1 is given, then they are considered to be alternatives that will result in the same selection."* Example 29（FragmentSelector `refinedBy` TextQuoteSelector）同页。
- `[W15]` States：`https://www.w3.org/TR/annotation-model/#states`。*"Web resources change over time, and a State might be used to describe how to recover the intended previous version."*；`TimeState` 见 `#time-state`。
- `[W16]` Selectors and States（**W3C Working Group Note**，非 Recommendation）：`https://www.w3.org/TR/selectors-states/`。自述原文 *"This document does not define any new approach to selection… The current document only "extracts" Selectors and States from that data model."*（`#abstract`）；地位声明 *"Publication as a Working Group Note does not imply endorsement by the W3C Membership."*（`#sotd`）。**对其全文做同样的 robustness grep，命中与 Recommendation 完全相同的两句，无新增论述。**
- `[W17]` Web Annotation Protocol：`https://www.w3.org/TR/annotation-protocol/`。**全文 `grep -ci selector` = 0**——它只管 HTTP 层的 CRUD 与容器，对选择器的选择与鲁棒性没有任何表述。
- **已下线的来源，特此记录**：Open Annotation Community Group 的 `http://www.openannotation.org/spec/core/` 已不可用（HTTP 版返回服务商错误页，HTTPS 版返回空 body）。**它不再是可引用的一手来源。**

### Hypothesis 源码（本机 clone，完整历史）

> `github.com/hypothesis/client`，`HEAD = b4d085a2f893aa6de3b61d8b8bc3ae4d0f24fc1a`（2026-07-30），`git fetch --unshallow` 后共 **15,652** 个提交。行号对应该 commit。

- `[H1]` 锚定与描述的核心：`src/annotator/anchoring/html.ts`。`anchor()` 在 :36-113（`promise.catch()` 链，注释原文 *"From a default of failure, we build up catch clauses to try selectors in order, from simple to complex."*；`maybeAssertQuote` 在 :68-74；`options.hint = position.start` 在 :51）；`describe()` 在 :115-134（`types = [MediaTimeAnchor, RangeAnchor, TextPositionAnchor, TextQuoteAnchor]`，逐个 try，失败静默跳过）。
- `[H2]` 选择器的确切类型：`src/types/api.ts:58-88`（`TextQuoteSelector` / `TextPositionSelector` / `RangeSelector`）。`TextPositionSelector` 的类型注释原文 *"Selector which identifies a document region using **UTF-16 character offsets** in the document body's `textContent`."* —— **与 W3C 要求的 unicode code points 不一致**（`[W11]`）。`Selector` 联合类型在 :226-233，含 `EPUBContentSelector` / `MediaTimeSelector` / `PageSelector` / `ShapeSelector`。
- `[H3]` 简化 XPath：`src/annotator/anchoring/xpath.ts`。`xpathFromNode` 在 :37-52（产出 `/tag[index]/tag[index]`）；`evaluateSimpleXPath` 在 :96-137，其 JSDoc 原文 *"A _simple XPath_ is a sequence of one or more `/tagName[index]` strings. Unlike `document.evaluate` this function: - Only supports simple XPaths - Is not affected by the document's _type_ (HTML or XML/XHTML) - Ignores element namespaces… - Is case-insensitive for all elements, not just HTML elements"*；`nodeFromXPath` 在 :145-164（先试 simple，抛错才退回 `document.evaluate('.' + xpath, …)`）。
- `[H4]` `contextLen = 32`：`src/annotator/anchoring/types.ts:190-199`，注释原文 *"Number of characters around the quote to capture as context. We currently always use a fixed amount, but it would be better if this code was aware of logical boundaries in the document (paragraph, article etc.) to avoid capturing text unrelated to the quote… We could use `Intl.Segmenter` for this when available."* 同文件 :28-99 是 `RangeAnchor`（`toSelector()` 产出 `startContainer`/`startOffset`/`endContainer`/`endOffset`），:104-142 是 `TextPositionAnchor`，:157-258 是 `TextQuoteAnchor`。
- `[H5]` 「必须有 quote 或 shape」这条规则：`src/annotator/guest.ts:891-916`。JSDoc 原文 *"Annotations must have either a quote or a shape selector. For annotations of text, the quote is used to verify anchoring with other selector types."*；判定是 `target.selector.some(s => s.type === 'TextQuoteSelector' || s.type === 'ShapeSelector')`，为假直接返回无 region 的空 anchor。
- `[H6]` 模糊匹配算法的变迁（`git log -S` 实测）：`cd5586afe`（2013-03-04，*"Fuzzy anchoring finally fully functional."*）→ `4eb465065`（2015-05-21，*"Use vanilla diff-match-patch"*，删掉自 fork 的 `dom_text_matcher.js` / `text_match_engines.js` 共 2,702 行）→ `4d0019c94`（2015-07-14，*"Switch to new standalone anchoring libs"*）→ `fc73d74a5`（2020-05-26，*"Remove unused diff-match-patch dependency"*）→ **`d2e9f195c`（2020-12-10，Robert Knight，*"Add new fuzzy quote matching implementation"*）** → `5d43b47bd`（2020-12-01，*"Remove unused dom-anchor-text-quote dependency"*）。`d2e9f195c` 的提交信息原文见 §2.3。**历史上的 dmp 参数**（`git show 4eb465065:h/static/scripts/annotator/anchoring/types.coffee`，:213-248）：引文按 `/(.|[\r\n]){1,32}/g` 切成 32 字符片；首锚 `dmp.Match_Distance = root.textContent.length * 2`，随后 `dmp.Match_Distance = 64`；**`Match_Threshold` 从未显式设置**（用 diff-match-patch 默认值）。**现仓库全文 `grep -rn "diff-match-patch\|diff_match_patch"` 命中 0 次（实测）。**
- `[H7]` `approx-string-match` 依赖：`package.json:50`，`"approx-string-match": "^2.0.0"`（在 `devDependencies` 里——该仓库无 `dependencies`，一切打进 bundle）。
- `[H8]` 现行模糊匹配实现：`src/annotator/anchoring/match-quote.ts`（全文 163 行）。`maxErrors = Math.min(256, quote.length / 2)` 在 :99，其上 :90-98 是权衡注释；`search()` 的 `indexOf` 快路在 :21-44（**有精确命中就完全不跑近似搜索，且返回全部位置**）；权重 `quoteWeight = 50` / `prefixWeight = 20` / `suffixWeight = 20` / `posWeight = 2` 在 :112-115；`posScore = 1.0 - offset / text.length` 在 :136-139；`scoredMatches.sort((a, b) => b.score - a.score); return scoredMatches[0]` 在 :161-162。**无分数阈值**：仅在 `quote.length === 0`（:86）与 `matches.length === 0`（:104）时返回 `null`。
- `[H9]` 锚定超时与三态：`src/sidebar/store/modules/annotations.ts:314`，`const ANCHORING_TIMEOUT = 500;`，注释原文 *"If anchoring fails to complete in a reasonable amount of time, then we assume that the annotation failed to anchor. If it does later successfully anchor then the status will be updated."*；`type AnchorStatus = 'anchored' | 'orphan' | 'timeout'` 在 :21。
- `[H10]` orphan 的 UI 处理：`src/sidebar/components/SidebarTabs.tsx:189-197`（单独 tab）；`src/sidebar/components/Annotation/AnnotationQuote.tsx:22-27`（`isOrphan` 时给引文加 `p-redacted-text` 打码）；`src/sidebar/helpers/annotation-metadata.ts:106-109`（`isOrphan` = `hasSelector(annotation) && annotation.$orphan === true`）。
- `[H11]` **普通网页上不支持图片/区域框选**：`src/annotator/integrations/html.ts:117-123`，`describe(root, region)` 中 `if (region instanceof Range) { return describe(root, region); } else { throw new Error('Unsupported region type'); }`；`supportedTools()` 在 :193-195，`return ['selection'];`。`vitalsource.ts:446-448` 同样只有 `['selection']`。
- `[H12]` **PDF 上才有 shape，而且要 feature flag**：`src/annotator/integrations/pdf.tsx:504-511`，`const imageAnnotation = this._features?.flagEnabled('pdf_image_annotation'); if (imageAnnotation) { return ['selection', 'rect', 'point']; } else { return ['selection']; }`。
- `[H13]` `ShapeSelector` 的完整定义：`src/types/api.ts:139-222`。`RectShape = { type: 'rect'; left; top; bottom; right }`、`PointShape = { type: 'point'; x; y }`；`ShapeSelector = { type; shape; anchor?: 'page'; view?: {left,top,right,bottom}; text?: string }`。坐标系的 JSDoc 原文 *"Shape selectors should be defined using the natural coordinate system for the anchor element in the document, enabling an annotation made in one viewer to be resolved to the same location in a different viewer, with different view settings (zoom, rotation etc.)… - For PDFs, PDF user space coordinates (points), with the origin at the bottom-left corner of the page. - For images, pixels with the origin at the top-left"*；`text` 字段的注释是 *"The text contained inside this shape."*。**注意 `anchor` 的取值只有 `'page'` 一种**（*"Supported values: - "page" - The page identified by the annotation's PageSelector."*）——**没有「HTML 元素」这个取值**。
- `[H14]` shape 的产出与锚定：`src/annotator/anchoring/pdf.ts`。`describe` 的 rect 分支在 :880-920（用 `mapViewportToPDF` 换到 PDF user space、`pageBoundingBox(pageView.pdfPage)` 填 `view`、`textFromRect(textLayer, rect)` 填 `text`）；`anchor()` 在 :613-630（**`if (shapeSelector && !pageSelector) throw new Error('Cannot anchor a shape selector without a page')`**）；`anchorShape()` 在 :637+（`viewport.convertToViewportPoint` 再除以 `viewport.width/height` 归一到 0–1，`clamp` 在 :632）。
- `[H15]` 框内取文字：`src/annotator/anchoring/text-in-rect.ts`（全文 59 行）。`textInDOMRect(root, rect)`——`NodeIterator` 遍历文本节点，**`textNode.data.split(/\b/)` 按词边界切**，逐词 `range.getBoundingClientRect()` 与 rect 求交。注释原文 *"We split on word boundaries here rather than spaces, so inter-word spaces are included in the "words"."*
- `[H16]` `ShapeSelector` 的引入与其明确边界：提交 `cae60a329`（**2025-04-04**，Robert Knight，*"Generate shape selectors for rect and point annotations in PDFs"*）。信息原文含 *"Add a new `ShapeSelector` selector type which represents a 2D region of a document."*、*"Support describing (ie. serializing) shapes in the PDF integration"*、***"Throw exceptions in the HTML and VitalSource integrations if passed a shape, since that is not yet supported."***，以及 *"Anchoring of this selector is not yet implemented, so the annotation will become an orphan after the page is reloaded."* 后续提交 `2add3329a`（2025-04-16，*"Record viewbox coordinates and anchor type in shape selectors"*）加入 `view` 与 `anchor` 字段。相关 feature flag 的引入是 `21f938989`（2025-03-27，*"Show rectangle annotation button when `pdf_image_annotation` feature is enabled"*）。**至本文所读的 HEAD（2026-07-30），十六个月后 HTML 侧仍是 `throw`、PDF 侧仍在 flag 后。**

### 本机实测

- `[M1]` **CJK 下 Hypothesis 三个常数的行为实测**（Node v24，2026-08-20）：① `"第三章 进程与线程，本章讨论调度器的实现。".split(/\b/)` 返回 **`["第三章 进程与线程，本章讨论调度器的实现。"]`——整串一个元素**（JS 的 `\b` 基于 ASCII `\w`，CJK 字符之间没有词边界）；同一句英文切成 20 个元素。**这意味着 `[H15]` 的 `textInDOMRect` 在中文上退化成「整个文本节点一个外接矩形」，无法在词级与 rect 求交。** ② `contextLen = 32` 在中文里是 32 个汉字（≈一整句），在英文里 `"the quick brown fox jumps over t"` 只有 7 个词——**同样的常数，中文拿到的信息量大得多**。③ `maxErrors = min(256, len/2)`：一条 21 字的中文摘录允许 **10.5** 个编辑距离。④ 增补平面汉字 `"𠮷野家"`：`String.length` = **4**（UTF-16 code unit），code point = **3**——`[W11]` 要求用后者，`[H2]` 的注释用的是前者。

### 本仓库现状（实测读取）

- `[P1]` Electron 与窗口配置：`package.json` 的 `electron` 为 `^43.4.0`，`node_modules/electron/package.json` 实装 **43.4.0**；`pdfstudio/electron/main.ts:142-146` 的 `webPreferences` 只有 `nodeIntegration: false, contextIsolation: true`——**没有 `preload`、没有 `sandbox` 显式值（默认 `true`）、没有 `webviewTag`（默认 `false`）**；同文件有本机 HTTP server（`createServer` / `server.listen(0, "127.0.0.1")`）。
- `[P2]` 摘录的领域模型：`pdfstudio/src/recognizer/recognizer.ts` —— `Rect { x, y, width, height }`（注释 *"页面坐标，原点左下"*）、`Screenshot { mime, bytes, width, height }`、`Region { page, rect, pixels: Screenshot, lines?: Rect[] }`、`Anchor { page, rect }`、`ClipContent { route, anchor, sourceText, translation?, multimodal?, images, screenshot }`；`pdfstudio/src/clip/clip.ts:14-54` 的 `Clip { id, state, region, content, sourceText, translation, note, label, important, tagId, title, lastViewedAt }`。**注意 `Region.pixels` 与 `ClipContent.screenshot` —— 每条摘录本来就存着像素。**
- `[P3]` ADR-0016《选区有多个去处》：`pdfstudio/docs/adr/0016-selection-destinations.md`（Accepted 2026-08-17）。原文 *"选择方式由**拖动起点**推断：起点落在文字上走文本流（跟阅读顺序、可跨行），落在空白或图上走矩形。"*

### 外部一手来源：标注失效率与图像区域

- `[E1]` **Apache Annotator 已退休**：`https://incubator.apache.org/projects/annotator.html`，状态行 *"2025-08-11 Project retired from Apache Incubator."*；进孵化器日期 2016-08-30。**「W3C 选择器参考实现」这个位置上唯一的 ASF 项目，熬了近九年没有毕业。**
- `[E2]` Apache Annotator 的自我定位：`https://github.com/apache/incubator-annotator` README，*"provides libraries to enable annotation related software, with an initial focus on identification of textual fragments in browser environments"*。**README 里没有任何关于选择器组合或 fallback 顺序的指南。**
- `[E4]` `approx-string-match`：`https://github.com/robertknight/approx-string-match-js`。README 引用的算法是 G. Myers, *"A Fast Bit-Vector Algorithm for Approximate String Matching Based on Dynamic Programming," vol. 46, no. 3, pp. 395–415, 1999*，并称其为 *"the state of the art algorithm for the online version of the problem"*；期望复杂度 `O((k/w) * n)`（`w` = 字长，JS 下 32）；API `search(text: string, pattern: string, maxErrors: number): Match[]`，`Match = { start: number; end: number; errors: number }`。
- `[E5]` `hypothesis/product-backlog#954`：`https://github.com/hypothesis/product-backlog/issues/954`，标题《annotations can fail to anchor, yet not be reported as orphans》，judell 开于 **2019-02-08**，**状态 CLOSED**。2019-02-20 的 *"I will now gather data, from both the PDF and HTML domains"* —— **数据始终没有出现在该 thread 里**。2020-11-04 的 *"**It would sure be nice to have** telemetry that can capture a much wider and clearer view of anchoring outcomes"* —— **属愿望表述，不等于官方声明「我们没有遥测」**。「Orphans tab 少报」的依据是该 issue 标题本身与 judell 原文 *"these anchoring failures are not reported as orphans by the client"*。
- `[E6]` **Aturban, Nelson & Weigle，《Quantifying Orphaned Annotations in Hypothes.is》**，arXiv:1512.06195v1，2015-12-19：`https://arxiv.org/abs/1512.06195`。**本文自行下载 PDF 并用 `pdftotext` 抽全文核对**。摘要与正文原文见 §2.6.1。口径链：33,946 条公开标注 → 20,953 条带 `TextQuoteSelector` → 剔除 820 条不可解析 URI → **分析集 20,133**；1,966（10%）目标页 4xx/5xx；15,773（78%）仍附着；4,360（22%）贴不回去；其中 547（12%）可从存档恢复 → 3,813（19%）最终 orphan；8,357 濒危（占仍附着的 53%、占分析集的 41%）。方法学原文 *"After extracting the text either from a standard HTML web page or a PDF file, we search for the highlighted annotation text. **If the text is not found, the annotation is considered not attached.**"* —— **即逐字子串搜索**。⚠️ **论文从未声明自己「没有使用 fuzzy anchoring」**；该判断由方法描述推出，另有词频佐证（两篇全文 `fuzzy` = 0、`diff-match` = 0、`approximat*` = 0）。前作 **TPDL 2015**（n = 6,281，2015 年 1 月语料）：`https://www.cs.odu.edu/~mln/pubs/tpdl-2015/tpdl-2015-annotations.pdf`，orphan 27.3%、可恢复 3.5%、濒危 61%；⚠️ 该篇正文 *"only allow 61% of these to be re-attached"* 与同篇摘要 *"about 3.5%"* 冲突，61 ÷ 1,715 = 3.56%，故正文应为「61 **条**」、百分号是笔误（**核查者的推断，论文未勘误**；arXiv 版同位置已改为 12%）。
- `[E7]` **Fetterly, Manasse, Najork & Wiener，《A large-scale study of the evolution of web pages》**，Software: Practice and Experience 34(2), 2004（会议版 WWW2003）。1.5 亿网页、每周一次、连续 11 周；每周约 **3%** 发生实质性改动。
- `[E8]` **Jones, Van de Sompel, Shankar, Klein, Tobin & Grethel，《Scholarly Context Adrift: Three out of Four URI References Lead to Changed Content》**，PLOS ONE 11(12): e0167475, 2016：`https://doi.org/10.1371/journal.pone.0167475`。241,091 条学术论文 URI 引用（1997–2012），**76.35%** 发生 content drift。
- `[E9]` Hypothesis 官方博客《Fuzzy Anchoring》：`https://web.hypothes.is/blog/fuzzy-anchoring/`，作者 **csillag**，**2013-04-22**（HTTP 200，可访问）。描述四级 fallback（Range → Position → Context-first Fuzzy → Selector-only Fuzzy）与 *"a modified version of the google-diff-match-patch library"* + Bitap。**全文没有任何评测数字**；唯一的数字是实现常量：*"TextQuoteSelector : this selector stores three strings: exact : the selected text itself prefix : the (32-char long) text immediately before the selected text suffix : the (32-char long) text immediately after the selected text"*。
- `[E28]` **`hypothesis/anchoring-test-tools`**（Hypothesis 官方 org）：`https://github.com/hypothesis/anchoring-test-tools`。`results/` 仅有一次提交：**2019-09-19 · Robert Knight · *"Add results from running tests on sep-2019-pdf-urls.txt test set"***。README 说测试语料是 *"real annotations created by Hypothesis users in public groups"*。两个 JSON 是**同一批 235 个 URL 跑两种 PDF.js 渲染器版本**（`via` / `via-pdfjs2`），**不是时间前后对比**。逐条求和：via 211/235 可用、7,482 anchored / 48 orphan（**0.64%**）；via-pdfjs2 219/235、7,691 / 90（**1.16%**）。⚠️ **这两个百分比是核查者的算术，Hypothesis 从未表述过任何比率。** 四个折扣见 §2.6.2：分布极偏（pdfjs1 的 211 条里 207 条零 orphan；单个 researchgate URL 以 1 anchored / 33 orphan 贡献了 48 里的 33，剔除后 pdfjs1 = 0.20%、pdfjs2 = 0.74%）；加载彻底失败的条目（典型 `{'error': 'waiting for selector … timeout 30000ms'}`）不在分母里；**语料只有 PDF，不含 HTML**。
- `[E29]` **Phelps & Wilensky，《Robust Intra-document Locations》**，WWW9，2000：`https://web.archive.org/web/2005id_/http://www9.org/w9cdrom/312/312.html`。原文 *"…of 754 annotations that needed repositioning because the referenced man pages underwent change out of control of the annotator, 742 annotations were automatically repositioned, leaving 12 to be reapplied by the user."*（= **98.4%**，百分比是核查者的算术）。**必带的限定（作者同段自陈）**：实现是 TkMan 里的 *"prototype, less sophisticated implementation"*，且这些结果 *"are no substitute for actual measurement"*。语料是 Unix man page。⚠️ 订正：**Berkeley 技术报告版（CSD-00-1091）与 D-Lib 版没有测量值，只有 WWW9 版有**；D-Lib 版的正确 URL 是 `https://www.dlib.org/dlib/july00/wilensky/07wilensky.html`（常被写成的 `phelps/07phelps.html` 是 404）。
- `[E30]` **《Robust anchoring of annotations to content》**，US20060080598A1，Microsoft，发明人 **David Bargeron、Alice Jane Brush、Anoop Gupta**，申请日 **2005-11-29**，公开日 **2006-04-13**：`https://patents.google.com/patent/US20060080598A1/en`。图像特征段原文 *"Color histogram, number of pixels in the region, recognizable/trackable objects in the region, motion flow, edge features, wavelet signatures, or various other standard image processing features. These features can then be used to re-anchor the annotation to the correct portion of the image."* **法律状态：Abandoned，从未授权，无任何进入产品的证据。** 发明人 Bargeron 与 Brush 正是 CHI 2001《Robust Annotation Positioning in Digital Documents》的作者。
- `[E32]` **PDQ 白皮书**（Meta / ThreatExchange）：`https://github.com/facebook/ThreatExchange/blob/main/hashing/hashing.pdf`。`CROPS: OUT OF SCOPE` 一节原文 *"we already threw in the towel on hard crops: they are outside the domain of fast, syntactic matchers such as PDQ. And here we see quantitative data on that: from the distance-histograms of the previous section we see that pairwise distances between these images are generally within the realm of distances between random images."*；设计目标一节 *"PDQ does not handle deep crops; this is outside its purview as a fast syntactic hasher."*
- `[E33]` **McKeown & Buchanan，《Hamming distributions of popular perceptual hashing techniques》**，arXiv:2212.08035：`https://arxiv.org/pdf/2212.08035`。语料 Flickr 1 Million。归一化 Hamming 距离 mean / 精确匹配率：pHash scale 0.0020 / **94.01%**、compression 0.0053 / 83.90%、**crop 0.1686 / 0.043%**、border 0.2656 / 0.000%、mirror 0.4904 / 0.000%；PDQ scale 0.0237 / 1.63%、compression 0.0094 / 23.44%、**crop 0.3255 / 0.000%**、border 0.3949 / 0.000%；blockhash scale 0.0013 / 85.44%、**crop 0.1668 / 0.018%**、border 0.2783 / 0.000%；NeuralHash crop 0.0605 / 1.15%。（0.5 ≈ 随机图之间的距离。）**另注**：blockhash 的 border 组内距离降至 0.3284，意味着不同图片被同样加边框后会彼此靠拢，误报风险上升。⚠️ **周边一手来源现状**：pHash 官方站 `http://www.phash.org/` 仍在（Zauner 2010 硕士论文 `https://www.phash.org/docs/pubs/thesis_zauner.pdf`）；**blockhash 官方站 `http://blockhash.io/` 已下线（HTTP 403）**，只能读存档；dHash 的权威描述是 HackerFactor 的**博客**，不是论文也不是规范；**PhotoDNA 微软未公开任何技术细节——没有公开数据**。
- `[E34]` **Leotta, Stocco, Ricca & Tonella，《ROBULA+: An Algorithm for Generating Robust XPath Locators for Web Testing》**，*Journal of Software: Evolution and Process* 28(3):177–204, 2016，DOI **10.1002/smr.1771**：`https://tsigalko18.github.io/assets/pdf/2016-Leotta-JSEP.pdf`。实验：8 个开源 Web 应用，各取**相邻两个 release**，共 **1,110** 个定位符。Table II 汇总失效率：绝对 XPath **871/1110 = 78%**、相对 ID-based XPath **557/1110 = 50%**、Selenium IDE 22%、ROBULA 30%、ROBULA+ **91/1110 = 8%**。原文 *"In total, considering all eight applications, 871 over 1110 absolute locators result broken (i.e., 78%). These results reveal the high fragility of the absolute XPath locators generated by state of the practice tools"*。**前作分项**（ISSREW 2014，DOI 10.1109/issrew.2014.17，`https://tsigalko18.github.io/assets/pdf/2014-Leotta-ISSREW.pdf`，2,735 个定位符）：*"we found that id locators are the most robust, with less than the 2% of the 459 used id locators broken."*、*"only the 12% of the 473 LinkText locators were broken."*、*"67% of the 177 XPath locators were broken from a release to the next one, while for the other types of locators the breakage percentages were extremely lower (less than 1% for the ID locators; about 20% for the Name, LinkText and CSS locators)."* ⚠️ **两条限定必须一起引**：① 这是**相邻 release** 的数字，不是「改版」的，**是下界**；② 它量的是 **Web 测试的元素定位**，不是标注锚定，**迁移到标注场景是本文的类比，不是论文的结论**。
- `[E35]` **WebAIM Million 2026 年报**：`https://webaim.org/projects/million/`（2026 年 2 月抓取全球前 1,000,000 首页，6,660 万张图）。*"16.2% of all home page images (10.8 per page on average) had missing alternative text (not counting alt="")."*；*"10.8% of images with alternative text had questionable or repetitive alternative text—such as alt="image", "graphic", "blank", a file name, etc., or alternative text identical to adjacent text or the alternative text of an adjacent image."*；*"more than one in four images on popular home pages have missing, questionable, or repetitive alternative text."*
- `[E36]` **HTTP Archive Web Almanac 2024**：Media 章 `https://almanac.httparchive.org/en/2024/media` —— *"45 percent of `<img>` elements don't have any alt text"*；`srcset` 移动端 **42%**（*"The last time we checked, this number was 34%"*），`w` 描述符占 62–64%、`x` 占 15%；`<picture>` **9.3%**；`loading=lazy` *"is now used on a full one-third of all websites"*（2024-06 接近 35%）；*"On desktop … 1 in 5 sizes attributes is inaccurate enough to cause browsers to pick a suboptimal resource from the srcset."* Accessibility 章 `https://almanac.httparchive.org/en/2024/accessibility` —— 用文件名当 alt 的站点占移动端 **7.5%** / 桌面 **7.2%**。⚠️ **与 `[E35]` 口径不同（WebAIM 排除 `alt=""`），本文两个数并列，不做调和。**
- `[E37]` **WHATWG HTML —— 响应式图片与 `currentSrc`**：`https://html.spec.whatwg.org/multipage/images.html#adaptive-images`（§4.8.4.1.1 的示例原文 *"on wide screens (wider than 600 CSS pixels) a **300×150** image named a-rectangle.png is to be used, but on smaller screens (600 CSS pixels and less), a smaller **100×100** image called a-square.png is to be used"*）；§4.8.4.3.13 *"The user agent may at any time run the following algorithm to update an img element's image in order to react to changes in the environment."* / *"User agents are encouraged to run this algorithm in particular when the user changes the viewport's size"*；`currentSrc` 定义见 `https://html.spec.whatwg.org/multipage/embedded-content.html#dom-img-currentsrc`。**fragment 解析的穷举**（`id` / `<a name>` / null）见 `https://html.spec.whatwg.org/multipage/browsing-the-web.html`。**Media Fragments 的适用边界**（`#xywh=` 只对已注册 media type 有定义，故对 `text/html` 无定义）见 `https://www.w3.org/TR/media-frags/`；**浏览器实现现状**见 MDN `https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment/Media_fragments` —— *"Spatial fragments work on SVG image files in Firefox 147 and above. Pixel values work as expected, but percent values seem to work unreliably and we'd recommend avoiding them."*
- `[E38]` **WICG scroll-to-text-fragment**：`https://github.com/WICG/scroll-to-text-fragment/blob/main/README.md`。"Future Work" 一节 *"One important use case that's not covered by this proposal is being able to scroll to an image. A nearby text snippet can be used to scroll to the image but it depends on the page and is indirect. We'd eventually like to support this use case more directly."*；放弃 CSS 选择器的理由 *"The main drawback with this approach was making it secure… Text snippets, which can be searched asynchronously and are generally less security sensitive, became our preferred solution. As an additional bonus, **we expect text snippets to be more stable** and easier to understand by non-technical users."*。按 `src` 定位图片的失败讨论见 issue #162 `https://github.com/WICG/scroll-to-text-fragment/issues/162`（微软 BoCupp 提议后自贴亚马逊反例：`src` 为 `grey-pixel.gif` 占位、真地址在 `data-src`、且 URL 尾部为 `._CR0,0,220,220_PT0_SX220__.jpg`；2023-12-13 关闭，Chrome 方 bokand 留言 *"I'm not currently working on this."*）。
- `[E39]` **浏览器侧的三道硬约束**：① canvas 跨源污染 —— `https://html.spec.whatwg.org/multipage/canvas.html#security-with-canvas-elements`，*"All bitmaps start with their origin-clean set to true. The flag is set to false when cross-origin images are used. The toDataURL(), toBlob(), and getImageData() methods check the flag and will throw a "SecurityError" DOMException rather than leak cross-origin data."*；② `<canvas>` 内容不在 DOM —— `https://html.spec.whatwg.org/multipage/canvas.html`，*"the canvas element represents embedded content consisting of a dynamically created image, the element's bitmap"* / *"The contents of the canvas element, if any, are the element's fallback content."*；③ SRI 不支持 `img` —— `https://www.w3.org/TR/SRI/` §3.4，*"A future revision of this specification is likely to include integrity support for all possible subresources, i.e., a, audio, embed, iframe, img, link, object, script, source, track, and video elements."*
- `[E40]` Hypothesis 服务端的两个 feature flag：`https://github.com/hypothesis/h/blob/main/h/models/feature.py` —— `"html_image_annotation": "Support image annotations in HTML"` 与 `"pdf_image_annotation": "Support image annotations in PDFs"`。**client 仓库里 `grep -rn "html_image_annotation" src/` 为 0 命中。**
- `[E41]` **Wikimedia Commons `{{ImageNote}}`**：`https://commons.wikimedia.org/wiki/Template:ImageNote` 与 `https://commons.wikimedia.org/wiki/Template:ImageNote/doc`。7 个必填参数中除 `x`/`y`/`w`/`h` 外，另有 `dimx`（*"The width of the entire image"*）与 `dimy`（*"The height of the entire image"*），**两者均标 `stat=required`**。与 Hypothesis 的 `ShapeSelector.view` `[H13]` 是同一思路：**矩形必须带参考帧。**
- `[E31]` **Zotero 的标注数据模型**（源码，`zotero/zotero` main 分支）：`https://raw.githubusercontent.com/zotero/zotero/main/chrome/content/zotero/xpcom/annotations.js`。标注类型常量 `ANNOTATION_TYPE_HIGHLIGHT=1` / `NOTE=2` / **`IMAGE=3`** / **`INK=4`** / `UNDERLINE=5` / `TEXT=6`（:31-36）；`ANNOTATION_POSITION_MAX_SIZE = 65000`（:29）；位置存在 `annotationPosition` 这个**不透明 JSON 字符串**里（`o.position = JSON.parse(item.annotationPosition)`，:165），内容含 `rects` 或 `paths`（:277、:305）；**`image` / `ink` 标注另外缓存一张渲染好的 PNG**（`getCacheImagePath` / `saveCacheImage`，:61-95，`if (item.itemType != 'annotation' || !['image', 'ink'].includes(item.annotationType)) throw new Error("Item must be an image/ink annotation item")`）。`zotero-schema` v44 里 `{"itemType": "annotation", "fields": [], "creatorTypes": []}` —— **schema 不约束 position 的形状，全交给 reader**。**净结论：存的是坐标 + 像素，没有任何感知哈希或图像特征匹配。** **网页快照那边**（`zotero/reader`，`src/dom/common/lib/selector.ts` 文件头注释）逐字：*"We generate and support a very limited subset of the Web Annotation Data Model… EPUB annotations are expressed in terms of FragmentSelectors with epubcfi values, and **snapshot annotations are CssSelectors, possibly refined by TextPositionSelectors**."*，紧随其后是 *"Skipping: XPath Selector"* 与 ***"Skipping: Data Position Selector, SVG Selector, Range Selector"***；锚定实现是一次 `querySelector`，失败即 `console.error(...)` 放弃、**不重锚**——它敢这么写是因为锚的是**冻结的归档件**（快照保存时 `blockScripts: true`、`removeHiddenElements: true`）。⚠️ **`annotationType` / `annotationPosition` 在 Zotero 的公开 API 文档与 schema 里均无记载**（`https://api.zotero.org/schema` 中 annotation 的 `fields` 为空数组），源码与测试夹具是唯一规范。

### 外部一手来源：Electron 官方文档

> 引文取自 `https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/…`，并与线上 `https://www.electronjs.org/docs/latest/…` 的渲染文本逐字比对一致。`latest` 在 2026-08-20 对应 **43.4.1**（npm dist-tag；GitHub release `v43.4.1` published_at `2026-08-19T00:06:21Z`）。

- `[E3]` Security 教程（**清单共 20 条**，不是常见说法的 17–19 条）：`https://www.electronjs.org/docs/latest/tutorial/security`。Preface 的 *"displaying arbitrary content from untrusted sources poses a severe security risk that Electron is not intended to handle…"*；第 12 条结尾的 *"Again, this list merely minimizes the risk, but does not remove it. If your goal is to display a website, a browser will be a more secure option."*；`#isolation-for-untrusted-content` 的 *"To display remote content, use the `<webview>` tag or a `WebContentsView` and make sure to disable the `nodeIntegration` and enable `contextIsolation`."*；第 20 条 `#20-do-not-expose-electron-apis-to-untrusted-web-content` 关于剥掉 `IpcRendererEvent` 的完整论述与 Bad/Good 示例；第 13 条 `#13-disable-or-limit-navigation` 的 *"We recommend that you use Node's parser for URLs. Simple string comparisons can sometimes be fooled - a `startsWith('https://example.com')` test would let `https://example.com.attacker.com` through."*；第 17 条 `#17-validate-the-sender-of-all-ipc-messages` 的 *"You should be validating the `sender` of **all** IPC messages by default."*
- `[E10]` `<webview>` 标签：`https://www.electronjs.org/docs/latest/api/webview-tag`。页首 Warning 全文见 §4.1；*"By default the `webview` tag is disabled in Electron >= 5."*；`## Internal implementation` 的 *"Under the hood `webview` is implemented with Out-of-Process iframes (OOPIFs)… So the behavior of `webview` is very similar to a cross-domain `iframe`"*；`## Overview` 的 *"Unlike an `iframe`, the `webview` runs in a separate process than your app."*；NOTE *"Most methods called on the webview from the host page require a synchronous call to the main process."*；方法签名 `<webview>.insertCSS(css)`（**无 `cssOrigin`**）、`<webview>.executeJavaScript(code[, userGesture])`（**无 isolated-world 变体**）、`<webview>.capturePage([rect])`（**无 `opts`**）、`<webview>.getWebContentsId()`；`webpreferences` 属性的安全钳制 *"Security-critical preferences cannot be used to make the guest less secure than its embedder."*
- `[E11]` `BrowserView` 废弃：`https://www.electronjs.org/docs/latest/api/browser-view`，NOTE *"The `BrowserView` class is deprecated, and replaced by the new `WebContentsView` class."*（页面出现两次）。废弃版本的判定：`browser-view.md` 的 YAML history 指向 PR 35658 与 `breaking-changes-header: deprecated-browserview`，而 `https://www.electronjs.org/docs/latest/breaking-changes#deprecated-browserview` 一节位于 `## Planned Breaking API Changes (30.0)` 之下 → **Electron 30.0**。
- `[E15]` `WebContentsView`：`https://www.electronjs.org/docs/latest/api/web-contents-view`。*"A View that displays a WebContents."*；`new WebContentsView([options])` 的 `webPreferences` / `webContents` 参数；`view.webContents` _Readonly_；页首完整示例（`BaseWindow` + `contentView.addChildView` + `loadURL` + `setBounds`）。`view.addChildView(view[, index])` 见 `https://www.electronjs.org/docs/latest/api/view#viewaddchildviewview-index`。两个类都带 *"Electron's built-in classes cannot be subclassed in user code."*
- `[E16]` `BaseWindow` 的内存泄漏警告：`https://www.electronjs.org/docs/latest/api/base-window`，*"Unlike with a `BrowserWindow`, if you don't explicitly close the `webContents`, you'll encounter memory leaks."*；`win.contentView` 的定义 *"A `View` property for the content view of the window."*
- `[E12]` `executeJavaScript` 与 `executeJavaScriptInIsolatedWorld`：`https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptcode-usergesture` 与 `#contentsexecutejavascriptinisolatedworldworldid-scripts-usergesture`。前者 *"Evaluates `code` in page."* + *"Code execution will be suspended until web page stop loading."*；后者 *"`worldId` Integer - The ID of the world to run the javascript in, `0` is the default world, `999` is the world used by Electron's `contextIsolation` feature. You can provide any integer here."* + *"Works like `executeJavaScript` but evaluates `scripts` in an isolated context."*。**`executeJavaScript` 跑在主世界这一点文档没有明说**，源码为证：`shell/browser/api/electron_api_web_frame_main.cc`（v43.4.1，约 :248-251）调用 `ExecuteJavaScriptForTests(code, user_gesture, true, /*honor_js_content_settings=*/true, content::ISOLATED_WORLD_ID_GLOBAL, …)`。**标注为源码级结论。** `contextBridge.exposeInMainWorld` / `exposeInIsolatedWorld(worldId, …)`（*"We recommend using 1000+ while creating isolated world."*）见 `https://www.electronjs.org/docs/latest/api/context-bridge`。
- `[E17]` `preload`：`https://www.electronjs.org/docs/latest/api/structures/web-preferences`，*"Specifies a script that will be loaded before other scripts run in the page. This script will always have access to node APIs no matter whether node integration is turned on or off. The value should be the absolute file path to the script."*
- `[E18]` `contextIsolation`：同 `[E17]` 页面，*"Whether to run Electron APIs and the specified `preload` script in a separate JavaScript context. **Defaults to `true`.** … This option uses the same technique used by Chrome Content Scripts."*；教程 `https://www.electronjs.org/docs/latest/tutorial/context-isolation` 的 *"the `window` object that your preload script has access to is actually a **different** object than the website would have access to"* 与 *"Context isolation has been enabled by default since Electron 12, and it is a recommended security setting for _all applications_."*，以及 *"Just enabling `contextIsolation` and using `contextBridge` does not automatically mean that everything you do is safe."*
- `[E19]` `insertCSS` / `removeInsertedCSS`：`https://www.electronjs.org/docs/latest/api/web-contents#contentsinsertcsscss-options`。*"`cssOrigin` string (optional) - Can be 'user' or 'author'. Sets the cascade origin of the inserted stylesheet. Default is 'author'."*；返回 key 供 `removeInsertedCSS(key)` 使用。
- `[E20]` Sandbox：`https://www.electronjs.org/docs/latest/tutorial/sandbox`。`## Preload scripts` 一节列出 sandbox 下 `require` 可用的全集（`electron` 的 `contextBridge` / `crashReporter` / `ipcRenderer` / `nativeImage` / `webFrame` / `webUtils`，加 `events` / `timers` / `url` 及其 `node:` 形式；全局 polyfill `Buffer` / `process` / `clearImmediate` / `setImmediate`）与 *"you will not be able to use CommonJS modules to separate your preload script into multiple files… use a bundler such as webpack or Parcel."*；*"Sandboxing is tied to Node.js integration. Enabling Node.js integration for a renderer process by setting `nodeIntegration: true` disables the sandbox for the process."*；`## A note on rendering untrusted content` 的四条局限（含 Safe Browsing / Certificate Transparency 被关掉那条）。
- `[E21]` 权限处理：`https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler` 与 `#sessetpermissioncheckhandlerhandler`。*"you must also implement `setPermissionCheckHandler` to get complete permission handling. Most web APIs do a permission check and then make a permission request if the check is denied."*；*"All cross origin sub frames making permission checks will pass a `null` webContents to this handler"*；两个 handler 的 permission 取值列表不同（check 版多 `hid`/`serial`/`usb`/`deprecated-sync-clipboard-read`，少 `display-capture`/`window-management`/`keyboardLock`/`speaker-selection`）。「默认全部批准」出自 `[E3]` 第 5 条：*"By default, Electron will automatically approve all permission requests unless the developer has manually configured a custom handler."*
- `[E22]` WebPreferences 各项默认值：`https://www.electronjs.org/docs/latest/api/structures/web-preferences`。`contextIsolation` *"Defaults to `true`."*；`sandbox` *"Default is `true` since Electron 20."*；`nodeIntegration` *"Default is `false`."*；`webSecurity` *"When `false`, it will disable the same-origin policy… Default is `true`."*；`allowRunningInsecureContent` *"Default is `false."*；`experimentalFeatures` *"Default is `false."*；`webviewTag` *"Defaults to `false`."*；`nodeIntegrationInSubFrames` *"**Experimental option** for enabling Node.js support in sub-frames such as iframes and child windows. All your preloads will load for every iframe…"*；`session` / `partition` 的语义。
- `[E23]` 子框架 IPC 的代价：`https://www.electronjs.org/docs/latest/api/web-contents#contentsipc-readonly`，*"In most cases, only the main frame can send IPC messages. However, if the `nodeIntegrationInSubFrames` option is enabled, it is possible for child frames to send IPC messages also. In that case, handlers should check the `senderFrame` property of the IPC event…"*；`IpcMainEvent` 的 `processId` / `frameId` / `senderFrame` 见 `https://www.electronjs.org/docs/latest/api/structures/ipc-main-event`。
- `[E14]` `webFrameMain`（跨源子框架）：`https://www.electronjs.org/docs/latest/api/web-frame-main`。*"The `webFrameMain` module can be used to lookup frames across existing `WebContents` instances."*；**两个官方示例**——往 twitter.com 导航后的 frame 里 `frame.executeJavaScript(...)` 改 DOM，以及 `win.webContents.mainFrame.frames.filter(...)` 枚举 reddit 页面里 `www.youtube.com` 的跨源嵌入，**均无任何同源检查**；`frame.frames` / `frame.framesInSubtree` / `frame.top` / `frame.parent` / `frame.url` / `frame.origin` / `frame.frameToken` / `frame.routingId` / `frame.detached`（*"If a frame is accessed while the corresponding page is running any unload listeners, it may become detached…"*）；`webFrameMain.fromId(processId, routingId)`。`webContents.mainFrame` / `webContents.focusedFrame`（*"Can be the top frame, an inner `<iframe>`, or `null` if nothing is focused."*）见 `https://www.electronjs.org/docs/latest/api/web-contents`。
- `[E24]` `capturePage`：`https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts`。*"`rect` Rectangle (optional) - The area of the page to be captured."*、`opts.stayHidden` / `opts.stayAwake`（均 default `false`）、*"Returns `Promise<NativeImage>`"*、*"Captures a snapshot of the page within `rect`. **Omitting `rect` will capture the whole visible page.**"*
- `[E25]` `Rectangle` 结构：`https://www.electronjs.org/docs/latest/api/structures/rectangle`。**全文只有四行，每行都写着 `(must be an integer)`，没有任何单位说明。** 这是官方文档的一处真实缺口。
- `[E13]` `capturePage` 坐标单位的**源码级结论**：`shell/browser/api/electron_api_web_contents.cc`，`WebContents::CapturePage`（v43.4.1，约 :3931-3946）。`const gfx::Size view_size = rect.IsEmpty() ? view->GetViewBounds().size() : rect.size();`，随后注释 *"By default, the requested bitmap size is the view size in screen coordinates. However, if there's more pixel detail available on the current system, increase the requested bitmap size to capture it all."* 与 `if (scale > 1.0f) bitmap_size = gfx::ScaleToCeiledSize(view_size, scale);`（`scale` 取自 `display::Screen::Get()->GetDisplayNearestView(native_view).device_scale_factor()`）。→ **`rect` 是 DIP，返回位图按 `device_scale_factor` 放大。**
- `[E26]` DIP 的官方定义：`https://www.electronjs.org/docs/latest/api/screen`。*"There are two kinds of coordinates available to the process: **Physical screen points** are raw hardware pixels on a display. **Device-independent pixel (DIP) points** are virtualized screen points scaled based on the DPI (dots per inch) of the display."*；`screen.screenToDipRect` / `screen.dipToScreenRect` **仅 Windows / Linux**。
- `[E27]` `nativeImage`：`https://www.electronjs.org/docs/latest/api/native-image`。`image.getSize([scaleFactor])`、`image.getScaleFactors()`（*"An array of all scale factors corresponding to representations for a given `NativeImage`."*）、`image.toBitmap([options])`（*"A `Buffer` that contains a copy of the image's raw bitmap pixel data."*，`colorSpace` 选项 *"Defaults to sRGB."*）。v43 行为变更（YAML history，PR 48178）：*"Normalized `NativeImage.toBitmap()` pixel data to sRGB by default."*

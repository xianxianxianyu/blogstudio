# Recognizer 三份设计的架构图

按三个维度标注：**抽象**（接口后面藏了什么）、**自动化**（路由/流程如何自动）、**状态机**（有哪些状态与转移）。

## 共同上下文：三份设计都接到同一个 Clip 状态机

```
            Clip 状态机（Recognizer 填的是「recognizing」这一格）
  capturing ──► recognizing ──► ready ──► promoted
                  ▲
                  │  recognize(region) → ClipContent
```

## D1 灵活版（`design-recognizer-1-extensible.md`）：构造期抽象 + 会话/事件流

```
【抽象】扩展点全部构造期注入，运行期不碰
  createRecognizer(config)
    ├─ engines:  textLayer · visionModel · (localOcr?)
    ├─ router:   Classifier + routeTable
    └─ concurrency: vision 串行 / text 并行

【自动化】一个 region 的旅程（四跳）
  Region ─► Classifier ─► RegionKind ─► Engine ─► Stage[] ─► ClipContent

【状态机】per-region 生命周期 + 9 种会话事件
  idle ─► routing ─► running ─► done
              │   └─► failed ─(retry)─► routing
  events: started→routed→stage-start→(progress|partial)*→region-done|region-failed→done|aborted
```

## D2 最小版（`design-recognizer-2-minimal.md`）：一个纯函数 + 一个端口

```
【抽象】唯一入口 + 唯一注入端口
  makeRecognizer(visionPort) ─► Recognizer
                       ▲
              VisionPort（true external，测试换 mock）

【自动化】内部双引擎，调用方无感知
              ┌─ 文字区 ─► pdf.js 文本层（精确免费，零模型调用）
  recognize ──┤
  (region)    └─ 图/公式 ─► visionPort（读图+翻译+LaTeX 一次过）
                    │
                    ▼
              ClipContent{ source: string|null, ... }

【状态机】只有 pending → resolved，Promise 本身就是状态
  source === null ⟺ 纯图 ⟺ 入库 blocked
```

## D3 最顺版（`design-recognizer-3-common-caller.md`）：覆盖检测路由，无分类器

```
【抽象】依赖只在构造处，调用一行
  createRecognizer({ document, model, targetLang }) ─► Recognizer

【自动化】覆盖检测吞掉「文字还是图片」的判断
              ┌─ 覆盖检测 ────────────────────────────────┐
  recognize ──┤  getTextContent() → 文本覆盖度              │
  (region,    │    高 ─► text 层：逐字拼接（零模型调用）      │
   options?)  │    低/0 ─► model：读图+翻译+LaTeX 一次过     │
              └────────────────────────────────────────────┘
              （公式/纯图在文本层无 item → 覆盖度自动塌 0 → 落视觉）

【状态机】pending → resolved；失败 reject RecognizeError(kind)
  纯图：sourceText === ''（建议改 null）⟺ 入库 blocked
  逃生口：options.route = 'vision' | 'text'（覆盖误判时）
```

## 按「抽象 + 自动化 + 状态机」打分

| | 抽象 | 自动化 | 状态机 |
|---|---|---|---|
| D1 | 最厚（6 扩展点类型） | 四跳显式编排 | 唯一显式状态机，但为不存在的需求付复杂度 |
| D2 | 最纯（1 函数 + 1 端口） | 内部双引擎 | 最简（Promise 即状态） |
| D3 | 薄（依赖构造期一次） | 最强（覆盖检测自动路由） | 最简（Promise 即状态 + 一个逃生口） |

结论与上一轮一致：**D3 为底 + D2 的 `source === null`**。

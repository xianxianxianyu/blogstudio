# ADR-0015：本地识别档位——降级产出，进程由应用自己管

## 状态

Accepted（2026-08-16）

## 背景

ADR-0001 的修订把视觉路由改成「本地 / 云端可选」，并要求提供一键下载。
`research-local-ocr-engine.md` 做完了选型，推荐 **PaddleOCR-VL-1.6-GGUF + llama.cpp
（`llama-server`）**，并留下两个「必须由决策者拍板」的问题。这份 ADR 回答它们。

事实核对（2026-08-16）：`PaddlePaddle/PaddleOCR-VL-1.6-GGUF` 是官方仓库、**Apache-2.0**、
74 万下载，含 `PaddleOCR-VL-1.6-GGUF.gguf`（892 MB）与
`PaddleOCR-VL-1.6-GGUF-mmproj.gguf`（840 MB，视觉投影）。llama.cpp 官方发布带
`llama-b*-bin-macos-arm64.tar.gz`（10 MB）。

## 决策

**1. 本地档位降级产出：只出 `sourceText`，不出 `translation` 与 `multimodal`。**

**2. 进程由应用自己管**：新开一个与 `ModelClient` 正交的 `LocalEngine` 端口，负责下载
权重与 `llama-server`、拉起进程、健康检查、停止。它的产物只是一个 `baseURL`，喂给已有的
`createModelClient` ——**`ModelClient` 契约零改动**。

## 为什么降级而不是混合

PaddleOCR-VL 是**专用识别模型，不是 instruct 模型**：它只吃六个固定 element-level
prompt（`OCR:` / `Formula Recognition:` / …），不遵循 JSON schema，模型卡的能力列表里
也**没有翻译**。所以「同一套 prompt 换个 baseURL」不成立，只能二选一：

- **混合**（本地出原文 + 云端补译文/描述）：`vision` 路由变成两次调用，破坏不变量 3
  「恰好一次」，而且**本地档不再离线、仍然要花钱**——那样它相对云端档只剩「原文这一段
  不花钱」，读者选它的理由几乎没了。
- **降级**（本档不产出译文与描述）：一次调用、真离线、语义干净。

选降级。代价是本地档与云端档的 `ClipContent` 丰富度不对等——**这是明说的产品差异，
不是缺陷**：`sourceText === null ⟺ 入库 blocked` 这条不变量不受影响（本地档照样给原文），
只是摘录少两栏。

`Recognizer` 的出口本来就在按 `VISION_TABLE` 裁剪「模型多回的字段」，这里是反过来
「少回了也合法」——`translation` / `multimodal` 本来就是可选字段，无需改契约。

## 为什么应用自己管进程

读者要的不是「自己装 Ollama 再填 URL」——那条路 ADR-0005 早就有了（baseURL 填本机地址），
留着它作为高级用法。一键下载 + 一键切换才是 ADR-0001 修订承诺的东西。

**新开端口而不是塞进 `ModelClient`**：下载、校验、进程生命周期、端口分配、崩溃恢复
都不是「模型调用」，塞进去会污染一个刻意保持极薄的 SDK-agnostic 端口（ADR-0009 边界）。
两个端口正交：

```
LocalEngine.ensureReady() → { baseURL }   →   createModelClient({ baseURL, … })
```

## 代价

1. **1.7 GB 权重**（892 + 840 MB），加上 10 MB 的 llama.cpp 二进制。比向量模型的
   326 MB 重得多，下载要能断点重来、要能看见进度、失败要说清楚原因。
2. **平台二进制**：每个平台一份 llama.cpp。先只做 macOS arm64，其余平台**没验证过就不算
   支持**（同 ADR-0014 的边界）。
3. **多一个要照看的子进程**：崩了要能重启，应用退出时要能收干净——留一个孤儿
   `llama-server` 占着几 GB 内存，读者只会觉得电脑变慢了却找不到原因。
4. 首次启用要下 1.7 GB 并加载模型，**必须是读者主动点的动作**，不能在识别时顺带触发
   （向量模型那次已经付过这个学费：读者以为应用坏了）。

## 边界

- **不设为默认**。ADR-0001 修订的准入门槛是「跑通 `eval/run-recognizer.ts` 的 19 张样本，
  达到可比的 kind 合规率与公式 LaTeX 质量」。**没过门槛之前它是可选项**，云端仍是默认。
  降级档下 `kind` 由 `createFixedPromptRecognitionClient` 按「有没有认出字」合成，
  这一点跑 eval 时要记在读数里。
- 不做本地翻译模型。那是另一次选型，与本 ADR 无关。

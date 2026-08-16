# ADR-0014：打包用 Electron，本地 API 与 dev server 共用一份实现

## 状态

Accepted（2026-08-16）

## 背景

ADR-0006 定了「local-first 打包应用」，但没定运行时。现在要落地，候选是 Electron 与
Tauri 2。

同时，开发形态下已经长出五条 dev server 路由——`/__config`、`/__clips`、`/__docs`、
`/__index`、`/__models`、`/__embed`——它们把「渲染侧不碰文件系统与原生依赖」这条边界
预演了一遍。打包时这条边界要固定成什么，是第二个要定的事。

## 决策

**1. 用 Electron。**

**2. 本地 API 抽成一个模块，dev server 与打包应用共用同一份实现**，在打包应用里由主
进程监听 `127.0.0.1` 的随机端口，渲染侧的适配器一行不用改。

## 为什么选 Electron

**主进程要能跑 Node，因为我们的原生依赖都在那儿。** 向量计算用
`onnxruntime-node`（原生多线程，实测建一篇论文的索引 9.6 秒，浏览器 WASM 要几分钟），
文件读写用 `node:fs`，模型下载用 Node 的 fetch 与流。Tauri 的后端是 Rust——要么把这些
全部用 Rust 重写（`ort` crate、重做存储层），要么塞一个 Node sidecar 进去，那等于既
背上 Tauri 的构建复杂度又背上 Node 的体积。

**体积这条不成立。** Tauri 相对 Electron 的主要卖点是安装包小几十 MB，而我们本来就要
分发或下载一份 **326 MB 的模型权重**。为了省 Chromium 那几十 MB 去重写整个后端，
账算不过来。

## 明说的代价：手机没了

ADR-0006 原话是「Mac/Windows/**手机**通用」。Electron 不做移动端，Tauri 2 做。

但**换成 Tauri 也拿不到手机**：手机上没有 Node、没有 `onnxruntime-node`、没有可写的
任意文件系统，`ClipStore`、`Bookshelf`、`ModelDownloader`、向量计算全部要另一套实现。
运行时选型不是这里的瓶颈，端口后面那一堆 Node 实现才是。

所以这是**推迟**而不是放弃：这些能力都在端口后面（`ClipStore`、`Bookshelf`、
`Embedder`、`ModelClient`），真要上移动端时换实现，领域代码不动——这条路已经走过三次
（ClipStore 从 fs 换到 HTTP、Embedder 从 WASM 换到服务端、配置从文件换到 HTTP）。

## 为什么共用一份实现，而不是 IPC

直觉上打包应用该用 IPC（`contextBridge` + `ipcRenderer`），不该在本机开端口。但那意味着
**每条边界都要写两份适配器**：dev 走 HTTP、打包走 IPC。

这个项目已经反复被同一类问题咬过：**写好了没接上**（翻译依赖、`listByDoc`、`clips` 传
数组）、**两处各写一份规则**（对话状态、回收规则）。两份适配器是同一个形状的陷阱，
而且更隐蔽——dev 下全绿，打包后才出问题。

共用一份的代价是本机开一个端口。缓解：**只绑 `127.0.0.1`、用随机端口、带一次性 token**。
它不对外可达，与「渲染进程不碰文件系统」这条边界的目的不冲突。

## 边界

- **不做签名与公证**：那要开发者证书，不是代码问题。
- **不做自动更新**。
- 桌面先出 macOS 一档；Windows 只要不引入平台特有代码就应当能构建，但**没验证过就不算
  支持**。

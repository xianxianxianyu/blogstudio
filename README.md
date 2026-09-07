# PDF Studio · Context Studio · Blog Studio

一个 Electron 桌面应用里的三个 context（见 `CONTEXT-MAP.md`）：

- **PDF Studio**（`pdfstudio/`）——读 PDF、摘录、识别、问文档；通过把摘录入库产出 context
- **Context Studio**（`contextstudio/`）——跨 PDF、跨文章的 context 聚合，对人是一张图
- **Blog Studio**（`blogstudio/`）——写文章、管文章、同步到云端站点，以及定时跑的 Loop

数据一律是文件，且允许手改（`pdfstudio/docs/adr/0011`）。打包应用把数据放在系统的
应用数据目录（macOS：`~/Library/Application Support/PDF Studio/`）；开发形态放在
`pdfstudio/.library/`、`pdfstudio/.models/`、`pdfstudio/config.json`。

## 常用命令

```bash
npm install
npm run dev:pdfstudio        # vite 开发界面 + 本机 API（http://localhost:5174）
npm run dev:electron         # 打包形态的主进程，指向上面那个 dev server
npm run app:pdfstudio        # 完整构建并起 Electron
npm run test:pdfstudio       # 三个 context 各有 test:* / typecheck:*
npm run test:contextstudio
npm run test:blogstudio
npm run lint
```

## 给 agent 的

`CLAUDE.md` 说明 issue 在哪、术语表在哪、ADR 怎么分层。人读的文字一律中文，术语保留英文。

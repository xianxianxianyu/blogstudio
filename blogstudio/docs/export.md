# Export：Blog、Project 与 About

Export 的三个入口是 Blog、Project、About。前两个显示各自目录里的文章，支持搜索、标签、上下架、正文编辑、回收站和恢复；在 Writer 新写的文章默认属于 Blog，下架时可移至 Project。移动保留原文件内容，遇到目标同名文件时拒绝覆盖。语言后缀继续由 Hugo 解释。栏目 `_index` 文件不进入文章列表。

About 按语言编辑个人介绍、当前在做、方向卡片（Goal / Done / Problem）和联系方式；支持卡片增删、排序及内容预览。保存写入 `site/data/about.json`，两份 About Markdown 使用 `about` shortcode 渲染。另一语言保留不变；版本冲突时要求重新载入。修改尚未保存时，栏目切换和同步按钮禁用。

本地保存和云端发布仍分开：右侧选去处 → 预览变更 → 同步。文章变动会连带构建首页、标签页、RSS、sitemap 等页面。Export 的 rsync 干跑和实跑共用保护规则：不传、不删 `/recommend/`、`/en/recommend/`、旧 `/loop/` 路径、推荐专用 CSS / JS 以及 `upload/`。保留旧的共享指纹资源，确保在线推荐页仍能加载它引用的版本。Recommend 继续走独立发布流程。

Project 使用独立索引 `projects-index.db` 和 `.trash/projects/`；Blog 仍沿用原索引和 `.trash/`。发布到 OSS 的图片从两个栏目汇总，删除图片前同时检查两个栏目的引用。

构建先清空当前去处的 `public-<name>` 输出目录，再运行 Hugo，避免已下架或删除文章的旧 HTML 留在输出中并重新上线。远端删除清单在实际同步前展示。

验证：`npm run test:blogstudio`、两侧 typecheck、`npm run build:pdfstudio` 和 `npm run build:electron`。`src/publish/export.test.ts` 用真实 rsync 验证推荐保护、文章删除与关联页面更新，另验证 About 保存冲突、栏目白名单、草稿移动与独立回收站。

# PDF Studio 是 local-first 的跨平台应用，服务器只做后续同步

PDF Studio 打包成 Mac/Windows/手机通用的应用，核心循环（读 PDF、截图、OCR、chat、入库）在本地完成、不依赖服务器；key 和配置存在应用本地。存储笔记/blog 的同步服务器是后面的事，届时再定。此前 ADR-0003/0004 里的 Cloudflare 假设（Workers AI embedding、D1+FTS5）在打包落地时改成 local 形态（SQLite FTS5、本地或用户配的 embedding）。

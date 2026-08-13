# 检索 embedding 用 Cloudflare Workers AI bge-m3

单文档 chat 的检索 embedding 用 Cloudflare Workers AI `@cf/baai/bge-m3`（1024 维），它是唯一有第一方多语言/中文证据（MIRACL/MLDR）、且跑在 edge 无出口流量的选项。Voyage 与 OpenAI 没有中文质量数据且贵 5–10 倍；bge-m3 与 qwen3-embedding 的细微差距留待以后的小型中文 eval，不阻塞。

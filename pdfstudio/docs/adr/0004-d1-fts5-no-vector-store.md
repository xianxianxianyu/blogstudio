# 检索存储先用 D1+FTS5，不引入专门向量库

单 PDF 规模的 chat 检索用 D1 + FTS5（英文）配合 trigram tokenizer（中文），不引入专门向量库。Cloudflare Vectorize 是官方文档认可的、未来需要语义检索时的平台内升级；外部 pgvector/Pinecone 被否决，因为没有触发需求却徒增跨云出口流量。

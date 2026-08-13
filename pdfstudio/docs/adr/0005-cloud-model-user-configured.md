# 模型由用户配置：OpenAI 兼容的 URL + key + model，默认 GPT

图片/公式区域的 OCR+翻译、图理解、chat 都走用户配置的一个 OpenAI 兼容端点（base URL + API key + model name），默认 OpenAI GPT。选 OpenAI 兼容协议是因为它是事实标准——OpenAI、Gemini 兼容层、OpenRouter、vLLM、Ollama 都讲它——用户把 URL 填成自己本机服务就是本地部署，填 OpenAI 就是 GPT，一套代码同时覆盖云端与本地。research 按成本推荐 Gemini Flash，但你要的是自己掌握模型，故默认 GPT、成本不再是选型维度。

key/url/model 存在应用本地的一份 config JSON 里（设置界面读写）；应用直接调模型，不经任何服务器代理。发布时附带一份默认 config.json（空 key + 默认 url/model），用户真实配置写到系统应用数据目录，真实 key 绝不打进构建产物。

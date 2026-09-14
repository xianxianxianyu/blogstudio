/**
 * `/write` 的入口：**只有写和发**，给 `research.moyutianzun.com/write` 用。
 *
 *   npm run dev:pdfstudio   然后打开 /write.html
 *
 * 与 `main.tsx` 的差别就是少的那些：没有 pdf.js、没有 Workspace、没有本地引擎、
 * 没有向量。写作搭子只看**正在写的这篇**——`materials` 给空，`createRecaller` 不给
 * `embed`，它就不会去问一个这台机器上没有的向量服务。
 */
import { createRoot } from "react-dom/client";
import { apiUrl, apiFetch } from "../api-base";
import { createModelClient } from "../../src/model/openai-compatible";
import { createLiveClient } from "../../src/model/live-client";
import type { ModelClient } from "../../src/model/model-client";
import { parseConfig, resolveEndpoint, type Capability } from "../../src/config/config";
import { createHttpPublishing } from "../http-publish";
import { createHttpBlog } from "../http-blog";
import { createHttpDraftStore } from "../http-drafts";
import { createHttpConfigStore } from "../http-config";
import { createSettings } from "../../src/app/settings";
import { createProgress } from "../../src/app/progress";
import { createWriter } from "../../../blogstudio/src/writing";
import { createRecaller } from "../../../blogstudio/src/recall";
import { createWriterChat } from "../../../blogstudio/src/writer-chat";
import { createWritingTalk } from "../../../blogstudio/src/conversation";
import { WriteApp } from "./WriteApp";

const configStore = createHttpConfigStore(apiUrl("/__config"));
let appConfig = await configStore.load().catch(() => parseConfig(null));

/** 走本机 API 转发（`main.tsx` 的 `viaProxy` 同一个理由：端点的预检过不去）。 */
const viaProxy = (baseURL: string): string => `${apiUrl("/__model")}/${encodeURIComponent(baseURL)}`;

const settings = createSettings({
  load: () => configStore.load(),
  save: (next) => configStore.save(next),
  probe: async (endpoint) => {
    await createModelClient({ fetch: apiFetch, ...endpoint, baseURL: viaProxy(endpoint.baseURL) }).complete({
      messages: [{ role: "user", content: "ping" }],
    });
  },
});
await settings.load();
settings.subscribe(() => {
  appConfig = settings.config;
});

/** 某个能力的云端客户端，每次调用现读配置——改完 key 立刻生效（`live-client.ts`）。 */
const live = (capability: Capability): ModelClient =>
  createLiveClient(() => {
    const resolved = resolveEndpoint(appConfig, capability);
    return createModelClient({ ...resolved, baseURL: viaProxy(resolved.baseURL), fetch: apiFetch });
  });

const progress = createProgress();
const writer = createWriter({
  store: createHttpDraftStore(apiUrl("/__drafts")),
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
});
const talk = createWritingTalk({
  chat: createWriterChat({
    model: live("writing"),
    // 不接知识库：这一版的搭子只看正在写的这篇。
    materials: async () => [],
    recaller: createRecaller({}),
  }),
  draft: () => writer.text(),
});

createRoot(document.querySelector("#root")!).render(
  <WriteApp
    settings={settings}
    progress={progress}
    publishing={createHttpPublishing(apiUrl("/__publish"))}
    blog={createHttpBlog(apiUrl("/__blog"))}
    writer={writer}
    talk={talk}
    contexts={async () => []}
  />,
);

void writer.refresh();

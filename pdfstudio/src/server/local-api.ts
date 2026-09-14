import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import sirv from "sirv";
import { createClipStore } from "../clip/clip-store";
import { createBookshelf } from "../bookshelf/bookshelf";
import { createTagStore } from "../tag/tag-store";
import { createOutlineStore } from "../outline/outline-store";
import { deserialize, serializeClip } from "../clip/clip-wire";
import { createLocalEngine } from "../model/local-engine";
import { EMBEDDING_SPEC, RECOGNITION_SPEC, llamaEngineDeps } from "../model/llama-server";
import { createLlamaEmbedder } from "../model/llama-embedder";
import { createFileEngineRegistry } from "../model/engine-registry-file";
import { errorChain } from "../app/error-chain";
import { authorize } from "./guard";
import type { Clip } from "../clip/clip";
import type { Embedder } from "../model/embedder";
import { createContextStudio } from "../../../contextstudio/src/api";
import { createPublishStore } from "../../../blogstudio/src/publish/publish-store";
import { createBlog, indexFileOf, type Blog } from "../../../blogstudio/src/blog/blog";
import { draftsOnArticles } from "../../../blogstudio/src/blog/drafts-on-articles";
import { createSshSite } from "../../../blogstudio/src/publish/ssh-site";
import { createOssImages } from "../../../blogstudio/src/publish/oss-images";
import type { ImageSide } from "../../../blogstudio/src/publish/deploy";
import { previewSync, syncOnly } from "../../../blogstudio/src/publish/deploy";
import { staleOutDirs } from "../../../blogstudio/src/publish/build";
import { articleSection, type ArticleSection } from "../../../blogstudio/src/publish/scope";
import { createAboutStore } from "../../../blogstudio/src/publish/about-store";
import { moveArticle } from "../../../blogstudio/src/publish/move-article";
import { runHugo } from "../../../blogstudio/src/publish/hugo";
import type { Context } from "../../../contextstudio/src/context";
import { createLoopStore } from "../../../blogstudio/src/loop/loop-store";
import { sweep } from "../../../blogstudio/src/loop/sweep";
import { createLoopAgents } from "../../../blogstudio/src/loop/agents";
import { createPlainChat } from "../model/plain-chat";
import { parseConfig } from "../config/config";
import type { Draft } from "../../../blogstudio/src/draft";

/**
 * 本机 API：摘录、书架、配置、索引缓存、模型权重、向量计算、模型端点转发。
 *
 * **dev server 与打包应用共用这一份**（ADR-0014）。打包时改用 IPC 的话，每条边界都要
 * 写两份适配器——而这个项目已经反复被「写好了没接上」和「两处各写一份规则」咬过，
 * 两份适配器是同一个形状的陷阱，而且更隐蔽：dev 下全绿，打包后才出问题。
 *
 * 返回一串带前缀的中间件，挂到 vite 的 `server.middlewares` 或裸 `http.Server` 上都行。
 */
export interface LocalApiOptions {
  /**
   * 写保护的令牌，每次启动新生成。空串 = 不设防。
   *
   * **必填而不是可选**：可选的话，忘了接线的那天没有任何东西会提醒，而后果是
   * 任何网页都能改掉模型端点（见 `guard.ts` 里那段实测）。要不设防，就得显式写空串。
   */
  token: string;
  /** 书架与摘录的根目录：一个文档一个文件夹，摘录住在里面。 */
  libraryRoot: string;
  /** 模型权重目录。 */
  modelsRoot: string;
  /** 配置文件路径（含 apiKey，只在本机流动）。 */
  configFile: string;
  /**
   * pdf.js 随包静态资源的根（含 `cmaps/`、`standard_fonts/`、`wasm/`、`iccs/`）。
   *
   * **必填**：少了它，不嵌字体的中文书 `getTextContent()` 直接返回空串，而且不报错
   * （见 `src/pdf/assets.ts`）。做成可选的话，忘了接线的那一天没有任何东西会提醒。
   *
   * dev 下指 `node_modules/pdfjs-dist`；打包应用里 node_modules 整个不进包，指的是
   * 构建时拷进 `dist/pdfjs/` 的那份。
   */
  pdfjsRoot: string;
  /**
   * 算向量的实现。省略就在本进程里跑（dev server 下没问题）。
   *
   * 打包应用必须传一个跑在别处的——onnxruntime-node 的原生模块在 Electron 主进程上
   * 加载并推理会直接 EXC_BREAKPOINT，整个应用当场消失，连错误都没有。
   */
  embedder?: Embedder;
}

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface LocalApi {
  routes: Route[];
  /**
   * 停掉所有本地引擎。**应用退出时必须调用。**
   *
   * 不调用的后果量过：`llama-server` 是 `spawn()` 出来的子进程，父进程一没它就被系统
   * 收养继续跑，一个占 3 GB。重启五次留下四个孤儿、14 GB、机器卡死。
   *
   * 这里是正常退出那条路；被 SIGKILL 或者崩溃时它跑不到，那种情况靠下次启动收尸
   * （`engine-registry.ts`）。两条都要有，缺一条就有一类退出方式在漏。
   */
  shutdown(): void;
}

export interface Route {
  prefix: string;
  handler: Handler;
}

export const ROUTES = {
  config: "/__config",
  model: "/__model",
  clips: "/__clips",
  docs: "/__docs",
  index: "/__index",
  tags: "/__tags",
  outline: "/__outline",
  models: "/__models",
  pdfjs: "/__pdfjs",
  embed: "/__embed",
  engine: "/__engine",
  contexts: "/__contexts",
  sites: "/__sites",
  drafts: "/__drafts",
  loops: "/__loops",
  publish: "/__publish",
  blog: "/__blog",
} as const;

export function createLocalApi(options: LocalApiOptions): LocalApi {
  const engineStatus = () => engine?.status() ?? { running: false, baseURL: null };

  // **先把目录建出来。** 首次运行时它们都不存在，而 sirv 启动时就会去扫模型目录，
  // 扫不到直接抛——窗口还没出现应用就崩了。开发环境一直没暴露这个问题，只是因为
  // 那两个目录早就被下载和导入建好了；换一台机器、全新 clone 就是同样的下场。
  mkdirSync(options.libraryRoot, { recursive: true });
  mkdirSync(options.modelsRoot, { recursive: true });

  const shelf = createBookshelf(options.libraryRoot);
  const store = createClipStore(options.libraryRoot);
  const tags = createTagStore(options.libraryRoot);
  const outlines = createOutlineStore(options.libraryRoot);

  // Context Studio 的库与书架**并列**，不在书架里面：一条 context 可以来自任何一本书，
  // 甚至将来来自网页，塞进某本书的文件夹就等于宣布它属于那本书（ADR-0002）。
  const studio = createContextStudio(path.resolve(options.libraryRoot, "../contexts"));

  // 去处与发布账本，落在数据目录的根上：它们既不属于某本书，也不属于某一篇稿子。
  const publishing = createPublishStore(path.resolve(options.libraryRoot, ".."));

  /**
   * 博客那一层（文章库 + 索引）**懒建**：它要读 `destinations.json` 才知道仓库在哪，
   * 而那份文件可能还没写。建不出来时整个 API 照常起——只是博客那几条路由会说清原因。
   */
  let blog: Blog | null = null;
  let projects: Blog | null = null;
  let about: ReturnType<typeof createAboutStore> | null = null;
  const blogOf = async (section: ArticleSection = "blog"): Promise<Blog> => {
    const { config, problems } = await publishing.config();
    if (config === null) throw new Error(problems.join("；") || "还没配过 destinations.json");
    if (section === "projects") {
      projects ??= createBlog(config, path.resolve(options.libraryRoot, "../projects-index.db"), section);
      return projects;
    }
    blog ??= createBlog(config, indexFileOf(path.resolve(options.libraryRoot, "..")));
    return blog;
  };
  // Loop 项目与书架、稿子架、context 库并列：一个项目一个目录，里面一份 `loop.md`
  // 和一摞 `runs/`。**建项目就是往这儿放一个目录**——没有「新建」按钮那条路。
  const loops = createLoopStore(path.resolve(options.libraryRoot, "../loops"));

  /**
   * Loop 的秒表。
   *
   * **每分钟问一次「谁该跑了」，而不是每分钟跑一轮。** 该不该跑由 `due` 按上一轮的
   * 时间算（间隔以小时计），所以叫得勤只是多读几个小文件，不会多花一分钱。
   *
   * 项目**默认是关着的**，人明确开一次才会动——所以这根线接上本身不会让应用开始花钱。
   */
  const TICK_MS = 60_000;
  let sweeping = false;
  /** 上次清回收站的时刻。**0 表示还没清过**，所以第一轮秒表就会清一次。 */
  let purgedAt = 0;
  const ticker = setInterval(() => {
    // 上一次扫还没扫完就跳过这一次。**跟调度自己那条规矩一样**：不排队、不并行——
    // 排起来的话，一轮卡住会攒出一串，等它一通就全炸出来。
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      try {
        /**
         * 顺手清一次回收站（超过一个月的）。
         *
         * **一小时一次，不是一分钟一次**：规矩的粒度是 30 天，为它每分钟 readdir 一遍
         * 没有意义。挂在这个秒表上而不是另起一个，是因为「再开一个定时器」这件事
         * 本身要付的代价（关窗时要记得清、re-entrancy 要各管各的）比省下的多。
         */
        if (Date.now() - purgedAt > 60 * 60 * 1000) {
          purgedAt = Date.now();
          // 配置读不出来（还没写 destinations.json）时这一步跳过——**写不了博客
          // 不该让 Loop 那一侧也停**，所以单独 catch。
          const gone = await blogOf()
            .then((it) => it.purge(Date.now()))
            .catch(() => [] as string[]);
          if (gone.length > 0) console.log(`[blog] 回收站清掉 ${gone.length} 件（超过一个月）`);
        }

        const raw = await readFile(options.configFile, "utf8").catch(() => null);
        if (raw === null) return;
        // Loop 走**默认组**那个端点，不单列一档「能力」：能力表的门槛是「配了就真的
        // 生效」，而单列一档就得同时进设置页那张归属表，否则是个配不了的能力。
        //
        // 用 `createPlainChat` 而不是 `createModelClient`：**AI SDK 打不进主进程的
        // ESM bundle**（依赖链上的 `@vercel/oidc` 用动态 `require`，一加载应用就起不来）。
        const { baseURL, apiKey, model } = parseConfig(JSON.parse(raw)).default;
        if (baseURL === "" || model === "") return;

        // 每个项目的 task 上限不同，所以 agent 是**按项目**建的，不是全局一份。
        await sweep(
          loops,
          (settings) =>
            createLoopAgents(createPlainChat({ baseURL, apiKey, model }), {
              taskBudgetUsd: settings.taskCapUsd,
            }),
          Date.now(),
          model,
        );

      } catch (cause) {
        // **不往上抛。** 这是个定时器回调，抛出去就是一个 unhandled rejection，
        // 在 Electron 主进程里足以把整个应用带下去——而它只是一次没跑成的巡查。
        console.error("[loop] 巡查出错", errorChain(cause));
      } finally {
        sweeping = false;
      }
    })();
  }, TICK_MS);
  // 定时器不 unref 的话，dev 下 Ctrl-C 之后进程不会退出。
  ticker.unref();


  // 懒建：没人问文档时不该把 300 MB 加载进来。
  let embedder: Embedder | null = options.embedder ?? null;

  // 两个本地引擎，共用一份 llama.cpp 二进制：识别（ADR-0015，可选）与向量（问文档要用）。
  // 懒建：没人用时连依赖都不构造——构造函数里就会因为平台不支持而抛。
  let engine: ReturnType<typeof createLocalEngine> | null = null;
  let vectorEngine: ReturnType<typeof createLocalEngine> | null = null;
  const engineRoot = path.join(options.modelsRoot, "llama");

  // 上一次没退干净留下的引擎，开机先收掉（`engine-registry.ts`）。
  const registry = createFileEngineRegistry(path.join(engineRoot, "running.json"));
  // **拉起新引擎之前必须等它做完。** 收尸是「读账本 → 杀 → 清空」，中间新记的一条会被
  // 那次清空吞掉——于是这个新引擎再没人认得，下次启动收不到它。
  const reaped = registry
    .reap()
    .then((count) => {
      if (count > 0) console.error(`[engine] 收掉 ${count} 个上次没退干净的 llama-server`);
    })
    .catch(() => undefined);

  const routes: Route[] = [
    {
      prefix: ROUTES.engine,
      handler: (request, response) =>
        respond(response, async () => {
          if (request.method === "DELETE") {
            engine?.stop();
            return json({ running: false, baseURL: null });
          }
          if (request.method === "POST") {
            await reaped;
            engine ??= createLocalEngine(
              llamaEngineDeps(engineRoot, RECOGNITION_SPEC, (text) => (enginePhase = text), registry),
            );
            // 1.7 GB 的下载 + 加载，不能把一个请求挂住——立刻返回，进度靠轮询。
            void engine.ensureReady().catch((error: unknown) => {
              enginePhase = errorChain(error) || "本地识别引擎启动失败";
            });
            return json({ ...engineStatus(), phase: enginePhase });
          }
          return json({ ...engineStatus(), phase: enginePhase });
        }),
    },

    {
      /**
       * 允许在应用内加载的站点（`web/allow.ts`）。
       *
       * **不做「任意网站」的默认开放**——Electron 里 Safe Browsing 与 Certificate
       * Transparency 都是关的，官方自己说「要显示网站，浏览器是更安全的选择」。
       * 所以这是一份读者显式加进来的白名单，落在书架根上（跟标签一份，它是读者的
       * 习惯，不属于某一本书）。
       */
      prefix: ROUTES.sites,
      handler: (request, response) =>
        respond(response, async () => {
          const file = path.join(options.libraryRoot, "sites.json");
          if (request.method === "POST") {
            await writeFile(file, await readBody(request), "utf8");
            return json({});
          }
          // 没有这个文件是正常状态：还没加过任何站点。
          return { type: JSON_TYPE, data: await readFile(file, "utf8").catch(() => "[]") };
        }),
    },

    /**
     * Loop。
     *
     * **建项目靠往 `<library>/../loops/<名字>/` 里放一份 `loop.md`**——文件是唯一真相
     * 且允许手改（ADR-0011），两段 prompt 本来就该在编辑器里写，不该在一个表单里敲。
     *
     * 唯一会写的是开关，而且它写的是一个**单独的标记文件**，不碰 `loop.md`：那里面
     * 是人手写的 prompt，界面去回写它，一次撞车就可能盖掉正在改的字。
     */
    {
      prefix: ROUTES.loops,
      handler: (request, response) => {
        const [project, what, which] = segments(request);
        respond(response, async () => {
          if (!project) return json(await loops.projects());
          if (what === "enabled") {
            if (request.method === "POST") {
              await loops.setEnabled(project, (await readBody(request)) === "true");
              return json({});
            }
            return json(await loops.enabled(project));
          }
          if (what === "runs" && which) return json(await loops.runDetail(project, Number(which)));
          if (what === "runs") return json(await loops.runs(project));
          return json(await loops.settings(project));
        });
      },
    },

    /**
     * 同步：把统一目录现在这一份推到一个**云端站点**（`blogstudio/src/publish/`）。
     *
     * 两段：构建 → 同步。**只有第二段不可逆**（`rsync --delete`），所以它在
     * `CloudSite.sync` 里自己还有一道 probe。
     *
     * `GET /__publish` 列去处 + 同步账本；`GET /__publish/<去处>` 干跑（会先构建，
     * **不写远端**）；`POST` 同一条路径才真跑。干跑与真跑分成两次请求：中间隔着一个人
     * 看删除清单。
     */
    {
      prefix: ROUTES.publish,
      handler: (request, response) => {
        const [name] = segments(request);
        respond(response, async () => {
          const { config, problems } = await publishing.config();
          if (!name) {
            return json({
              destinations: config?.destinations ?? [],
              problems,
              syncs: await publishing.syncs(),
            });
          }
          if (config === null) throw new Error(problems.join("；") || "还没配过去处");

          if (name === "_about") {
            about ??= createAboutStore(path.join(config.repo, config.site));
            if (request.method === "GET") return json(await about.read());
            if (request.method !== "POST") throw new Error("About 只支持读取和保存");
            const body = JSON.parse(await readBody(request));
            return json(await about.save(body.language, body.content, body.revision));
          }

          const destination = config.destinations.find((one) => one.name === name);
          if (!destination) throw new Error(`没有叫「${name}」的去处`);

          /**
           * 这个去处的图片怎么走。
           *
           * `destination.images` 没写 = 图跟着 rsync（`.com`）；写了 = 传 OSS（`.cn`）。
           * **要传哪几张从索引算**：只算这次会上线的那些文章用到的图
           * ——这就是「针对性」。
           */
          const imageSide = async (): Promise<ImageSide> => {
            const collections = await Promise.all([blogOf(), blogOf("projects")]);
            const needed: string[] = [];
            for (const it of collections) {
              await it.refresh();
              needed.push(...it.index.imagesOf(it.index.articles().filter(one => !one.draft).map(one => one.slug)));
            }
            return {
              target: destination.images === undefined ? null : createOssImages(destination.images),
              needed: [...new Set(needed)],
              dir: path.join(config.repo, config.site, "static/images"),
            };
          };

          /**
           * 构建前清掉不属于任何去处的 `public-*`。去处改个名，旧目录就成了没人碰的
           * 70 MB（`build.ts` 的 `staleOutDirs`）。配置已经确认读出来了（上面那句
           * `config === null` 就抛），所以这里的去处表不会是「读不出来」的空表。
           */
          const siteRoot = path.join(config.repo, config.site);
          for (const dir of staleOutDirs(await readdir(siteRoot).catch(() => []), config.destinations)) {
            await rm(path.join(siteRoot, dir), { recursive: true, force: true });
          }

          const site = createSshSite(destination);
          if (request.method !== "POST") {
            return json(await previewSync(config, destination, site, runHugo, await imageSide()));
          }
          const out = await syncOnly(config, destination, site, runHugo, await imageSide());
          const at = Date.now();
          await publishing.recordSync(name, {
            at,
            added: out.changes.added.length,
            changed: out.changes.changed.length,
            deleted: out.changes.deleted.length,
          });
          return json({ ...out, at });
        });
      },
    },

    /**
     * 博客：**统一目录里那 92 篇**（ADR-0005）。
     *
     * `GET /__blog` 列全部（在架的和下架的都在）；
     * `POST /__blog/<slug>/<动作>` 改一篇——`retag` / `withdraw` / `promote` / `remove`。
     *
     * **这几条一个字节都不出这台机器。** 云端只在 `POST /__publish/<去处>` 那一下才变。
     */
    {
      prefix: ROUTES.blog,
      handler: (request, response) => {
        const [slug, action] = segments(request);
        respond(response, async () => {
          const section = articleSection(new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("section"));
          const it = await blogOf(section);

          /**
           * 粘一张图进编辑器。**存本地，回一个相对路径。**
           *
           * 走原始字节而不是 JSON：一张截图 base64 之后会胖三分之一，而它要经过
           * 一次 HTTP、一次 JSON.parse、一次解码——为了省事让每张图多绕这几道不值。
           * 文件名从查询串来（剪贴板里的图常常连文件名都没有，那就交给它去猜扩展名）。
           */
          /**
           * 回收站。`GET` 列（**顺手清掉超过一个月的**），
           * `POST /__blog/trash/<文件名>` 放回来。
           */
          if (slug === "trash") {
            if (request.method !== "POST") return json(await it.trash(Date.now()));
            if (!action) throw new Error("缺少要放回来的那一件");
            return json({ slug: await it.restore(action) });
          }

          if (slug === "images") {
            // 没人用的图：`GET /__blog/images/orphans` 列，`DELETE /__blog/images/<名字>` 删。
            // **列不删、删要人按**——一张图今天没人用，可能是某篇还在下架。
            if (action === "orphans") {
              const other = await blogOf(section === "blog" ? "projects" : "blog");
              await other.refresh();
              return json((await it.orphanImages()).filter(name => other.index.using(name).length === 0));
            }
            if (request.method === "DELETE") {
              if (!action) throw new Error("缺少要删的那张图");
              const other = await blogOf(section === "blog" ? "projects" : "blog");
              await other.refresh();
              if (other.index.using(action).length > 0) throw new Error("另一栏目仍在使用这张图片，不能删除");
              await it.removeImage(action);
              return json({});
            }
            if (request.method !== "POST") return json(await it.images.list());
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const saved = await it.images.put(
              await readBytes(request),
              url.searchParams.get("name") ?? "",
            );
            return json({ url: saved });
          }

          if (!slug) {
            await it.refresh();
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const q = (url.searchParams.get("q") ?? "").trim();
            const all = it.index.articles();
            // **空搜索是「不筛」**，不是「一篇都不给」——输入框清空的那一刻要回到全部。
            const hit = q === "" ? null : new Set(it.index.search(q));
            return json({
              articles: hit === null ? all : all.filter((one) => hit.has(one.slug)),
              // 标签空间：tags 与 categories 合在一起（`index-db.ts` 的 `labels`）。
              labels: it.index.labels(),
            });
          }
          if (request.method !== "POST") {
            const one = await it.articles.load(slug);
            if (one === null) throw new Error(`没有「${slug}」这一篇`);
            return json(one);
          }

          const body = await readBody(request);
          const now = Date.now();
          if (action === "move") {
            const { config } = await publishing.config();
            if (!config) throw new Error("还没配过去处");
            await moveArticle(config, slug, section, body);
            await it.refresh();
            await (await blogOf(articleSection(body))).refresh();
          } else if (action === "retag") {
            await it.retag(slug, JSON.parse(body) as string[]);
          } else if (action === "withdraw") {
            await it.withdraw(slug, body === "true");
          } else if (action === "promote") {
            // 库读不到就传空池：`promote` 会把认不出的 id 原样留着并报上来，
            // **不会悄悄删掉，也不会编一条参考**。
            const pool = await studio
              .view()
              .then((view) => view.contexts)
              .catch(() => []);
            return json(await it.promote(slug, pool, now));
          } else if (action === "rename") {
            await it.rename(slug, body);
          } else if (action === "remove") {
            return json({ trashed: await it.remove(slug, now) });
          } else if (action === "save") {
            const next = JSON.parse(body) as { title: string; markdown: string };
            const had = await it.articles.load(slug);
            if (had === null) throw new Error(`没有「${slug}」这一篇`);
            await it.articles.save({ ...had, ...next });
            await it.refresh();
          } else {
            throw new Error(`不认识的动作：${action}`);
          }
          return json({});
        });
      },
    },

    { prefix: ROUTES.model, handler: (request, response) => void forwardModel(request, response) },

    {
      prefix: ROUTES.config,
      handler: (request, response) =>
        respond(response, async () => {
          if (request.method === "POST") {
            await writeFile(options.configFile, await readBody(request), "utf8");
            return json({});
          }
          // 文件不存在返回 null 而不是报错：首次运行还没配任何东西是正常状态。
          return { type: JSON_TYPE, data: await readFile(options.configFile, "utf8").catch(() => "null") };
        }),
    },

    {
      prefix: ROUTES.docs,
      handler: (request, response) => {
        const [docId, action] = segments(request);
        respond(response, async () => {
          if (request.method === "POST" && !docId) {
            const filename = decodeURIComponent(String(request.headers["x-filename"] ?? "未命名.pdf"));
            return json(await shelf.import({ filename, bytes: await readBytes(request), at: Date.now() }));
          }
          if (!docId) return json(await shelf.list());
          if (request.method === "DELETE") {
            await shelf.remove(docId);
            return json({});
          }
          if (action === "title") {
            await shelf.rename(docId, await readBody(request));
            return json({});
          }
          return { type: "application/pdf", data: Buffer.from(await shelf.read(docId)) };
        });
      },
    },

    {
      // 标签表落在书架根上，不在某本书里——「存疑」在这篇和那篇是同一件事。
      prefix: ROUTES.tags,
      handler: (request, response) => {
        respond(response, async () => {
          if (request.method === "POST") {
            await tags.save(JSON.parse(await readBody(request)));
            return json({});
          }
          return json(await tags.load());
        });
      },
    },

    {
      // 生成的目录，落在这本书自己的文件夹里（同摘录，删书就跟着没）。
      prefix: ROUTES.outline,
      handler: (request, response) => {
        const [docId] = segments(request);
        respond(response, async () => {
          if (!docId) throw new Error("缺少 docId");
          if (request.method === "POST") {
            await outlines.save(docId, JSON.parse(await readBody(request)));
            return json({});
          }
          if (request.method === "DELETE") {
            await outlines.remove(docId);
            return json({});
          }
          return json(await outlines.load(docId));
        });
      },
    },

    {
      prefix: ROUTES.clips,
      handler: (request, response) => {
        const [docId, clipId] = segments(request);
        respond(response, async () => {
          if (!docId) throw new Error("缺少 docId");
          if (request.method === "POST") {
            await store.save(docId, deserialize<Clip>(await readBody(request)));
            return json({});
          }
          if (request.method === "DELETE" && clipId) {
            await store.delete(docId, clipId);
            return json({});
          }
          return {
            type: JSON_TYPE,
            data: `[${(await store.listByDoc(docId)).map(serializeClip).join(",")}]`,
          };
        });
      },
    },

    {
      prefix: ROUTES.contexts,
      handler: (request, response) => {
        // 前缀已被剥掉（vite middlewares 与 electron 那边都守这个约定）。
        const [action, id] = segments(request);
        respond(response, async () => {
          if (request.method === "POST" && action === "topics" && id) {
            await studio.update(id, JSON.parse(await readBody(request)) as { topics: string[] });
            return json({});
          }
          // 临时桥：把书架里已入库（promoted）的摘录扫成 context。
          //
          // **这不是 ADR-0002 说的那条导出层**，那条归 PDF Studio、还在另一条线程手里
          // （`.scratch/knowledge-graph/issues/01`）。在它落地之前，知识库拿不到任何真实
          // 数据，图页面就只是一张白纸——所以先有这个。落地之后**删掉这一段**。
          //
          // 它守住了 ADR-0002 的两条硬要求：id 由 `(docId, clipId)` 派生所以重扫幂等；
          // 不填 topics，主题由读者在这一侧定。
          if (request.method === "POST" && action === "sweep") {
            let added = 0;
            for (const doc of await shelf.list()) {
              const clips = await store.listByDoc(doc.id);
              const contexts: Context[] = clips
                .filter((clip) => clip.state === "promoted" && clip.sourceText !== null)
                .map((clip) => ({
                  id: `${doc.id}__${clip.id}`,
                  sourceClipId: clip.id,
                  source: { docId: doc.id, title: doc.title, locator: `p.${clip.region.page}` },
                  claim: clip.title,
                  evidence: clip.sourceText ?? "",
                  stance: null,
                  status: "pending",
                  sourceClipDeleted: false,
                  topics: [],
                }));
              added += (await studio.ingest(doc.id, contexts)).added;
            }
            return json({ added });
          }
          if (action === "focus" && id) return json(await studio.focus(id));
          return json(await studio.view());
        });
      },
    },

    {
      prefix: ROUTES.drafts,
      handler: (request, response) => {
        const [id] = segments(request);
        respond(response, async () => {
          /**
           * **Writer 直接编辑统一目录**（ADR-0005）。老的 `drafts/<uuid>.md` 退休了，
           * 一个目录、一套「未完成」——「下架」就是从前的「稿子」。
           *
           * 配置读不出来（还没写 `destinations.json`）就报错，**不再回退到老目录**：
           * 回退意味着一个配置错字就会让字悄悄写到另一个地方，而人以为写进了博客。
           * 报出来的那句话（`blogOf` 抛的）会说清楚缺的是哪份文件。
           */
          const store = draftsOnArticles((await blogOf()).articles);

          if (request.method === "POST") {
            await store.save(JSON.parse(await readBody(request)) as Draft);
            return json({});
          }
          if (request.method === "DELETE") {
            if (!id) throw new Error("缺少稿子的 id");
            await store.remove(id);
            // 这条路绕过了 `blog.remove`，索引要自己刷——否则列表在下一次整扫之前还挂着它。
            await (await blogOf()).refresh();
            return json({});
          }
          // 不给 id 就是要整个稿子架；给了就是要这一篇的正文。
          return json(id ? await store.load(id) : await store.list());
        });
      },
    },

    {
      // 正文向量缓存，落在这篇文档自己的文件夹里（ADR-0011 的形状）。删文档时跟着
      // 一起没，不需要另外清。
      prefix: ROUTES.index,
      handler: (request, response) => {
        const [docId] = segments(request);
        const file = path.join(options.libraryRoot, docId ?? "", "index-vectors.json");
        respond(response, async () => {
          if (!docId) throw new Error("缺少 docId");
          if (request.method === "POST") {
            // 同 `tag-store` / `outline-store`：**写之前保证目录在**，不靠上面那句
            // 启动时的 `mkdirSync`。这一处是四个里唯一没有自己 store 的——向量缓存
            // 就一个 JSON，不值得为它抽一层，所以 mkdir 只能写在这儿。
            // 失败的样子最不响：索引存不下去，读者每次开这本书都要重算一两分钟，
            // 而没有任何一处会说这是为什么。
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, await readBody(request), "utf8");
            return json({});
          }
          return { type: JSON_TYPE, data: await readFile(file, "utf8").catch(() => "null") };
        });
      },
    },


    {
      // 权重按静态文件服务。**不能用 dev: true**——那个选项专门关掉缓存头，于是每次
      // 刷新都要重新传 300 MB。权重不可变（模型 id + 文件名唯一确定内容），永久缓存。
      prefix: ROUTES.models,
      handler: sirv(options.modelsRoot, { etag: true, maxAge: 31536000, immutable: true }),
    },

    {
      // pdf.js 的 CMap / 标准字体 / wasm / ICC。走本机 API 而不是相对路径：打包后页面
      // 是 file://，没有 origin 可依（同 api-base.ts 的理由）。
      // 内容随 pdf.js 版本固定，永久缓存。
      prefix: ROUTES.pdfjs,
      handler: sirv(options.pdfjsRoot, { etag: true, maxAge: 31536000, immutable: true }),
    },

    {
      prefix: ROUTES.embed,
      handler: (request, response) =>
        respond(response, async () => {
          if (!embedder) {
            // 向量走 llama-server，不再走 onnxruntime-node——后者在 Electron 的进程里
            // 根本跑不起来（主进程 EXC_BREAKPOINT，utilityProcess 同一个信号）。
            // 首次会下 318 MB 权重并加载，进度经 enginePhase 报出去。
            await reaped;
            vectorEngine ??= createLocalEngine(
              llamaEngineDeps(engineRoot, EMBEDDING_SPEC, (text) => (enginePhase = text), registry),
            );
            const { baseURL } = await vectorEngine.ensureReady();
            embedder = createLlamaEmbedder(baseURL);
          }

          const { kind, texts } = JSON.parse(await readBody(request)) as {
            kind: "query" | "documents";
            texts: string[];
          };
          const vectors =
            kind === "query" ? [await embedder.embedQuery(texts[0])] : await embedder.embedDocuments(texts);

          // 一整块二进制回去，不逐条写 JSON 数组：97 段 × 768 维写成十进制是几 MB 文本。
          const dims = vectors[0]?.length ?? 0;
          const flat = new Float32Array(dims * vectors.length);
          vectors.forEach((vector, index) => flat.set(vector, index * dims));
          return json({ dims, data: Buffer.from(flat.buffer).toString("base64") });
        }),
    },
  ];

  return {
    // **在收口处统一挡，不逐条路由加。** 逐条加就是「漏一条就默认开门」，
    // 而这类洞会一直长出来（同 `clip.ts` 里 GUARDS 那张表的理由）。
    routes: routes.map((route) => ({
      prefix: route.prefix,
      handler: (request, response) => {
        if (!authorize(request.method, request.headers, options.token)) {
          response.statusCode = 403;
          response.end("需要令牌。");
          return;
        }
        route.handler(request, response);
      },
    })),
    shutdown(): void {
      // 两个都要停。此前 `vectorEngine` 连一条 stop 的路径都没有——问过一次文档之后，
      // 那 300 MB 会一直挂到关机，而没有任何界面提到它的存在。
      engine?.stop();
      vectorEngine?.stop();
      // 秒表也要停：dev 下 vite 重启一次留下一个，几次之后同一个项目会被好几根
      // 定时器同时巡查——它们各自都以为自己是唯一那一根。
      clearInterval(ticker);
    },
  };
}

/** 引擎当前在做什么（下载哪个文件、启动到哪一步），或上一次失败的原因。 */
let enginePhase: string | null = null;

const JSON_TYPE = "application/json";
const json = (data: unknown) => ({ type: JSON_TYPE, data: JSON.stringify(data) });

function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const readBody = async (request: IncomingMessage): Promise<string> =>
  (await readBytes(request)).toString("utf8");

/** 路径切成段，顺带解码——文件名和书名可能是中文。 */
const segments = (request: IncomingMessage): string[] =>
  (request.url ?? "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);

/** 把一条 handler 的成败统一收口，别让异常悄悄变成 200。 */
function respond(
  response: ServerResponse,
  body: () => Promise<{ type: string; data: string | Buffer }>,
): void {
  body()
    .then(({ type, data }) => {
      response.setHeader("content-type", type);
      response.end(data);
    })
    .catch((error: Error) => {
      // 500 + 原因。静默成功会让调用方以为已落盘（内存有、磁盘空）
      // ——ADR-0011 说文件才是唯一真相。
      response.statusCode = 500;
      response.end(error.message);
    });
}

/**
 * 把模型端点转发一道，**目标由调用方在路径里给**：`/__model/<编码过的 baseURL>/...`。
 *
 * 起初这里是写死到配置里默认组的地址。那样一来「每个功能各配各的端点」（ADR-0010）
 * 就是假的——给识别配了本地端点，请求照样发去云端，而设置页的自检还会说「通了」。
 *
 * 为什么需要转发：实测那个端点的 OPTIONS 预检返回 403、也没有任何 access-control-*
 * 头，浏览器直连必被拦在预检那一步。
 */
async function forwardModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const [encoded, ...rest] = (request.url ?? "/").split("?")[0].split("/").filter(Boolean);
    const query = (request.url ?? "").includes("?") ? `?${(request.url ?? "").split("?")[1]}` : "";
    const target = `${decodeURIComponent(encoded ?? "")}/${rest.join("/")}${query}`;
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await readBytes(request));

    const upstream = await fetch(target, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers)
          // host 必须去掉，否则上游按它路由会 404；content-length 让 fetch 自己算。
          .filter(([name]) => name !== "host" && name !== "content-length")
          .map(([name, value]) => [name, String(value)]),
      ),
      body,
    });

    // 上游自己返的错要留痕。**「502 是我们抛的还是上游返的」在外面根本分不清**——
    // 两边都叫 Bad Gateway，而 SDK 只报状态行、不报响应体，于是界面上永远是同一句话。
    // 只记方法、路径、body 大小和状态：**不记 header**，Authorization 就在里面。
    if (!upstream.ok) {
      console.error(
        `[__model] 上游 ${upstream.status} ${new URL(target).pathname} body=${body?.byteLength ?? 0}B`,
      );
    }

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      // 别把上游的 content-encoding 透出去：fetch 已经解过压，再声明一次浏览器会解第二遍。
      if (name !== "content-encoding" && name !== "content-length") response.setHeader(name, value);
    });
    // 流式转发，不整块 buffer：chat 走 SSE，缓冲会把「边生成边显示」变成「转圈半天
    // 然后一次性出现」，而那正是 ADR-0008 选 assistant-ui 要的东西。
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as ReadableStream), response);
    else response.end();
  } catch (error) {
    response.statusCode = 502;
    // **要整条链**：undici 把一切都叫 `fetch failed`，真正的原因（`ECONNRESET`、
    // 证书、DNS）只活在 `cause` 里。只回那五个字的时候，界面上就只剩「模型调用失败」，
    // 从那儿是查不下去的——这一条真的挡了一次目录识别。
    const why = errorChain(error) || (error as Error).message;
    // 也写一份到主进程日志：SDK 只把状态行（"Bad Gateway"）往上报，响应体它不看，
    // 所以光靠回给浏览器的这段文字，界面上还是什么都看不到。
    console.error(`[__model] 转发失败 ${why}`);
    response.end(why);
  }
}

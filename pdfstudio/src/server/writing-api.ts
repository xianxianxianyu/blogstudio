import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorChain } from "../app/error-chain";
import { createContextStudio, type ContextStudio } from "../../../contextstudio/src/api";
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
import { createLoopStore } from "../../../blogstudio/src/loop/loop-store";
import { sweep } from "../../../blogstudio/src/loop/sweep";
import { createLoopAgents } from "../../../blogstudio/src/loop/agents";
import { createPlainChat } from "../model/plain-chat";
import { parseConfig } from "../config/config";
import type { Draft } from "../../../blogstudio/src/draft";
import { JSON_TYPE, forwardModel, json, readBody, readBytes, respond, segments, type Route } from "./http";

/**
 * 本机 API 的**写作那一半**：配置、模型转发、context、文章、Loop、去处与同步。
 *
 * 与 PDF 那一半（`local-api.ts`：书架、摘录、本地引擎、pdf.js 静态资源、向量）分开建，
 * 是因为它要**单独部署**：`research.moyutianzun.com/write` 上跑的就只有这一半——
 * 那台机器上没有书、没有 llama.cpp、没有 Electron。桌面版与 dev server 两半都挂。
 *
 * 一切都住在一个数据根下：`<dataRoot>/{config.json, destinations.json, published.json,
 * contexts/, loops/, blog-index.db, projects-index.db}`。
 */
export interface WritingApiOptions {
  /** 数据根。桌面版是 userData，dev 是 `pdfstudio/`，VPS 上是 `/srv/blogstudio`。 */
  dataRoot: string;
  /** 配置文件（含 apiKey，只在本机流动）。通常就在 dataRoot 下，单列是因为桌面版把它单列。 */
  configFile: string;
  /**
   * 把书架里已入库的摘录扫成 context 的那条桥（`/__contexts/sweep`）。**归 PDF 那一半**，
   * 由它传进来；没传 = 这边没有书架，扫就是报错。
   */
  contextSweep?: (studio: ContextStudio) => Promise<{ added: number }>;
}

export const WRITING_ROUTES = {
  config: "/__config",
  model: "/__model",
  contexts: "/__contexts",
  drafts: "/__drafts",
  loops: "/__loops",
  publish: "/__publish",
  blog: "/__blog",
} as const;

export interface WritingApi {
  routes: Route[];
  /** 停掉 Loop 的秒表。dev 下 vite 重启一次留下一个，几次之后同一个项目会被好几根定时器同时巡查。 */
  shutdown(): void;
}

export function createWritingApi(options: WritingApiOptions): WritingApi {
  const ROUTES = WRITING_ROUTES;
  const dataRoot = options.dataRoot;

  // Context Studio 的库与书架**并列**，不在书架里面：一条 context 可以来自任何一本书，
  // 甚至将来来自网页，塞进某本书的文件夹就等于宣布它属于那本书（ADR-0002）。
  const studio = createContextStudio(path.join(dataRoot, "contexts"));

  // 去处与发布账本，落在数据目录的根上：它们既不属于某本书，也不属于某一篇稿子。
  const publishing = createPublishStore(dataRoot);

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
      projects ??= createBlog(config, path.join(dataRoot, "projects-index.db"), section);
      return projects;
    }
    blog ??= createBlog(config, indexFileOf(dataRoot));
    return blog;
  };
  // Loop 项目与书架、稿子架、context 库并列：一个项目一个目录，里面一份 `loop.md`
  // 和一摞 `runs/`。**建项目就是往这儿放一个目录**——没有「新建」按钮那条路。
  const loops = createLoopStore(path.join(dataRoot, "loops"));

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

  const routes: Route[] = [
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
          if (request.method === "POST" && action === "sweep") {
            // 扫书架那条桥归 PDF 那一半（`local-api.ts` 传进来）；没接就是没有书架可扫。
            if (!options.contextSweep) throw new Error("这边没有书架可扫");
            return json(await options.contextSweep(studio));
          }
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
  ];

  return {
    routes,
    shutdown: () => clearInterval(ticker),
  };
}

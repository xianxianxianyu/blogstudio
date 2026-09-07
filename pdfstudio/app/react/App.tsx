import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { Workspace } from "../../src/app/workspace";
import type { Settings } from "../../src/app/settings";
import type { Conversation } from "../../src/app/conversation";
import type { Progress } from "../../src/app/progress";
import type { PdfHost } from "./pdf-host";
import { ShelfPage } from "./ShelfPage";
import { ContextStudioPage } from "./ContextStudioPage";
import type { DeskKind } from "../../src/app/desk";
import { LoopsPage } from "./LoopsPage";
import { LoopPage } from "./LoopPage";
import { PublishPage } from "./PublishPage";
import type { LoopReader } from "../http-loops";
import type { Publishing } from "../http-publish";
import type { BlogClient } from "../http-blog";
import { PageView, type Busy } from "./PageView";
import { ClipsPane } from "./ClipsPane";
import { readOutline } from "./outline";
import { TocWizard } from "./TocWizard";
import { bookmark, shiftSections, type Section } from "../../src/clip/outline";
import { fitScale } from "../../src/app/fit";
import {
  closeOnDesk,
  closeSettings,
  isReading,
  isWriting,
  openDocOnDesk,
  openDraftOnDesk,
  openSettings,
  rememberOnDesk,
  type Active,
  type DeskItem,

  openLoopOnDesk,} from "../../src/app/desk";
import { Shell } from "./Shell";
import { useRemembered } from "./remember";
import { WebPane } from "./WebPane";
import { allows } from "../../src/web/allow";
import { pageIdOf } from "../../src/web/page-id";
import { openPageOnDesk } from "../../src/app/desk";
import type { SiteStore } from "../http-sites";
import type { ModelClient } from "../../src/model/model-client";
import { errorChain } from "../../src/app/error-chain";
import { ChatPanel } from "./ChatPanel";
import { SettingsPage } from "./SettingsPage";
import type { SettingsPage as SettingsPageId } from "../../src/app/settings-map";
import { SelectionMenu } from "./SelectionMenu";
import { PageMenu } from "./PageMenu";
import { PageJump } from "./PageJump";
import { WriterPage } from "./WriterPage";
import { DraftPage } from "./DraftPage";
import type { Writer } from "../../../blogstudio/src/writing";
import type { WritingTalk } from "../../../blogstudio/src/conversation";
import type { Context } from "../../../contextstudio/src/context";

/**
 * 两层：**书架页**（有哪些书）与**阅读页**（读这一本）。
 *
 * 此前它们挤在同一屏——书架塞在阅读页的侧栏里，换一本书要先进入某本书，层级是反的。
 * 现在书架是外层，阅读是内层。
 *
 * **设置与它们平级**，不是盖在上面的一层（ADR-0005 决策 3）。它此前是个 `<dialog>`
 * 覆盖层，那让它在结构上比别的都特殊，而它并不特殊——它有自己的子页和自己的来路。
 *
 * 组件仍然只是 `ws.state` 的投影：**规则、顺序、落盘都不在这里**（ADR-0013）。
 * 这次重排一行应用层代码都没动，那正是当初抽 Workspace 的回报。
 */
/**
 * 案头上每一种条目的名字。加一种 `DeskKind` 就得在这儿写一行，漏了是 TS 报错。
 *
 * 书和稿子要去各自的架子上查（名字会改，也会被删）；网页和 loop 项目的名字就在
 * 条目自己身上，查无可查。
 */
type Shelves = {
  docs: { id: string; title: string }[];
  writing: { openId: string | null; title: string; drafts: { id: string; title: string }[] };
};

const TITLE_OF: {
  [K in DeskKind]: (item: Extract<DeskItem, { kind: K }>, at: Shelves) => string;
} = {
  doc: (item, at) => at.docs.find((one) => one.id === item.id)?.title ?? "（这本书没了）",
  // 正开着的那篇用它的实时名字：改了标题，案头那一行要跟着变。
  draft: (item, at) =>
    (at.writing.openId === item.id
      ? at.writing.title
      : at.writing.drafts.find((one) => one.id === item.id)?.title) ?? "（这篇稿子没了）",
  // 网页和 loop 项目的名字就在条目自己身上，架子上查无可查。
  page: (item) => (item.title !== "" ? item.title : item.url),
  loop: (item) => item.id,
};

const titleOf = (item: DeskItem, at: Shelves): string =>
  (TITLE_OF[item.kind] as (item: DeskItem, at: Shelves) => string)(item, at);

export function App({
  ws,
  host,
  settings,
  conversation,
  progress,
  tocModel,
  localTocOcr,
  siteStore,
  contextStudio,
  loops,
  publishing,
  blog,
  writer,
  talk,
  contexts,
}: {
  ws: Workspace;
  host: PdfHost;
  settings: Settings;
  conversation: Conversation;
  progress: Progress;
  /** 知识库。与书架并列的第二个顶层页面，见 `ContextStudioPage`。 */
  contextStudio: ComponentProps<typeof ContextStudioPage>["studio"];
  /** Loop 项目，只读。建项目靠往 `loops/` 里放一份 `loop.md`。 */
  loops: LoopReader;
  publishing: Publishing;
  blog: BlogClient;
  /** 认扫描版目录页用的模型。现建而不是钉死一个——改完设置要立刻生效。 */
  tocModel: () => ModelClient;
  /** 本地 OCR，扫描版目录优先走它（云端对这个任务实测不可靠）。没有就返回 null。 */
  localTocOcr: () => Promise<ModelClient | null>;
  /** 允许在应用内加载的站点。**注入而不是自己去取**：App 不该知道本机 API 的地址。 */
  siteStore: SiteStore;
  /** 写这一侧的应用层：稿子架、正在写的那一篇、什么时候落盘（ADR-0004）。 */
  writer: Writer;
  /** 写的时候右边那栏的对话状态。与 `conversation`（问文档）各管各的一场。 */
  talk: WritingTalk;
  /**
   * 知识库现在有哪些 context。写这一侧要它：确定性检查拿正文里的 `[ctx:id]` 对着它核，
   * 右栏的空库提示也用它的条数。
   */
  contexts: () => Promise<Context[]>;
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => ws.subscribe(listener), [ws]),
    () => ws.state,
  );
  /**
   * 写这一侧的状态。**外壳要它只为了两件事**：案头上那一项叫什么，以及切走时把稿子
   * 存住。正文不在里面（它按键就变，见 `blogstudio/src/writing.ts`）。
   */
  const writing = useSyncExternalStore(
    useCallback((listener: () => void) => writer.subscribe(listener), [writer]),
    () => writer.state,
  );
  /**
   * 现在活着的是哪一样：三个根之一，还是某一本书 / 某一篇稿子。**都平级，没有模式这一层。**
   *
   * 此前是 `side` ＋ `reading` 两个布尔量表示这三种状态——四个组合里有一个是无意义的，
   * 而用不上的组合迟早会被写进某个条件判断。
   */
  const [active, setActive] = useState<Active>({ kind: "shelf" });
  /** 案头：手边开着哪些书。不落盘——「此刻手边有什么」，与筛选、折叠同一口径。 */
  const [desk, setDesk] = useState<DeskItem[]>([]);
  /**
   * 设置停在哪一子页。**开没开在 `active` 里**（`{ kind: "settings"; from }`），
   * 这里只记「停在哪一页」——退出去再进来还在刚才那一页，那是设置页该有的记性。
   */
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>("model");
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<"clips" | "chat">("clips");
  /**
   * 右栏开着没有。**默认开着**——摘录是这一页的主要产物，默认藏起来等于让读者
   * 第一次进来就得先找到它。收起来这件事得是读者自己说的。
   */
  const [sideOpen, toggleSide, setSideOpen] = useRemembered("side-open", true);

  /**
   * 切到右栏的哪一栏，**并且保证右栏是开着的**。
   *
   * 四处「划完就切到摘录」原来直接调 `setPane`。右栏能收起来之后，它们在收起状态下
   * 全都变成了空动作：框完一个摘录，屏幕上什么都不发生，而摘录其实已经存下了。
   * 收起来说的是「现在不用」，**框一个摘录恰恰是在说现在要用**——所以这里是打开，
   * 不是不管。
   *
   * 「打开一本书时恢复上次那一栏」不走这里：那是恢复状态，不是一个动作的结果。
   */
  const showPane = (which: "clips" | "chat") => {
    setPane(which);
    setSideOpen(true);
  };
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  /**
   * 渲染倍率。**默认「适应宽度」**——`fit` 是让这一页正好铺满左栏的那个倍率，
   * 而 `scale` 一开始就等于它。
   *
   * 为什么不写死一个 1.5：页宽差得太远。这本 654 页的扫描书是 1586pt 宽，一篇论文
   * 612pt——同一个 1.5 对前者是「一屏只看得见半页」，对后者是「刚好」。
   */
  const [scale, setScale] = useState<number | null>(null);
  const [fit, setFit] = useState<number | null>(null);
  /** 还跟着窗口走吗。手动缩放过就不跟了，否则改完窗口大小会把读者的倍率冲掉。 */
  const [fitting, setFitting] = useState(true);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  /**
   * 捏合过程中的临时倍率。**手势中只做 CSS 缩放，松手才真的重渲染。**
   *
   * 触控板一次捏合会打出几十个事件，每个都重渲染 PDF 加重建文字层的话必然卡顿。
   * CSS 变换是白捡的：`at()` 与 `toPage()` 都按 `canvas.width / getBoundingClientRect().width`
   * 换算，被 CSS 缩放过照样对；文字层在同一个 `.frame` 里，一起缩放，也不会错位。
   */
  const [pinch, setPinch] = useState(1);
  /**
   * 这本书的目录，摘录按它归组。**三分之一的论文没有目录**（实测 ResNet 就没有），
   * 那时它是空数组，摘录栏退回按页排——那是正常路径，不是出错。
   */
  const [embedded, setEmbedded] = useState<Section[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  /**
   * `.stage` 那个 DOM 节点。**用回调 ref 存进 state，不用 `useRef`。**
   *
   * 切到 Context 那一侧再回来，阅读页是**新的 DOM 节点**。`useRef` 不会通知任何人，
   * 于是 ResizeObserver 和捏合的 wheel 监听都还挂在那个已经脱离文档的旧节点上——
   * 前者报 0 宽度、算出负倍率把画布搞塌，后者干脆彻底失灵。放进 state 之后，
   * 节点一换，依赖它的 effect 就重新挂。
   */
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  // 手势里要读当前 scale，但那个监听只挂一次，闭包会钉住旧值。同步进 ref 而不是
  // 在渲染期直接写（渲染期写 ref 会被 react-hooks/refs 拦下，理由也确实成立）。
  const scaleNow = useRef(scale);
  const fitNow = useRef(fit);
  useEffect(() => {
    scaleNow.current = scale;
    fitNow.current = fit;
  }, [scale, fit]);

  /**
   * 双指捏合缩放。
   *
   * **Electron 是 Chromium，触控板捏合到不了 touch 事件**——浏览器把它映射成
   * `ctrlKey` 为真的 wheel。必须 `preventDefault()`，否则 Chromium 会去缩放整个窗口，
   * 连右栏一起变大；而 React 的 `onWheel` 是 passive 的，`preventDefault` 会被忽略
   * 且只在 console 里警告，所以这里手动挂原生监听。
   */
  useEffect(() => {
    if (!stage) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let factor = 1;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return; // 普通滚动照旧翻页面
      const now = scaleNow.current;
      const base = fitNow.current;
      // 还没算出适宽（PDF 刚打开）时不缩放：那一刻的上下限没有基准。
      if (now === null || base === null) return;
      event.preventDefault();
      // 上下限跟按钮同一套：都相对适宽，半屏到五倍。
      const clamped = Math.min(base * 5, Math.max(base * 0.5, now * factor * Math.exp(-event.deltaY / 120)));
      factor = clamped / now;
      setPinch(factor);

      clearTimeout(settle);
      settle = setTimeout(() => {
        // 松手了才落成真的 scale：这一下才重渲染 PDF。
        setFitting(false);
        setScale(Number((now * factor).toFixed(3)));
        factor = 1;
        setPinch(1);
      }, 140);
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
      clearTimeout(settle);
    };
  }, [stage]);
  // 适宽倍率：左栏可用宽度 ÷ 页宽。
  useEffect(() => {
    if (!stage || pageWidth === null) return;
    const measure = () => {
      const next = fitScale(stage.clientWidth, pageWidth);
      // 算不出来就什么都不做，**不写一个凑合的数**——负倍率会把画布搞塌，
      // 而且顶栏还照样显示 100%，坏得一点声音都没有。
      if (next === null) return;
      setFit(next);
      // 只在「还跟着」时改倍率——手动缩放过就别再动它。
      setFitting((following) => {
        if (following) setScale(next);
        return following;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage, pageWidth]);

  /** 选区在视口坐标里的矩形。工具条绕开它找空位，不是盖在上面。 */
  /**
   * 打开一个网页。
   *
   * **地址不在白名单时不直接拒绝，也不直接放行**——问一次。直接拒绝的话读者要先去
   * 设置里加一条再回来，而他此刻手里就有那个地址；直接放行则等于没有白名单，而
   * Electron 里 Safe Browsing 和 Certificate Transparency 都是关的（ADR 里那条）。
   *
   * 加的是**站点**（协议 + 主机），不是这一个地址——读者要的是「这个站我信」，
   * 而不是一页一页地授权。
   */
  const openUrl = async (raw: string) => {
    // 没写协议就补 `https://`。**这一半没有歧义，所以自动做**；而「要不要补 www」
    // 有歧义，不在这儿猜——实测跳转两个方向都有（baidu 裸域→www，github www→裸域，
    // news.ycombinator.com 根本没有 www），所以那件事放到白名单里解决：
    // `X` 与 `www.X` 算同一个站（`web/allow.ts`）。
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let sites = await siteStore.load();

    if (!allows(sites, url)) {
      const origin = (() => {
        try {
          return new URL(url).origin;
        } catch {
          return null;
        }
      })();
      if (origin === null) {
        setError(`这不像一个网址：${raw}`);
        return;
      }
      if (!window.confirm(`${origin} 还不在允许的站点里。加进去并打开？`)) return;
      sites = [...sites, origin];
      await siteStore.save(sites);
    }

    // 身份用归一化过的 pageId，地址用原样的——同一篇文章从不同渠道点进来不该开两次。
    setDesk((was) => openPageOnDesk(was, pageIdOf(url), url, ""));
    setActive({ kind: "page", id: pageIdOf(url) });
  };

  const [menuAt, setMenuAt] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  /** 页面上右键的位置与当时选中的文字。加书签用（`PageMenu`）。 */
  const [context, setContext] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  // 换书回到第一页：页码是上一本的位置，留着会打开一个可能不存在的页。渲染期比较
  // 而不是写 effect——effect 里同步 setState 会触发级联渲染。
  const [openedDoc, setOpenedDoc] = useState(state.docId);
  if (openedDoc !== state.docId) {
    setOpenedDoc(state.docId);
    setPage(1);
    setSelected(null);
    setMenuAt(null);
    setError(null);
    // 上一本的目录留着的话，摘录会挂在另一本书的小节标题下面，而且不报错。
    setEmbedded([]);
    setTocOpen(false);
  }

  // 取目录。放 effect 里而不是跟着 openDoc 走：书也可能是导入时自动打开的，
  // 两条入口各写一份迟早漏一条。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const document = host.document;
      if (!document || state.docId === null) return;
      const outline = await readOutline(document);
      if (!cancelled) setEmbedded(outline);
    })();
    return () => {
      cancelled = true;
    };
  }, [host, state.docId]);

  const openDoc = async (id: string) => {
    // 打不开要说出来。此前这里没有 catch：失败时既不进阅读页也不报错，读者只看到
    // 「点了没反应」——而最常见的原因（本地识别引擎还在加载）恰恰是等一会儿就好的。
    try {
      await ws.openDoc(id);
      // 开成了就把上一次的报错撤掉。**同一本书重开时 `docId` 不变**，靠换书那条重置
      // 路走不到这儿——「引擎还没就绪」等一会儿再点就好了，报错却会一直挂在栏里。
      setError(null);
      setActive({ kind: "doc", id });
      // 进案头。已经在上面的不重复也不挪位置——挪了的话读者眼里的顺序会自己跳。
      setDesk((was) => openDocOnDesk(was, id));
      // 切回来时回到原处（ADR-0003 决策 2 的 C）。
      const remembered = desk.find((one) => one.kind === "doc" && one.id === id);
      if (remembered?.kind === "doc") {
        setPage(remembered.page);
        setPane(remembered.pane);
      }
    } catch (error) {
      setError(errorChain(error) || "打不开这本书");
    }
  };

  /**
   * 打开一篇稿子。
   *
   * 与开一本书是同一个形状：先真的把它加载起来，成了才进案头、才让它活。顺序反过来的话，
   * 加载失败会留下一个点开是空白的条目。
   */
  const openDraft = async (id: string) => {
    try {
      // `writer.open` 会先把手上那篇存住——丢的是刚写的字，不能靠「多半来得及」。
      await writer.open(id);
      // **一篇稿子一场对话**：不换的话，上一篇的问答会作为上下文一起发出去。
      talk.attach(id);
      setActive({ kind: "draft", id });
      setDesk((was) => openDraftOnDesk(was, id));
    } catch (cause) {
      // 多半是这篇在别处被删了。回稿子架并重读一遍——列表里少了那一行，
      // 本身就是最清楚的解释，不需要再弹一个框。
      console.warn("打不开这篇稿子", cause);
      setActive({ kind: "writer" });
      void writer.refresh();
    }
  };

  /**
   * 用哪份目录：**生成的优先**。读者会去生成，正是因为自带的没有或不好用；自带的后来
   * 冒出来不该把手工修过的覆盖掉。
   */
  const sections = state.outline ?? embedded;

  /**
   * 缩放的档位与上下限**都相对适宽**。绝对倍率没法用：0.5 对这本扫描书差不多正好铺满，
   * 对一篇论文却是小得看不清。下限半屏、上限五倍，够看清最小的角标。
   */
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
  const percent = fit !== null && scale !== null ? Math.round((scale / fit) * 100) : 100;
  const zoom = (direction: 1 | -1) => {
    if (fit === null) return;
    const now = (scale ?? fit) / fit;
    const next =
      direction === 1
        ? (ZOOM_STEPS.find((step) => step > now + 1e-3) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((step) => step < now - 1e-3) ?? ZOOM_STEPS[0]);
    setFitting(false);
    setScale(Number((next * fit).toFixed(3)));
  };

  /**
   * 离开当前这一本时把位置记进案头，切回来回到原处（ADR-0003 决策 2 的 C）。
   *
   * **只在离开那一刻记，不连续记**：翻一页就写一次 state 是没必要的级联渲染
   * （lint 的 `set-state-in-effect` 也正是拦这个），而位置只有在切走时才有人要。
   */
  const leave = () => {
    if (isReading(active, state.docId)) {
      setDesk((was) => rememberOnDesk(was, state.docId!, { page, pane }));
    }
    // 走开之前先把稿子存住。稿子那侧不记「回到哪」——光标和滚动位置在编辑器自己手里，
    // 外壳插手只会把它顶掉。
    if (active.kind === "draft") void writer.flush();
  };

  /**
   * 打开设置之前站在哪一样上。设置没开时就是当前这一样。
   *
   * 设置页里有一块是**手上这一本书**的（目录），它得认这个，不能认 `state.docId`
   * ——书在设置打开之后仍然加载着，但人可能是从书架点进来的。
   */
  const beneath = active.kind === "settings" ? active.from : active;

  const doc = state.docs.find((candidate) => candidate.id === state.docId);
  const clip = state.clips.find((candidate) => candidate.id === selected) ?? null;

  return (
    <>
      <Shell
        active={active}
        onRoot={(kind) => {
          leave();
          setActive({ kind });
        }}
        desk={desk}
        /**
         * 案头那一行显示什么名字。
         *
         * **用查表不用三元表达式。** 原来是 `kind === "doc" ? 书名 : 稿子名`，于是
         * 打开的网页显示的是「（这篇稿子没了）」——不报错，只是说了句瞎话。图标那一栏
         * 犯过同一个错，`rootOf` 也是。表的形状逼着每加一种都写一行。
         */
        titleOf={(item) => titleOf(item, { docs: state.docs, writing })}
        onPick={(item) => {
          // 已经开着的那一项点了就是「回到它」，不重开——重开要再读一遍 PDF / 换一场对话。
          if (item.kind === "doc" && item.id === state.docId) {
            setActive({ kind: "doc", id: item.id });
            return;
          }
          if (item.kind === "draft" && item.id === writing.openId) {
            setActive({ kind: "draft", id: item.id });
            return;
          }
          // Loop 项目点开就是点开：没有要加载的领域状态，页面自己去读。
          if (item.kind === "loop") {
            setActive({ kind: "loop", id: item.id });
            return;
          }
          leave();
          void (item.kind === "doc" ? openDoc(item.id) : openDraft(item.id));
        }}
        onClose={(item) => {
          leave();
          const next = closeOnDesk(desk, item.kind, item.id, active);
          setDesk(next.desk);
          setActive(next.active);
          // 接班的那一项还没加载就去加载它。回根的话什么都不用做。
          if (next.active.kind === "doc" && next.active.id !== state.docId) void openDoc(next.active.id);
          if (next.active.kind === "draft" && next.active.id !== writing.openId) {
            void openDraft(next.active.id);
          }
        }}
        onSettings={() => {
          // **先 `leave()`。** 从书上走开要把页码记进案头，从稿子上走开要先落盘
          // ——去设置和去别的根是同一件事，漏掉这一下，正在写的字要等下一次防抖。
          leave();
          setActive(openSettings(active));
        }}
      >
      {active.kind === "settings" ? (
        <SettingsPage
          page={settingsPage}
          onPage={setSettingsPage}
          settings={settings}
          ws={ws}
          outline={{
            // **只有「设置是从某本书上打开的」时才画目录那一块。** 判据是来路，不是
            // `state.docId`——书可能还加载着，而人是从书架点进设置的，那时「重新生成」
            // 会把他送去一本他并没有在读的书。
            book: isReading(beneath, state.docId) ? (doc?.title ?? null) : null,
            count: sections.length,
            generated: state.outline !== null,
            // 重新生成要把读者送回阅读页——向导住在右栏，看得见左边的 PDF 才能选页。
            onGenerate: () => {
              setActive(closeSettings(active));
              showPane("clips");
              setTocOpen(true);
            },
            onShift: (delta) => void ws.saveOutline(shiftSections(sections, delta)),
            onClear: () => void ws.clearOutline(),
          }}
        />
      ) : active.kind === "page" ? (
        // 应用内浏览器。**它不在 React 树里**——这里只画一个占位框，网页跑在一个
        // OS 层的 `WebContentsView` 里，位置由那个框量出来推给主进程（见 WebPane）。
        <WebPane
          url={desk.find((one) => one.kind === "page" && one.id === active.id)?.kind === "page"
            ? (desk.find((one) => one.kind === "page" && one.id === active.id) as { url: string }).url
            : active.id}
          onAllow={async (origin) => {
            const sites = await siteStore.load();
            if (!sites.includes(origin)) await siteStore.save([...sites, origin]);
          }}
        />
      ) : active.kind === "context" ? (
        // Context Studio 与书架**并列**，不在某本书里面：一条 context 可以来自任何一本书
        // （`CONTEXT-MAP.md`）。挂在阅读页里的话，层级又反了一次。
        <ContextStudioPage studio={contextStudio} onBack={() => setActive({ kind: "shelf" })} />
      ) : active.kind === "loops" ? (
        // Loop 那一列。**它与 Writer 并列**：写是你持笔，Loop 是没人持笔
        // （`docs/workflow.md` §1.3），不是写的一个子功能。
        <LoopsPage
          reader={loops}
          onOpen={(project) => {
            setDesk(openLoopOnDesk(desk, project));
            setActive({ kind: "loop", id: project });
          }}
        />
      ) : active.kind === "loop" ? (
        <LoopPage project={active.id} reader={loops} />
      ) : active.kind === "export" ? (
        // Export。**与 Writer 并列，不是它的一个按钮**：写是让文章成型，Export 是让它
        // 离开这台机器——后者要看的是「哪几篇在架、发到哪、那边现在是什么」，那是一整列。
        <PublishPage blog={blog} publishing={publishing} />
      ) : active.kind === "writer" ? (
        // 稿子架：Writer 这一侧的根，与书架同一层（ADR-0004）。
        <WriterPage writer={writer} blog={blog} onOpen={(id) => void openDraft(id)} />
      ) : isWriting(active, writing.openId) ? (
        <DraftPage
          writer={writer}
          talk={talk}
          progress={progress}
          contexts={contexts}
          onUploadImage={(file) => blog.uploadImage(file)}
          onBack={() => {
            leave();
            setActive({ kind: "writer" });
          }}
        />
      ) : !isReading(active, state.docId) || state.docId === null ? (
        <ShelfPage ws={ws} state={state} onOpen={openDoc} onOpenUrl={(url) => void openUrl(url)} />
      ) : (
        <div className="book-view">
          <div className="topbar">
            <button className="btn" onClick={() => {
              leave();
              setActive({ kind: "shelf" });
            }}>
              ← 书架
            </button>
            <div className="title grow">{doc?.title ?? ""}</div>

            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={() => setPage((n) => Math.max(1, n - 1))}>
                ←
              </button>
              {/* 点一下就能输页码。654 页的书要跳到第 300 页，只有箭头的话得点 297 下。 */}
              <PageJump page={page} pages={pages} onJump={setPage} />
              <button className="btn" onClick={() => setPage((n) => Math.min(pages, n + 1))}>
                →
              </button>
              {/* **百分比以「适应宽度」为 100%**，不是以 PDF 的原始尺寸。读者关心的是
                  「铺满 / 比铺满大一点」，而原始尺寸对扫描书和论文差了两倍多，
                  同一个数字在两本书上意思完全不同。 */}
              <button className="btn" title="缩小" onClick={() => zoom(-1)}>
                −
              </button>
              <button
                className="btn"
                title={fitting ? "正在适应宽度" : "回到适应宽度"}
                onClick={() => {
                  setFitting(true);
                  if (fit !== null) setScale(fit);
                }}
                style={{ minWidth: "4.5em" }}
              >
                {percent}%
              </button>
              <button className="btn" title="放大" onClick={() => zoom(1)}>
                +
              </button>
              {/* 右栏的把手。**跟左栏那个把手同一条规矩**：收起前后在同一个位置——
                  把手跟着状态跑的话，收起来之后得先找到它才能展开。方向记号也统一，
                  `«` 往左折、`»` 往右折。

                  **右栏是整条收掉，不是收成图标。** 左栏收成图标还成立，因为它是一列
                  去处，每一项收完还点得到；右栏装的是内容（摘录、对话），收成一条
                  56px 的图标带只会留下两个「把我展开」按钮——代价留着，好处没有。
                  而收它的唯一理由就是把宽度还给 PDF。 */}
              <button
                className="btn"
                title={sideOpen ? "收起右栏，把宽度让给页面" : "展开右栏"}
                aria-label={sideOpen ? "收起右栏" : "展开右栏"}
                aria-expanded={sideOpen}
                onClick={toggleSide}
              >
                {sideOpen ? "»" : "«"}
              </button>
            </div>
          </div>

          <div className="panes">
            <div className="stage" ref={setStage}>
              <PageView
                ws={ws}
                host={host}
                state={state}
                selected={selected}
                page={page}
                onPages={setPages}
                // 适宽还没算出来时先按 1 渲一次——正是那一次渲染报回页宽，适宽才有得算。
                scale={scale ?? 1}
                onPageWidth={setPageWidth}
                pinch={pinch}
                onSelect={(id, at) => {
                  setSelected(id);
                  setMenuAt(at ?? null);
                  if (id !== null) {
                    // 划完就展开摘录那栏：读者的下一个动作是看译文，不该还要自己切。
                    showPane("clips");
                    // 看过一次就重新计时（ADR-0012）。代价是读操作也要写盘。
                    void ws.viewClip(id);
                  }
                }}
                onCapturing={setBusy}
                onError={setError}
                onContext={(at, selection) => setContext({ ...at, selection })}
              >
                {/* 右键：在**这一页**加书签。站在这一页上，页码就是对的——
                    不用猜，也不用事后翻回来核对。 */}
                {context !== null && (
                  <PageMenu
                    at={context}
                    page={page}
                    selection={context.selection}
                    onClose={() => setContext(null)}
                    onAddBookmark={(title) => {
                      void ws.saveOutline(bookmark(sections, page, title));
                      // 切到摘录栏：刚加的那条要么已经有名字、要么是空的等着起名。
                      showPane("clips");
                    }}
                  />
                )}

                {/* 松手就浮出来，翻译同时已经在跑——菜单不能挡在日常主路径上
                    （ADR-0016）。 */}
                {clip !== null && menuAt !== null && (
                  <SelectionMenu
                    ws={ws}
                    clip={clip}
                    tags={state.tags}
                    at={menuAt}
                    onClose={() => setMenuAt(null)}
                    onAsk={() => {
                      conversation.attachClip({
                        clipId: clip.id,
                        // 纯图没有原文，就把图像描述当材料；两个都没有才退回空串。
                        sourceText: clip.sourceText ?? clip.content?.multimodal ?? "",
                        translation: clip.translation ?? undefined,
                        image: clip.content?.screenshot,
                        page: clip.region.page,
                        note: clip.note ?? undefined,
                      });
                      setMenuAt(null);
                      showPane("chat");
                    }}
                  />
                )}
              </PageView>
            </div>

            {sideOpen && (
            <div className="side">
              <div className="seg">
                <button className={pane === "clips" ? "on" : undefined} onClick={() => setPane("clips")}>
                  摘录 {state.clips.length > 0 && `· ${state.clips.length}`}
                </button>
                <button className={pane === "chat" ? "on" : undefined} onClick={() => setPane("chat")}>
                  问文档
                </button>
              </div>

              {/* 向导占住整栏（不是弹窗）：选目录页时必须同时看得见左边的 PDF。
                  播完种就退场，之后目录就是一份可以一直改的东西。 */}
              {pane === "clips" && tocOpen && host.document ? (
                <TocWizard
                  document={host.document}
                  model={tocModel()}
                  localOcr={localTocOcr}
                  page={page}
                  onCancel={() => setTocOpen(false)}
                  onDone={(next) => {
                    void ws.saveOutline(next);
                    setTocOpen(false);
                  }}
                />
              ) : pane === "clips" ? (
                <>
                  {(busy !== null || error !== null) && (
                    <div style={{ padding: "12px 14px 0" }}>
                      {busy !== null && (
                        <p className="muted">{busy === "translating" ? "翻译中…" : "识别中…"}</p>
                      )}
                      {error !== null && <pre className="err">{error}</pre>}
                    </div>
                  )}
                  <ClipsPane
                    ws={ws}
                    tags={state.tags}
                    sections={sections}
                    generated={state.outline !== null}
                    onGenerate={() => setTocOpen(true)}
                    onEditSections={(next) => void ws.saveOutline(next)}
                    clips={state.clips}
                    selected={clip?.id ?? null}
                    onSelect={setSelected}
                    onJump={setPage}
                  />
                </>
              ) : (
                // 引用点了就跳到那一页——PDF 一直在左边，所以核对原文不用离开对话。
                <ChatPanel conversation={conversation} progress={progress} onJump={setPage} />
              )}
            </div>
            )}
          </div>
        </div>
      )}
      </Shell>

    </>
  );
}

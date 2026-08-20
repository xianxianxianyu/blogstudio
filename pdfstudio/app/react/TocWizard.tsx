import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { toSections, type Offset, type TocEntry } from "../../src/outline/toc";
import { recognizeTocPage } from "../../src/outline/toc-recognize";
import type { ModelClient } from "../../src/model/model-client";
import type { Section } from "../../src/clip/outline";
import { inferPageOffset, readTocPageByColumns, readTocPages, renderPage, suggestTocPages } from "./toc-scan";
import { parseToc } from "../../src/outline/toc";
import { errorChain } from "../../src/app/error-chain";

/**
 * 从书自己印的目录页生成目录。
 *
 * **不做成模态向导，也不以「完成 ✓」结束。** 目录页解析在英文书上三项全对只有 57%
 * （`docs/research-large-book-outline.md`），中文侧一条公开数据都没有——也就是说近一半
 * 条目某处是错的。真正的产品不是这次识别，而是识别之后**那份能一直改的目录**。做成
 * 模态的话，读者三天后发现第七章页码错了，会找不到入口回去改。
 *
 * 所以它住在右栏（不是弹窗）：选目录页时必须同时看得见左边的 PDF。播完种就退场。
 */

type Stage =
  | { at: "pick"; suggested: { from: number; to: number } | null; scanning: boolean }
  | { at: "read"; from: number; to: number; now: number }
  | { at: "confirm"; from: number; to: number; entries: TocEntry[]; offset: Offset | null };

export function TocWizard({
  document,
  model,
  localOcr,
  page,
  onDone,
  onCancel,
}: {
  document: PDFDocumentProxy;
  /**
   * 认扫描版目录页用的模型。**只认目录那几页**——这不是全书 OCR，全书都认了框选就
   * 没有意义了。有文本层的页面根本不会走到这里。
   */
  model: ModelClient | null;
  /**
   * 本地 OCR。**扫描版优先走它**——云端对「整页目录转结构」这个任务实测不可靠
   * （同一张图同一提示词，一批 3/3 成功、另一批 3/3 在 16 秒被网关掐断）。
   */
  localOcr: () => Promise<ModelClient | null>;
  /** 当前翻到第几页——「我自己选」时读者是**翻书**指定的，不是填数字。 */
  page: number;
  onDone: (sections: Section[]) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ at: "pick", suggested: null, scanning: true });
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 先猜，读者只需要点头或改。扫的是文本层，不花钱也不调模型。
  useEffect(() => {
    let cancelled = false;
    void suggestTocPages(document).then((suggested) => {
      if (cancelled) return;
      setStage({ at: "pick", suggested, scanning: false });
      if (suggested) setRange(suggested);
    });
    return () => {
      cancelled = true;
    };
  }, [document]);

  async function read(from: number, to: number) {
    setStage({ at: "read", from, to, now: from });
    setError(null);
    try {
      const entries = await readTocPages(
        document,
        from,
        to,
        async (target) => {
          // 本地这一档：整页按栏切开分别 OCR，出来的纯文本走 `parseToc` 的正则那一路。
          // **按栏切是必需的**，不是优化——双栏目录整页认出来的是一行左一行右的交错，
          // 而乱序的目录比没有目录更糟：它看着是对的。
          const ocr = await localOcr();
          if (ocr) {
            const lines = await readTocPageByColumns(document, target, async (pixels) => {
              const { text } = await ocr.complete({
                messages: [{ role: "user", content: "OCR:" }],
                images: [pixels],
              });
              return text;
            });
            return parseToc([lines]);
          }
          if (!model) throw new Error("这是扫描版，认目录要用识别模型，先在设置里配一个。");
          return recognizeTocPage(model, await renderPage(document, target));
        },
        (now) => setStage({ at: "read", from, to, now }),
      );
      if (entries.length === 0) {
        setError("这几页里没找到目录条目。翻到真正的目录页再选一次？");
        setStage({ at: "pick", suggested: null, scanning: false });
        return;
      }
      const offset = await inferPageOffset(document, entries, to);
      setStage({ at: "confirm", from, to, entries, offset });
    } catch (cause) {
      // **整条链，不是最外层那句。**「模型调用失败」这五个字对排查毫无帮助，真正的
      // 原因（HTTP 状态、连接被重置）只活在 `cause` 里——这一条挡过一次目录识别。
      setError(errorChain(cause) || "识别目录失败");
      setStage({ at: "pick", suggested: null, scanning: false });
    }
  }

  /**
   * 按读者填的「第 1 页在第几页」，算出第一条目录会落到哪一物理页。
   *
   * 偏移 = 那一页 − 1；第一条落在 `printedPage + 偏移`。**负偏移不给过**——目录里的
   * 条目跑到书的开头之前是不可能的，那只说明填错了。
   */
  const firstOne = stage.at === "confirm" ? stage.entries[0] : null;
  const typed = Number(manual.trim());
  const last = stage.at === "confirm" ? Math.max(...stage.entries.map((e) => e.printedPage)) : 0;
  const firstAt =
    firstOne &&
    /^\d+$/.test(manual.trim()) &&
    typed >= 1 &&
    // 最后一条也得落在书里。填成 500 的话末章会跑到第 1099 页——书只有 654 页，
    // 而这种填错**不会有任何东西报错**，只会让整本书的跳转从此全是错的。
    last + typed - 1 <= document.numPages
      ? firstOne.printedPage + typed - 1
      : null;

  return (
    <div className="pane">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong className="grow">生成目录</strong>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>

      {/* `pre` 而不是 `p`：错误链是多行的（`↳` 一层层往下），挤成一行就白留了。 */}
      {error !== null && <pre className="err">{error}</pre>}

      {stage.at === "pick" && (
        <>
          <h3 className="section">目录在哪几页</h3>
          {stage.scanning ? (
            <p className="muted">正在找…</p>
          ) : stage.suggested ? (
            <p className="muted">
              看着像目录的是<strong>第 {stage.suggested.from}–{stage.suggested.to} 页</strong>。
            </p>
          ) : (
            <p className="muted">没自动找到。翻到目录那一页，然后按下面的按钮。</p>
          )}

          {/* 选页靠**翻书**，不靠填数字：左边就是 PDF，翻到那一页点一下，
              也不会因为「封面算不算第一页」而错位。 */}
          <p className="faint">现在翻到第 {page} 页</p>
          <div className="row">
            <button className="btn" onClick={() => setRange({ from: page, to: range?.to ?? page })}>
              目录从这页起
            </button>
            <button
              className="btn"
              onClick={() => setRange({ from: range?.from ?? page, to: page })}
            >
              到这页止
            </button>
          </div>

          {range && (
            <p className="muted" style={{ marginTop: 10 }}>
              选了第 {range.from}–{range.to} 页
            </p>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              disabled={!range || range.to < range.from}
              onClick={() => range && void read(range.from, range.to)}
            >
              就这几页，开始认
            </button>
          </div>
        </>
      )}

      {stage.at === "read" && (
        <p className="muted">
          正在读第 {stage.now} 页（共 {stage.from}–{stage.to}）…
        </p>
      )}

      {stage.at === "confirm" && (
        <>
          <h3 className="section">认出 {stage.entries.length} 条</h3>
          <div style={{ maxHeight: 180, overflow: "auto", marginBottom: 10 }}>
            {stage.entries.slice(0, 40).map((entry, index) => (
              <div key={index} className="faint" style={{ paddingLeft: entry.level * 12 }}>
                {entry.title} · {entry.printedPage}
              </div>
            ))}
          </div>

          <h3 className="section">对页码</h3>
          {stage.offset ? (
            <>
              {/* 摆证据，不是让人填数字。填错了没有任何东西会报错，整本书的跳转全歪。 */}
              {stage.offset.evidence.map((one) => (
                <p key={one.title} className="faint">
                  目录说《{one.title}》在第 {one.printedPage} 页，实际在第 {one.actualPage} 页
                </p>
              ))}
              <p className="muted">一致相差 {stage.offset.offset} 页</p>
            </>
          ) : (
            <>
              {/* 扫描版没有文本层，「去正文里找这个标题」这条路走不通，只能人填。
                  所以设计是**能验就验、验不了就填**，不是二选一。

                  **问的是页码本身，不是差值。** 原先写的是「两者相差多少就填多少」，
                  读者翻到那一页、顶栏写着 17，就填了 17——而我们要的是 16，于是整本书
                  的跳转全歪一页，且没有任何东西会报错。读者此刻就站在那一页上，
                  减法是我们凭空造出来的一个会错的地方。 */}
              <p className="muted">
                没能自己对上——扫描版没有文本层，正文里找不到这些标题。
              </p>
              <p className="muted">
                翻到书里<strong>印着「第 1 页」</strong>的那一页，看顶栏显示第几页，填进来。
              </p>
            </>
          )}

          <div className="row" style={{ marginTop: 10 }}>
            {stage.offset && (
              <button
                className="btn primary"
                onClick={() => onDone(toSections(stage.entries, stage.offset!.offset))}
              >
                对，就这样
              </button>
            )}
            {/* 一键填当前页：读者本来就是翻到那一页去看的，让他再手打一遍那个数字
                纯属多一道会打错的手续。 */}
            <button className="btn" onClick={() => setManual(String(page))}>
              就是现在这页（第 {page} 页）
            </button>
            <label className="row" style={{ gap: 6 }}>
              <span className="faint">「第 1 页」是第</span>
              <input
                style={{ width: 62 }}
                placeholder="17"
                value={manual}
                onChange={(event) => setManual(event.target.value)}
              />
              <span className="faint">页</span>
            </label>
          </div>

          {/* **摆出后果，而不是让人确认一个数字。** 填错了整本书的跳转会整体歪掉，
              而歪掉这件事本身是看不见的——除非现在就把「第一条会跳到哪儿」写出来。 */}
          {firstAt !== null && (
            <p className="muted" style={{ marginTop: 8 }}>
              这样的话《{stage.entries[0].title}》会跳到<strong>第 {firstAt} 页</strong>。
              <button
                className="btn primary"
                style={{ marginLeft: 10 }}
                onClick={() => onDone(toSections(stage.entries, firstAt - stage.entries[0].printedPage))}
              >
                就用这个
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}

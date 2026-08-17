import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { toSections, type Offset, type TocEntry } from "../../src/outline/toc";
import type { Section } from "../../src/clip/outline";
import { inferPageOffset, readTocPages, suggestTocPages } from "./toc-scan";

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
  | { at: "read"; from: number; to: number }
  | { at: "confirm"; from: number; to: number; entries: TocEntry[]; offset: Offset | null };

export function TocWizard({
  document,
  page,
  onDone,
  onCancel,
}: {
  document: PDFDocumentProxy;
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
    setStage({ at: "read", from, to });
    setError(null);
    try {
      const entries = await readTocPages(document, from, to);
      if (entries.length === 0) {
        setError("这几页里没找到目录条目。翻到真正的目录页再选一次？");
        setStage({ at: "pick", suggested: null, scanning: false });
        return;
      }
      const offset = await inferPageOffset(document, entries, to);
      setStage({ at: "confirm", from, to, entries, offset });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "识别目录失败");
      setStage({ at: "pick", suggested: null, scanning: false });
    }
  }

  return (
    <div className="pane">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong className="grow">生成目录</strong>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>

      {error !== null && <p className="err">{error}</p>}

      {stage.at === "pick" && (
        <>
          <h3 className="section">目录在哪几页</h3>
          {stage.scanning ? (
            <p className="muted">正在找…</p>
          ) : stage.suggested ? (
            <p className="muted">
              看着像目录的是**第 {stage.suggested.from}–{stage.suggested.to} 页**。
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
          正在读第 {stage.from}–{stage.to} 页…
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
            <p className="muted">没能对上页码（正文里找不到这些标题，多半是扫描版）。请自己填。</p>
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
            <input
              style={{ width: 90 }}
              placeholder="差几页"
              value={manual}
              onChange={(event) => setManual(event.target.value)}
            />
            <button
              className="btn"
              disabled={!/^\d+$/.test(manual.trim())}
              onClick={() => onDone(toSections(stage.entries, Number(manual.trim())))}
            >
              用这个数
            </button>
          </div>
        </>
      )}
    </div>
  );
}

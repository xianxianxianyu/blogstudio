import { useEffect, useState } from "react";
import type { ModelStatus } from "../../src/model/model-download";
import { apiUrl } from "../api-base";

const MB = 1024 * 1024;
/** q8 档的大致体积，用来把「已下载多少」变成一个有参照的数。 */
const EXPECTED_MB = 300;

/**
 * 本地向量模型的下载与状态。
 *
 * 做成**显式的按钮**而不是首次提问时顺带下载：读者原本的体验是「问第一个问题，然后
 * 等几分钟，界面上什么都没有」。几百 MB 的下载应该是一个读者主动做的决定，不是他
 * 撞上的意外。
 */
export function LocalModel() {
  const [status, setStatus] = useState<ModelStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const next = (await fetch(apiUrl("/__models/__status")).then((r) => r.json())) as ModelStatus;
      if (!alive) return;
      setStatus(next);
      // 只在下载中才继续轮询：下完还接着问就是白耗电。
      if (next.downloading) setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, []);

  if (status === null) return null;

  return (
    <>
      <h3>本地向量模型</h3>
      <p className="muted">
        中文问英文论文靠它。<b>不装它的话中文检索是零召回</b>——关键词那一路抽不出中文
        词元。约 {EXPECTED_MB} MB，下一次，之后离线也能用。
      </p>

      {status.error !== null && <pre className="err">{status.error}</pre>}

      {status.present ? (
        <p>✓ 已就绪（{Math.round(status.bytes / MB)} MB）</p>
      ) : status.downloading ? (
        <p>
          正在下载… {Math.round(status.bytes / MB)} / 约 {EXPECTED_MB} MB
        </p>
      ) : (
        <button
          className="btn"
          onClick={() => {
            void fetch(apiUrl("/__models/__status"), { method: "POST" })
              .then((r) => r.json())
              .then((next: ModelStatus) => {
                setStatus(next);
                const poll = async () => {
                  const now = (await fetch(apiUrl("/__models/__status")).then((r) => r.json())) as ModelStatus;
                  setStatus(now);
                  if (now.downloading) setTimeout(() => void poll(), 1000);
                };
                setTimeout(() => void poll(), 1000);
              });
          }}
        >
          下载
        </button>
      )}
    </>
  );
}


interface EngineStatus {
  running: boolean;
  baseURL: string | null;
  phase: string | null;
}

/**
 * 本地识别引擎（ADR-0015）。
 *
 * 与向量模型分开显示：它们是两件不同的东西，体积差五倍，而且这一档**只出原文**
 * ——那是明说的产品差异，读者启用前必须看见。
 */
export function LocalEngineSection({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const next = (await fetch(apiUrl("/__engine")).then((r) => r.json())) as EngineStatus;
      if (!alive) return;
      setStatus(next);
      // 下载 1.7 GB 加载模型可能要十几分钟，期间一直轮询；就绪或没在做事就停。
      if (next.phase !== null && !next.running) setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [enabled]);

  return (
    <>
      <h3>本地识别引擎</h3>
      <p className="muted">
        公式和图走本机的 PaddleOCR-VL，不联网、不花钱。约 1.7 GB。
        <b>这一档只产出原文，没有译文和图像描述</b>——它是专用识别模型，不做翻译。
      </p>

      {status?.phase && <pre className={status.running ? undefined : "err"}>{status.phase}</pre>}
      {status?.running && <p>✓ 引擎在跑（{status.baseURL}）</p>}

      <label className="field">
        <span>启用</span>
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
        <span className="muted">
          {enabled ? "识别走本地；第一次会下载并启动，要等一会儿" : "识别走云端（默认）"}
        </span>
      </label>

      {enabled && !status?.running && (
        <button
          className="btn"
          onClick={() => {
            void fetch(apiUrl("/__engine"), { method: "POST" })
              .then((r) => r.json())
              .then((next: EngineStatus) => setStatus(next));
          }}
        >
          下载并启动
        </button>
      )}
    </>
  );
}

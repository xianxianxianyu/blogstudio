import { useEffect, useState } from "react";
import { apiUrl } from "../api-base";

interface EngineStatus {
  running: boolean;
  baseURL: string | null;
  phase: string | null;
}

/**
 * 本地识别引擎（ADR-0015）。
 *
 * 向量那一档不在这里：它是问文档的必需件，首次提问时自动下载并拉起（与识别共用同一份
 * llama.cpp），不需要读者先做决定。识别这一档是可选的，而且**只出原文**——那是明说的
 * 产品差异，启用前必须看见。
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

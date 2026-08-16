import { useCallback, useSyncExternalStore } from "react";
import type { Settings } from "../../src/app/settings";

/**
 * 回收策略的首次告知（ADR-0012 代价 1）。
 *
 * **在它被确认之前，回收器一条摘录都不动**——删完再说不叫告知，那时读者的东西已经
 * 没了。所以这不是一个可以忽略的提示条，它是回收生效的前置条件。
 */
export function RetentionNotice({ settings }: { settings: Settings }) {
  const config = useSyncExternalStore(
    useCallback((listener: () => void) => settings.subscribe(listener), [settings]),
    () => settings.config,
  );
  if (config.retention.acknowledged) return null;

  return (
    <div className="notice">
      <b>关于自动清理</b>
      <p>
        没有标记为「重要」的摘录，在 {config.retention.ttlDays} 天没被打开之后会
        <b>只保留位置标记</b>，原文、译文和截图会被删掉，且不可撤销。点开标记可以按位置
        重新识别一次。
      </p>
      <p className="muted">
        写过笔记的、已入库的、标记为重要的都不会被清理。天数可以在下面改。
        <b>在你点「知道了」之前，不会清理任何东西。</b>
      </p>
      <button className="btn" onClick={() => void settings.acknowledgeRetention()}>
        知道了
      </button>
    </div>
  );
}

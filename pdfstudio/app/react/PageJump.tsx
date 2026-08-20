import { useState } from "react";
import { pageFrom } from "../../src/app/page-jump";

/**
 * 顶栏的「3 / 654」。点一下变输入框，回车跳过去。
 *
 * 此前它是个死的 `<span>`，翻页只有左右箭头——654 页的书要跳到第 300 页得点 297 下。
 * 而那个数字本来就长得像可以点，读者第一反应就是去点它。
 *
 * **回车才跳，失焦只是收起来。** 点开之后改主意、去点别处，不该把人送到一个他没确认
 * 的页码上；`Esc` 同理。跳不跳这件事只有一个触发点。
 *
 * 样式写在这里而不是 `app.css`：这一个控件的三条尺寸规则，与它替换掉的那个 `<span>`
 * 原本就是内联的同一套（`minWidth` 是为了让数字变化时顶栏不左右跳）。
 */
export function PageJump({
  page,
  pages,
  onJump,
}: {
  page: number;
  pages: number;
  onJump: (page: number) => void;
}) {
  /** 正在输的那串字。`null` ＝ 没在输，显示的是页码本身。 */
  const [typing, setTyping] = useState<string | null>(null);

  if (typing === null) {
    return (
      <button
        className="btn"
        // 说清楚是**物理页码**——PDF 里实际的第几页，就是这里显示的这个数。它与书页上
        // 印的那个差一个偏移（`CONTEXT.md`），按印刷页码跳是目录那条路的事。
        title="点一下输页码（PDF 里的第几页，不是书上印的页码）"
        style={{ minWidth: "5.5em", textAlign: "center", fontVariantNumeric: "tabular-nums" }}
        onClick={() => setTyping(String(page))}
      >
        {page} / {pages}
      </button>
    );
  }

  return (
    <form
      style={{ display: "flex", alignItems: "center", gap: 4, minWidth: "5.5em" }}
      onSubmit={(event) => {
        event.preventDefault();
        const next = pageFrom(typing, pages);
        // 输的不是个页码就只收起来，不动当前这一页——见 `pageFrom` 上那段注释。
        if (next !== null) onJump(next);
        setTyping(null);
      }}
    >
      <input
        ref={(element) => {
          // 打开就整段选中：点这个数字的人是要**换**一个页码，不是要在「42」后面接着打。
          element?.focus();
          element?.select();
        }}
        value={typing}
        // 手机上直接出数字键盘；桌面端不用 `type="number"`——那个会带一对上下箭头，
        // 顶栏这么窄挤不下，而且它对空串和非法值的行为各浏览器不一样。
        inputMode="numeric"
        aria-label={`跳到第几页，共 ${pages} 页`}
        style={{ width: "3.2em", font: "inherit", textAlign: "right", padding: "4px 5px" }}
        onChange={(event) => setTyping(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setTyping(null);
        }}
        onBlur={() => setTyping(null)}
      />
      <span className="faint">/ {pages}</span>
    </form>
  );
}

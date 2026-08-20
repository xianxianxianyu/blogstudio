/**
 * 主窗口 preload 暴露的桥（`electron/shell-preload.ts`）。
 *
 * **可能不存在**：浏览器形态（dev server 的 /react.html）下没有 Electron，
 * 也就没有这个桥。类型上写成可选，逼着调用方处理那种情况——而不是运行时才炸。
 */
interface StudioWeb {
  open(url: string): Promise<{ ok: boolean; reason?: string }>;
  bounds(rect: { x: number; y: number; width: number; height: number }): void;
  close(): void;
  on(handler: (event: { type: string; payload: unknown }) => void): () => void;
}

interface Window {
  studioWeb?: StudioWeb;
}

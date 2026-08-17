/**
 * pdf.js 的随包静态资源：CMap、标准字体、wasm、ICC。
 *
 * **不给这些参数，中文书会静默失效。** 常见形态是「不嵌入 CJK 字体 + 用预定义 CMap
 * （`UniGB-UCS2-H` 之类）」，缺 `cMapUrl` 时 `getTextContent()` 返回的是**空字符串**
 * ——不是乱码、不抛异常，只有一行 console warning。一旦命中，目录页解析、切块建索引、
 * 检索、文本流划词全部一起失效，而界面上看起来只是「这本书划不中字」。
 *
 * 我们自己的 eval 日志里早就有 `Ensure that the standardFontDataUrl API parameter is
 * provided` 了，只是没人把它当回事。
 *
 * 路径分两处给：node 侧（测试、eval）直接指 `node_modules/pdfjs-dist`，浏览器侧走本机
 * API 的 `/__pdfjs`（ADR-0014：dev server 与打包应用共用同一份）。所以这里只放**子目录
 * 名**，两侧拼各自的前缀——名字散在两处迟早对不上，而对不上的表现又是静默的。
 */
export const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"] as const;

/** `getDocument` 的资源参数。`base` 要以 `/` 结尾——pdf.js 直接做字符串拼接。 */
export function pdfAssetOptions(base: string): {
  cMapUrl: string;
  cMapPacked: true;
  standardFontDataUrl: string;
  wasmUrl: string;
  iccUrl: string;
} {
  const at = (dir: string) => `${base.replace(/\/?$/, "/")}${dir}/`;
  return {
    cMapUrl: at("cmaps"),
    // 随包发的是 .bcmap（二进制打包过的），不置 true 会去找根本不存在的纯文本 CMap。
    cMapPacked: true,
    standardFontDataUrl: at("standard_fonts"),
    wasmUrl: at("wasm"),
    iccUrl: at("iccs"),
  };
}

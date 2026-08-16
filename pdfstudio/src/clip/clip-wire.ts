import type { Clip } from "./clip";

/**
 * 摘录在浏览器与 dev server 之间的线上格式。
 *
 * **只在本机流动**，不是跨产品的传输格式，所以不参与 ADR-0011 说的
 * 「frontmatter 是内部存储格式」那套版本化。
 *
 * 起初它住在 `app/`，因为当时以为打包后会换成 IPC。ADR-0014 定了 dev server 与打包
 * 应用**共用同一份本机 API**，于是它成了两侧共用的东西，搬进 `src/`。
 *
 * 唯一的实质问题是**截图字节**：JSON 装不下 `Uint8Array`。用 replacer/reviver 通吃，
 * 而不是逐字段手抄——手抄的话 `Clip` 将来多一个带字节的字段就会被静默丢掉，
 * 而那种丢失在磁盘上看不出来，只有打开摘录时才发现图没了。
 */
interface WireBytes {
  __bytes: string;
}

/** 分块转 base64：一次 spread 几万个参数会爆栈，而截图动辄几十 KB。 */
function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function decodeBytes(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function serializeClip(clip: Clip): string {
  return JSON.stringify(clip, (_key, value: unknown) =>
    value instanceof Uint8Array ? ({ __bytes: encodeBytes(value) } satisfies WireBytes) : value,
  );
}

/** 泛型而非写死 `Clip[]`：POST 的 body 是单条摘录，GET 的是一整个数组。 */
export function deserialize<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) =>
    value !== null && typeof value === "object" && "__bytes" in value
      ? decodeBytes((value as WireBytes).__bytes)
      : value,
  ) as T;
}

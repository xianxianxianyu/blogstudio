/**
 * 拿字面比字：切二元组、算重合度。
 *
 * 召回的退化档（没接向量时）与查重复段落用的是同一套——写两份的话，两处会各自漂
 * 一点点，然后有一天「召回说这两段像、查重说不像」，而谁都说不出为什么。
 */

/** 中文没有空格，按二元组切；英文顺带也能覆盖。标点与空白全部当分隔并丢掉。 */
export function bigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

/** 有多少比例的 `query` 落在 `target` 里。**不对称**：短问题对长文本才算得准。 */
export function coverage(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  let hit = 0;
  for (const gram of query) if (target.has(gram)) hit++;
  return hit / query.size;
}

/**
 * 两段文字有多像（Jaccard）。**对称**，用来判「这两段是不是在说同一件事」。
 *
 * 与 `coverage` 是两件事：查重复要的是对称的——A 是 B 的一半时，用 coverage 会得到
 * 1.0（A 全落在 B 里），但那不叫重复，那叫 B 更长。
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

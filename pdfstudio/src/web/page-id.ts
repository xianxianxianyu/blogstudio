/**
 * 一个网页的身份。
 *
 * PDF 的 `docId` 是文件内容的哈希，天然唯一。网页没有这种东西——它的身份是 URL，
 * 而同一个页面会以无数种写法出现：带 `?utm_source=`、带 `#section`、主机名大小写不同。
 * **归一化不做或做错，同一页的摘录会散落成几十个「不同文档」**，书架上、知识图里
 * 全是重复项，而且没有任何东西会报错。
 *
 * ## 原则：只归一化**可证明安全**的那些
 *
 * 每多归一化一样，就多一次「把两个真的不同的页面判成同一个」的风险——那种错误比
 * 散落更糟：两页的摘录会混在一起，而且**不可逆**。所以这里的取舍一律偏保守：
 * 拿不准就保留。
 *
 * **归一化的 id 不能拿来回跳。** 它只用来判定「是不是同一页」；真正访问的地址要
 * 逐字另存（跟完重定向之后的那个）。
 */

/** 只去掉可证明不影响内容的跟踪参数。**不做通用的「看着像跟踪就删」**。 */
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|ref_src|s_cid|yclid|twclid)$/i;

export function pageIdOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 解析不了就原样返回。**不能因为一个怪地址就丢掉这条摘录**——身份差一点，
    // 总比没有身份好。
    return url;
  }

  // 锚点不是身份的一部分：HTTP 根本不发送它，服务器看不见。
  parsed.hash = "";

  // 协议与主机名的小写、默认端口的去除，**`URL` 构造函数已经做完了**——
  // `new URL("https://example.com:443/a").href === "https://example.com/a"`。
  // 这里原先还手写了一遍去端口，是死代码（变异测试发现的：改掉它一条测试都不挂）。
  //
  // 但**路径大小写它不碰，我们也不碰**：很多服务器区分大小写，替它决定就是把两个
  // 不同的页面判成同一个，而那种错不可逆。

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING.test(key)) parsed.searchParams.delete(key);
  }
  // **不重排剩下的参数**：服务器可能在意顺序。排序能多合并几个，但换来的是
  // 「把两个不同的页面判成同一个」的风险，而那种错不可逆。

  const text = parsed.toString();
  // 只有根路径的末尾斜杠可以去——`/a/` 与 `/a` 在很多服务器上是两个东西。
  return parsed.pathname === "/" && parsed.search === "" ? text.replace(/\/$/, "") : text;
}

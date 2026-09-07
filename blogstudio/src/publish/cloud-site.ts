import type { Changes } from "./rsync-plan";

/**
 * 一个**云端站点**——稿子写完之后最终出现的地方。
 *
 * 「去处」这个词的意思在这一轮变了：`docs/adr/0003` 里它是「本地一份 git 工作副本」，
 * 现在它是一台机器上的一个目录加一个域名。本地那份 `my-blog` 仓库降级成**固定的中转站**，
 * 不再是一个可选项。
 */
export interface Destination {
  name: string;
  /**
   * `~/.ssh/config` 里的别名（`vps`、`myblog-preview`）。
   *
   * **不写 IP、端口、用户名、密钥路径**：那些已经在 ssh config 里了，抄一份就会漂——
   * 而且这样我们依旧一个字节的凭证都不存（ADR-0003 决策 1 的理由不变）。
   */
  host: string;
  /**
   * 远端静态根，**宿主机上的路径**。
   *
   * 那台阿里云机器上 OpenResty 跑在容器里，配置里写的是 `/www/sites/…`；而 rsync 跑在
   * 宿主机上，要写 `/opt/1panel/www/sites/…`。**两者不能混**。
   */
  path: string;
  /**
   * 构建时喂给 hugo。**两个站必须各自正确**，否则 `.cn` 的 RSS、sitemap、canonical
   * 全指向 `.com`——而页面看起来完全正常。
   */
  baseURL: string;
  /**
   * 不往这个站传的路径（rsync 的 `--exclude`）。
   *
   * **它不让两个站的内容分叉**——内容里写的仍是同一个相对路径，变的只是「谁来发这些
   * 字节」。`moyutianzun.cn` 那台阿里云出网只有 3.3 Mbps（实测），图片从它那儿发
   * 一页要好几秒；所以 `images/` 不传过去，由 OpenResty 一条 301 弹回 OSS。
   *
   * **被排除的路径也不会被 `--delete` 删掉**——rsync 对 exclude 的东西两头都不碰。
   */
  exclude?: string[];
  /**
   * 图片传到哪。**不写就表示图片跟正文一起走 rsync**（`.com` 就是这样）。
   *
   * 写了就表示这个站的图片由别处发：值是一个 `oss://桶/前缀/`，而正文那一侧
   * 通常要配上 `exclude: ["images/"]`，再由那台服务器把 `/images/` 弹过去。
   */
  images?: string;
}

/** 远端那个目录现在是什么样。 */
export interface Probe {
  exists: boolean;
  /** 有 `index.html` 才像一个站点。**不像就不许同步**。 */
  looksLikeSite: boolean;
  /** 那边现在有哪些文章（`<path>/blog/` 下的目录名）。 */
  slugs: string[];
}

export interface CloudSite {
  probe(): Promise<Probe>;
  /** 干跑：这次会动什么。**不写任何东西。** */
  plan(localDir: string): Promise<Changes>;
  /** 真跑。 */
  sync(localDir: string): Promise<Changes>;
}

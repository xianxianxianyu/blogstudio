import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { LOCAL_HOST, type CloudSite, type Destination, type Probe } from "./cloud-site";
import { EXPORT_EXCLUDES } from "./scope";
import { parseChanges } from "./rsync-plan";
import type { Changes } from "./rsync-plan";

const run = promisify(execFile);

/**
 * 拿系统里的 `ssh` 和 `rsync` 当适配器。
 *
 * **一律用 argv 数组，从不拼一条命令字符串**：路径来自配置文件，
 * 拼字符串交给 shell 的那一刻，一个带反引号的路径就成了一次命令执行。
 */

/**
 * 每次 rsync 都要带的四个参数，一处定义。
 *
 * - `-a` 保属性、`-z` 压缩：跟现有的 `scripts/deploy.sh` 一致。
 * - **`-c` 按内容比对**。不加的话 rsync 判「变没变」看的是大小加时间，而 Hugo 每次全量
 *   重建都会刷新所有文件的 mtime——于是每次部署都显示「几百个文件改动」，人看两次就不看了。
 * - **`-8` 不转义非 ASCII**。不加的话中文文件名会变成 `\#226\#234\#232`，而这个博客的
 *   文件名**就是中文的**。与 `git-repo.ts` 里的 `core.quotePath=false` 是同一处伤疤。
 */
const FLAGS = ["-a", "-z", "-c", "-8"] as const;

/** ssh 的两条硬要求，`git-repo.ts` 里 `GIT_TERMINAL_PROMPT=0` 是同一件事。 */
const SSH = [
  // 密钥没配好时不要弹密码提示：Electron 主进程里没有终端，那就是永远等下去，
  // 而界面上只显示「同步中」。
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
] as const;

/**
 * 同步的那一半：rsync 的命令怎么拼、输出怎么读。**跟「远端长什么样」是两件事**，
 * 所以 `probe` 是传进来的。
 *
 * 这么分不是为了好看：rsync 的目标既可以是 `主机:路径`，也可以是一个本地路径，而
 * 「那边存不存在、像不像站点」两种情况问法完全不同。分开之后，**这条 rsync 命令本身
 * 可以对着真 rsync 测**，不需要先有一台服务器——而它恰恰是最容易出错的那部分
 * （`-8`、`-c`、`--delete` 少一个都是静悄悄的错）。
 */
export function createSite(
  remote: string,
  probe: () => Promise<Probe>,
  exclude: string[] = [],
): CloudSite {

  /** rsync 走的 ssh。**同一份 SSH 参数**，两处各写各的迟早会漂。 */
  const shell = ["-e", ["ssh", ...SSH].join(" ")];

  const rsync = async (extra: string[], localDir: string): Promise<Changes> => {
    const { stdout } = await run(
      "rsync",
      [
        ...FLAGS,
        "--delete",
        // 一条路径一个 `--exclude`。**干跑和真跑必须带同一份**，否则预览说的
        // 和实际做的是两回事——而这里面有 `--delete`。
        ...Array.from(new Set([...EXPORT_EXCLUDES, ...exclude])).flatMap((one) => ["--exclude", one]),
        // 推荐页可能仍引用上次构建的指纹资源；允许更新资源，但不清理旧版本。
        "--filter", "P /assets/***",
        ...extra,
        ...shell,
        `${localDir}/`,
        remote,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return parseChanges(stdout);
  };

  return {
    probe,

    plan: (localDir) => rsync(["--dry-run", "--itemize-changes"], localDir),

    async sync(localDir) {
      /**
       * **动手前再查一次。** `--delete` 指错目录会把它清空，而这是这一整件事里唯一
       * 不可逆的部分。计划是几秒钟前那一刻的照片，中间那个目录可能已经不是它了。
       */
      const now = await probe();
      if (!now.exists) throw new Error(`${remote} 上没有这个目录`);
      if (!now.looksLikeSite) {
        throw new Error(`${remote} 里没有 index.html，不像一个站点——拒绝同步，因为 --delete 会清空它`);
      }
      return rsync(["--itemize-changes"], localDir);
    },
  };
}


/**
 * **本机**上的一个站点：rsync 的目标就是一个目录，`probe` 直接读文件系统。
 *
 * `/write` 跑在 VPS 上之后，`.com` 的去处就是同一台机器上的 `/srv/blog`——不该为了
 * 同步到隔壁目录去 ssh 自己一次。`host` 写 `"local"` 就走这条（`cloud-site.ts`）。
 * 同一条 rsync 命令、同一份解析，只是目标不带 `主机:`。
 */
export function createLocalSite(dir: string, exclude: string[] = []): CloudSite {
  return createSite(
    `${dir}/`,
    async () => ({
      exists: await stat(dir).then(() => true, () => false),
      looksLikeSite: await stat(path.join(dir, "index.html")).then(() => true, () => false),
      slugs: await readdir(path.join(dir, "blog")).catch(() => [] as string[]),
    }),
    exclude,
  );
}

/** 按去处的 `host` 选适配器：`"local"` 是这台机器，其余是 ssh 别名。 */
export const siteOf = (destination: Destination): CloudSite =>
  destination.host === LOCAL_HOST
    ? createLocalSite(destination.path, destination.exclude ?? [])
    : createSshSite(destination);

/**
 * 一个真的云端站点：rsync 走 ssh，`probe` 也走 ssh。
 */
export function createSshSite(destination: Destination): CloudSite {
  return createSite(
    `${destination.host}:${destination.path}/`,
    async () => {
    /**
     * 一次 ssh 问三件事，输出用固定的记号分段。
     *
     * 分三次连也行，但那是三次握手——而这个函数在界面上每换一次去处就跑一遍。
     */
    const script = [
      `test -d ${quote(destination.path)} && echo YES || echo NO`,
      `test -f ${quote(`${destination.path}/index.html`)} && echo YES || echo NO`,
      `ls ${quote(`${destination.path}/blog`)} 2>/dev/null || true`,
    ].join("; echo ---; ");

    const { stdout } = await run("ssh", [...SSH, destination.host, script], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const [exists, site, listing] = stdout.split("---").map((part) => part.trim());
    return {
      exists: exists === "YES",
      looksLikeSite: site === "YES",
        slugs: (listing ?? "").split("\n").filter((one) => one !== ""),
      };
    },
    destination.exclude ?? [],
  );
}

/**
 * 给远端 shell 用的单引号包裹。
 *
 * 本地这一侧走 `execFile`，不过 shell；但 `ssh host "命令"` 那串**是要在对面过 shell 的**
 * ——远端没有 execFile 这回事。所以路径必须在这里包好。
 */
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

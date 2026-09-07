import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ImageTarget } from "./image-target";

const run = promisify(execFile);

/**
 * 把图片传到阿里云 OSS，用官方的 `ossutil`。
 *
 * **凭证归 ossutil 管，我们一个字节都不存**——跟 ssh 那条完全一样的形状：
 * `~/.ossutilconfig` 之于这里，就是 `~/.ssh/config` 之于 `ssh-site.ts`。
 * 把 AccessKey 抄进 `destinations.json` 会让那份文件从「一份配置」变成「一把钥匙」。
 *
 * 用之前要先在终端里：`ossutil config`（一次性）。没配的话下面每一条都会报它自己的错，
 * 而**我们把那句原话带上来**，不换成一句「上传失败」。
 */
export function createOssImages(prefix: string): ImageTarget {
  // `oss://桶/前缀/` —— 结尾那个斜杠不能少，否则 ossutil 会把它当成一个对象名。
  const at = prefix.endsWith("/") ? prefix : `${prefix}/`;

  const ossutil = async (...args: string[]): Promise<string> => {
    try {
      const { stdout } = await run("ossutil", args, { maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const said = error as { stdout?: string; stderr?: string; message?: string; code?: string };
      if (said.code === "ENOENT") {
        throw new Error("找不到 ossutil。先装上并 `ossutil config` 配一次——凭证归它管，我们不存。");
      }
      throw new Error([said.stderr, said.stdout, said.message].filter(Boolean).join("\n").trim());
    }
  };

  return {
    async list() {
      // `ls` 一行一个对象，形如 `oss://桶/images/xxx.png`。**问它要，不猜**——
      // 跟 rsync 干跑同一个道理：我们的猜测跟它不一致的那一刻，屏幕和现实就是两回事。
      const out = await ossutil("ls", at);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith(at) && line !== at)
        .map((line) => line.slice(at.length))
        // 只要这一层的文件，不要子目录里的。
        .filter((name) => name !== "" && !name.includes("/"));
    },

    async put(localDir, names) {
      // 一张一张传，不用 `cp -r` 整个目录：**「针对性」就是只传要传的那几张**，
      // 而整目录同步会把那 62 MB 旧图每次都重新比对一遍。
      for (const name of names) {
        // argv 数组，不过 shell（`ssh-site.ts`、`hugo.ts` 同款）：名字来自文件系统。
        await ossutil("cp", "-f", path.join(localDir, name), `${at}${name}`);
      }
    },
  };
}

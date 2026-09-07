import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Build } from "./deploy";

const run = promisify(execFile);

/**
 * 跑一次 hugo。参数由 `build.ts` 拼——**这里只负责把它交出去**。
 *
 * 分开是因为参数才是容易出错的那半（少一个 `--baseURL`、产物目录串了），
 * 而那种错的表现是「页面看起来完全正常」；跑没跑起来反倒是一眼可见的。
 */
export const runHugo: Build = async (args) => {
  try {
    // argv 数组，不过 shell：路径来自配置文件（`ssh-site.ts` 同款）。
    await run("hugo", args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    // **把 hugo 自己的话带上来。** 换成一句「构建失败」的话，模板报错、
    // 主题缺文件、内容里一个坏 shortcode，看起来全都一样。
    const said = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [said.stderr, said.stdout, said.message].filter(Boolean).join("\n").trim() || "hugo 没跑起来",
    );
  }
};

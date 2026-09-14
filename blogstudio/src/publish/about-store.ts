import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { aboutContent, aboutLanguage, type AboutView } from "./about";

const revisionOf = (raw: string) => createHash("sha256").update(raw).digest("hex");

export function createAboutStore(siteRoot: string) {
  const file = path.join(siteRoot, "data/about.json");
  const read = async (): Promise<AboutView> => {
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw);
    return { revision: revisionOf(raw), content: { "zh-cn": aboutContent(data["zh-cn"]), en: aboutContent(data.en) } };
  };
  // 同一个服务实例串行检查和写入，旧窗口不能覆盖新内容。
  let pending: Promise<unknown> = Promise.resolve();
  return {
    read,
    save(language: unknown, content: unknown, revision: unknown): Promise<AboutView> {
      const work = pending.then(async () => {
        const lang = aboutLanguage(language);
        const next = aboutContent(content);
        const had = await read();
        if (revision !== had.revision) throw new Error("About 已被其他窗口修改，请重新载入后再保存");
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify({ ...had.content, [lang]: next }, null, 2) + "\n", "utf8");
          await rename(temp, file);
        } finally { await rm(temp, { force: true }); }
        return read();
      });
      pending = work.catch(() => undefined);
      return work;
    },
  };
}

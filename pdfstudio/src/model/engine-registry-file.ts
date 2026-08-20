import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEngineRegistry, type EngineRecord, type EngineRegistry } from "./engine-registry";

/**
 * 账本落在磁盘上、进程靠 `ps` 认。**不纯的那一半**——判定规则在 `engine-registry.ts`，
 * 那边是纯函数、有测试；这里只负责读写和问系统。
 */
export function createFileEngineRegistry(file: string): EngineRegistry {
  return createEngineRegistry({
    async load(): Promise<EngineRecord[]> {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      // 文件被手改坏、或者旧版本写的是别的形状——当没有，别让它挡住启动。
      return Array.isArray(parsed) ? (parsed as EngineRecord[]) : [];
    },

    async save(records: EngineRecord[]): Promise<void> {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(records), "utf8");
    },

    commandOf(pid: number): string | null {
      try {
        // `ps -o command=` 给的是完整命令行，认得出是不是我们那个 llama-server。
        // 进程不存在时 ps 退出码非 0，execFileSync 直接抛。
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return null;
      }
    },

    kill(pid: number): void {
      try {
        // SIGKILL 而不是 SIGTERM：llama-server 加载权重时不响应 SIGTERM，
        // 而收尸这一刻我们并不知道它卡在哪一步（同 `spawn()` 里那条注释）。
        process.kill(pid, "SIGKILL");
      } catch {
        // 刚好在这一瞬间自己退了，正是我们想要的结果。
      }
    },
  });
}

import { apiFetch } from "./api-base";
import type { RunDetail, RunRecord } from "../../blogstudio/src/loop/loop-store";
import type { LoopSettings } from "../../blogstudio/src/loop/loop-config";

/**
 * Loop 项目，**只读**。
 *
 * 建项目靠往 `<library>/../loops/<名字>/` 里放一份 `loop.md`——文件是唯一真相且允许
 * 手改（ADR-0011）。两段 prompt 本来就该在编辑器里写，不该在一个表单框里敲。
 */
export interface LoopReader {
  projects(): Promise<string[]>;
  /** 配置读不出来就是 null（缺一处都不给跑，见 `loop-config.ts`）。 */
  settings(project: string): Promise<LoopSettings | null>;
  runs(project: string): Promise<RunRecord[]>;
  /** 开着没有。**默认关着**——新建一个项目不该因为「建了」就开始花钱。 */
  enabled(project: string): Promise<boolean>;
  setEnabled(project: string, on: boolean): Promise<void>;
  runDetail(project: string, n: number): Promise<RunDetail>;
}

const get = async <T,>(url: string, fallback: T): Promise<T> => {
  const response = await apiFetch(url);
  // 读不到就用兜底。**一个项目读不出来不该让整页打不开**——这一页正是人来查
  // 「出了什么事」的地方。
  return response.ok ? ((await response.json()) as T) : fallback;
};

export function createHttpLoopReader(base: string): LoopReader {
  const at = (...parts: (string | number)[]) =>
    [base, ...parts.map((one) => encodeURIComponent(String(one)))].join("/");

  return {
    projects: () => get<string[]>(base, []),
    settings: (project) => get<LoopSettings | null>(at(project), null),
    runs: (project) => get<RunRecord[]>(at(project, "runs"), []),
    enabled: (project) => get<boolean>(at(project, "enabled"), false),
    async setEnabled(project, on) {
      await apiFetch(at(project, "enabled"), { method: "POST", body: String(on) });
    },
    runDetail: (project, n) => get<RunDetail>(at(project, "runs", n), { report: null, tasks: [] }),
  };
}

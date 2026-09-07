import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { recover, type TaskState } from "./recovery";
import type { Run } from "./run";
import { readConfig, type LoopSettings } from "./loop-config";
import { readTask } from "./task";

/**
 * 一个 loop 项目在磁盘上的样子。
 *
 * ```
 * <root>/<project>/
 *   loop.md                  配置：名字、两个 prompt、间隔、预算
 *   runs/0009/
 *     run.md                 这一次：起止、状态、花费
 *     plan.md                阶段① 的产物
 *     tasks/01.task.md       自包含的任务
 *           01.intent.json   **调用之前**写的
 *           01.report.md     它的产出
 *     report.md              阶段③ 的产物
 * ```
 *
 * **不另设日志表**（`.scratch/loop/spec.md` §3）：每一步的输入输出各是一个文件，
 * 「发生过什么」就是这些文件本身。将来要画执行图，图从这些文件推出来，不用改数据。
 *
 * 跟稿子、摘录、目录同一种形状（ADR-0011——文件是唯一真相，且允许手改）。
 */
/**
 * 一轮的成绩单。时间线上那一行要的全部东西。
 *
 * `capUsd` 是**预留出去多少，不是实际花了多少**。模型端口只交出文本、不交出用量
 * （`ModelResponse` 里只有 `text`），所以实际花费在这一层根本取不到。记一个编出来的
 * 数字比不记更糟——人会拿它当账看。等端口哪天交出用量，再在旁边加一栏真的。
 */
export type RunRecord = Run & { startedAt: number; endedAt: number | null; capUsd: number };

/**
 * 一轮的产出。
 *
 * **没做完的 task 也在 `tasks` 里，`report` 是 null。** 最终报告里会写「02 没做成」
 * （spec §1.2），读者顺着那句话翻过来必须找得到 02——只列成功的，那句话就指向空处。
 */
export type RunDetail = {
  report: string | null;
  tasks: { id: string; title: string; source: string; report: string | null }[];
};

export interface LoopStore {
  /** 有哪些项目。一个目录一个项目，目录名就是项目名。 */
  projects(): Promise<string[]>;
  /** 这个项目的配置。读不出来就是 null——**不给默认值**（见 `readConfig`）。 */
  settings(project: string): Promise<LoopSettings | null>;
  /**
   * 这个项目开着没有。**默认关着。**
   *
   * 新建一个项目不该因为「建了」就开始花钱——它得由人明确地开一次。
   */
  enabled(project: string): Promise<boolean>;
  setEnabled(project: string, on: boolean): Promise<void>;
  /** 每一轮一行，**最新在最上面**。 */
  runs(project: string): Promise<RunRecord[]>;
  /** 一轮的产出：最终报告，加上每个 task 各自的那份。 */
  runDetail(project: string, n: number): Promise<RunDetail>;
  /** 记下这一轮的成绩单。每次状态变化都可以重写，最后一次写的算数。 */
  saveRun(project: string, run: RunRecord): Promise<void>;
  /** 每个 task 各自是什么处境。崩溃之后靠它决定谁能重跑。 */
  taskStates(project: string, n: number, taskIds: string[]): Promise<TaskState[]>;
  /**
   * 起一个 task：**先落意图，再去调模型**。
   *
   * 顺序不能反。反过来的话，崩在「调用完成、还没写盘」这一刻的 task 在磁盘上
   * 看起来像没跑过，重跑一遍就是付第二次钱（spec §4）。
   */
  beginTask(project: string, n: number, id: string, intent: Intent): Promise<void>;
  /** 收下产出。写完这一刻，这个 task 才算干完。 */
  finishTask(project: string, n: number, id: string, report: string): Promise<void>;
  /** 阶段③ 的产物。一轮只有一份，人回来看的就是它。 */
  saveReport(project: string, n: number, report: string): Promise<void>;
  /** 阶段① 排出来的计划。task 是从哪儿来的，得看得见。 */
  savePlan(project: string, n: number, plan: string): Promise<void>;
  /**
   * 发出去的 task 原文。
   *
   * **一字不差就是 subagent 拿到的那份。** report 读着不对劲的时候，唯一能对回来的
   * 就是它——问题出在任务写得不好，还是 subagent 干得不好，只有这份文件分得清。
   */
  saveTaskFile(project: string, n: number, id: string, source: string): Promise<void>;
}

/** 调用之前记下来的：打算用什么、最多花多少。人事后要靠它认出这笔钱花在哪儿。 */
export type Intent = { model: string; capUsd: number };

/**
 * 项目名和 task id 直接当目录名／文件名用，所以都不能带路径。
 *
 * 不是防谁——这两样都是自己生成的——而是**别让一个坏名字静静地写到 root 外面去**。
 * 写出去了不会报错，只会在某个谁也想不到的地方留下文件；等哪天顺着这条路去删，
 * 删掉的就是别人的东西。跟 `draft-store` 的 `fileOf` 同一条规矩。
 */
function safe(kind: string, name: string): string {
  if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`${kind}不能当文件名：${name}`);
  }
  return name;
}

/**
 * 「开着」的标记。**空文件，存在即开着。**
 *
 * 不写进 `loop.md`：那里面是人手写的两段 prompt，界面去回写它，一次撞车就可能盖掉
 * 正在改的字。单独一个文件也好手动处置——想让它别跑，删掉就是了（ADR-0011）。
 */
const onFile = (root: string, project: string): string =>
  path.join(root, safe("项目名", project), "enabled");

/** 目录名补到四位，`0009` 排在 `0010` 前面——时间线按目录名排就是对的。 */
const runDir = (root: string, project: string, n: number): string =>
  path.join(root, safe("项目名", project), "runs", String(n).padStart(4, "0"));

const tasksDir = (root: string, project: string, n: number): string =>
  path.join(runDir(root, project, n), "tasks");

/**
 * 原子落盘：先写同目录下的临时文件，再 `rename` 顶上去。
 *
 * 直接 `writeFile` 崩在中途会留下**半个文件**。要紧的是 report 那一半：半份 report
 * 在磁盘上和整份长得一模一样（`recover` 只看文件在不在），阶段③ 会拿着它当完整产出
 * 去写最终报告——又是一份看着完整、实际有洞的报告。`rename` 在同一个文件系统里是
 * 原子的：要么是旧的，要么是新的，没有中间态。
 *
 * **这一条没有测试守着。** `writeFile` 中途失败在这个接口外面观察不到（要观察就得
 * 把写盘本身做成可注入的端口，那是为测试而开的口子）。所以它是**讲道理讲出来的，
 * 不是测出来的**——改这里的人要知道这一点。
 *
 * 意图那一半反而不靠它：`recover` 的判据是文件**在不在**，不是写没写全，所以一个
 * 截断的 `intent.json` 落在「可能已花钱」这个安全的一侧（那一条有测试）。
 */
async function put(at: string, text: string): Promise<void> {
  await mkdir(path.dirname(at), { recursive: true });
  const tmp = `${at}.writing`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, at);
}

/**
 * 成绩单落成 `---` 里包 JSON，跟稿子同一个约定。
 *
 * `---` 之后留给人：想在某一轮旁边写句「这次的第三条挺有用」，直接写就是了。
 */
const render = (run: RunRecord): string => `---\n${JSON.stringify(run, null, 2)}\n---\n\n`;

export function createLoopStore(root: string): LoopStore {
  return {
    async projects() {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      return entries.filter((one) => one.isDirectory()).map((one) => one.name);
    },

    async settings(project) {
      const at = path.join(root, safe("项目名", project), "loop.md");
      const text = await readFile(at, "utf8").catch(() => null);
      return text === null ? null : readConfig(text);
    },

    async enabled(project) {
      return await stat(onFile(root, project))
        .then(() => true)
        .catch(() => false);
    },

    async setEnabled(project, on) {
      const at = onFile(root, project);
      if (!on) {
        // 关掉就是把标记删了。**不写 `off` 文件**——「没有标记＝关着」只有一种表示，
        // 而两个文件互相矛盾时（both present）没有正确答案可选。
        await rm(at, { force: true });
        return;
      }
      await put(at, "");
    },

    async runs(project) {
      const dir = path.join(root, safe("项目名", project), "runs");
      // 没跑过就是没跑过，不是错误——**每个项目都有过这一刻**。
      const names = await readdir(dir).catch(() => []);
      const records = await Promise.all(
        names.map(async (name) => {
          const text = await readFile(path.join(dir, name, "run.md"), "utf8").catch(() => null);
          if (text === null) return null;
          try {
            return JSON.parse(text.slice(4, text.indexOf("\n---", 4))) as RunRecord;
          } catch {
            // 手改坏了一轮的成绩单，不该让整条时间线打不开——**别的轮次是无辜的**。
            return null;
          }
        }),
      );
      // 按**轮次**排，不是按目录名排。补零撑得住 9999 轮，撑不住第 10000 轮，
      // 而那时字典序会把 10000 排到 9999 前面——排序靠数字就不会有这一天。
      return records.filter((one): one is RunRecord => one !== null).sort((a, b) => b.n - a.n);
    },

    async saveReport(project, n, report) {
      // 同样一个字都不加工——它是给人读的。
      await put(path.join(runDir(root, project, n), "report.md"), report);
    },

    async runDetail(project, n) {
      const dir = tasksDir(root, project, n);
      const names = await readdir(dir).catch(() => []);
      const ids = names
        .filter((name) => name.endsWith(".task.md"))
        .map((name) => name.slice(0, -".task.md".length))
        // POSIX 不保证 `readdir` 的顺序。**这一行没有测试守得住**——这台机器上它
        // 恰好就返回有序的，去掉排序测试照样绿。留着是因为顺序一乱，人对着时间线
        // 上跳来跳去的编号会以为是漏了哪一件。
        .sort();

      const tasks = await Promise.all(
        ids.map(async (id) => {
          const source = await readFile(path.join(dir, `${id}.task.md`), "utf8");
          return {
            id,
            // 读不出来就用 id 顶着。**不能因为一份 task 的 frontmatter 坏了就整页打不开**
            // ——这一页正是人要来查「到底出了什么事」的地方。
            title: readTask(source)?.title ?? id,
            source,
            report: await readFile(path.join(dir, `${id}.report.md`), "utf8").catch(() => null),
          };
        }),
      );

      const report = await readFile(path.join(runDir(root, project, n), "report.md"), "utf8").catch(
        () => null,
      );
      return { report, tasks };
    },

    async savePlan(project, n, plan) {
      await put(path.join(runDir(root, project, n), "plan.md"), plan);
    },

    async saveTaskFile(project, n, id, source) {
      await put(path.join(tasksDir(root, project, n), `${safe("task id", id)}.task.md`), source);
    },

    async saveRun(project, run) {
      await put(path.join(runDir(root, project, run.n), "run.md"), render(run));
    },
    async taskStates(project, n, taskIds) {
      // 目录还不存在就是一个都没跑过——不是错误，那是**每一轮的第一刻**。
      const files = await readdir(tasksDir(root, project, n)).catch(() => []);
      return recover(taskIds, files);
    },

    async beginTask(project, n, id, intent) {
      await put(
        path.join(tasksDir(root, project, n), `${safe("task id", id)}.intent.json`),
        JSON.stringify(intent, null, 2),
      );
    },

    async finishTask(project, n, id, report) {
      // **一个字都不加工。** report 是给人读的产出，不是我们的内部记录。
      await put(path.join(tasksDir(root, project, n), `${safe("task id", id)}.report.md`), report);
    },
  };
}

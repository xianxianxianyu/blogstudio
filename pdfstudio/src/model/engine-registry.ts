/**
 * 引擎账本：记下拉起过的 `llama-server`，下次启动时收尸。
 *
 * **为什么必须有**：`llama-server` 是 `spawn()` 出来的子进程，而 Node 的子进程不跟着
 * 父进程死。应用被 `pkill`、被强制退出、或者自己崩掉，那个占着 3 GB 的进程就被系统
 * 收养，继续跑着——而 `freePort()` 每次随机选端口，下一次启动根本发现不了它，于是
 * 再起一个。实际后果量过：重启五次，四个孤儿，14 GB，机器卡死。
 *
 * 「退出时停掉」是必要的，但**它覆盖不了 SIGKILL 和崩溃**，而那正是实际发生的情况。
 * 所以这一层是兜底：账本落盘，下次开机先扫一遍。
 *
 * **不做引用计数、不做跨实例共享。** 本地单用户工具，多开两个实例各自起一个引擎是
 * 可以接受的浪费；引用计数是一份分布在两个进程里的状态，写错了就是杀掉别人正在用的
 * 引擎，而且没有任何东西会报错。
 */
export interface EngineRecord {
  /** 哪个引擎（recognition / embedding）。只为排查时好看。 */
  id: string;
  pid: number;
  port: number;
}

export interface RegistryDeps {
  load(): Promise<EngineRecord[]>;
  save(records: EngineRecord[]): Promise<void>;
  /**
   * 这个 pid 现在是什么进程，不存在就给 null。
   *
   * **不能只问「活着吗」**：pid 会被系统回收再分配，上一次记下的号码这会儿可能是
   * 浏览器的某个 helper。照着杀就是杀无辜，而且现象是「别的软件莫名其妙没了」，
   * 根本查不到这里。
   */
  commandOf(pid: number): string | null;
  kill(pid: number): void;
}

export interface EngineRegistry {
  remember(record: EngineRecord): Promise<void>;
  forget(pid: number): Promise<void>;
  /** 收尸。返回杀掉几个——调用方拿它写日志，静悄悄地杀掉三个进程比留着更吓人。 */
  reap(): Promise<number>;
}

/** 认得出是我们那个引擎才动手。 */
const OURS = "llama-server";

export function createEngineRegistry(deps: RegistryDeps): EngineRegistry {
  // 账本坏了、没有、写不进去，都不该把应用拦在门外——收尸是清扫，不是主线。
  const load = () => deps.load().catch(() => [] as EngineRecord[]);
  const save = (records: EngineRecord[]) => deps.save(records).catch(() => undefined);

  return {
    async remember(record: EngineRecord): Promise<void> {
      const others = (await load()).filter((one) => one.pid !== record.pid);
      await save([...others, record]);
    },

    async forget(pid: number): Promise<void> {
      await save((await load()).filter((one) => one.pid !== pid));
    },

    async reap(): Promise<number> {
      const stale = (await load()).filter(
        // 自己绝不能杀。记错一次就是应用启动时自杀，现象是「点了图标闪一下就没了」。
        (one) => one.pid !== process.pid && (deps.commandOf(one.pid) ?? "").includes(OURS),
      );
      for (const one of stale) deps.kill(one.pid);
      // 无论杀没杀成都清账：留着的话下次启动会去杀一批早就不存在的 pid，
      // 而那些号码那时可能已经属于别人了。
      await save([]);
      return stale.length;
    },
  };
}

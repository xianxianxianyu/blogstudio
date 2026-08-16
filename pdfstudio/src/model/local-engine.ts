/**
 * 本地识别引擎的生命周期：下权重、拉起 `llama-server`、健康检查、停止。
 *
 * **与 `ModelClient` 正交的另一个端口**（ADR-0015）。下载、校验、进程管理、端口分配都
 * 不是「模型调用」，塞进 `ModelClient` 会污染一个刻意保持极薄的 SDK-agnostic 端口
 * （ADR-0009 边界）。这里的产物只是一个 `baseURL`，喂给已有的 `createModelClient`
 * ——`ModelClient` 契约零改动。
 */
export interface EngineAsset {
  url: string;
  /** 相对引擎目录的落盘路径。 */
  target: string;
  /** 预期体积（MB），只用来把进度说成人话。 */
  bytes: number;
}

export interface RunningProcess {
  baseURL: string;
  stop(): void;
}

export interface EngineDeps {
  assets: EngineAsset[];
  has(target: string): Promise<boolean>;
  fetch(asset: EngineAsset): Promise<void>;
  spawn(): Promise<RunningProcess>;
  onProgress?: (text: string | null) => void;
}

export interface EngineStatus {
  running: boolean;
  baseURL: string | null;
}

export interface LocalEngine {
  /** 保证引擎可用，返回它的地址。已经在跑就直接返回，不重复拉起。 */
  ensureReady(): Promise<{ baseURL: string }>;
  status(): EngineStatus;
  stop(): void;
}

export function createLocalEngine(deps: EngineDeps): LocalEngine {
  let running: RunningProcess | null = null;
  // 保存的是**进行中**的那次准备，不是结果：每次识别都会走一遍 ensureReady，
  // 不去重的话读者框第二下就多起一个占着几 GB 内存的 llama-server，而且没人知道它在。
  let starting: Promise<RunningProcess> | null = null;

  async function start(): Promise<RunningProcess> {
    for (const asset of deps.assets) {
      if (await deps.has(asset.target)) continue;
      // 1.7 GB 不报进度就是几分钟毫无动静——向量模型那次只有 326 MB 就已经让读者
      // 以为应用坏了。
      deps.onProgress?.(`正在下载 ${asset.target}（约 ${asset.bytes} MB，只需一次）`);
      await deps.fetch(asset);
    }
    deps.onProgress?.("正在启动本地识别引擎…");
    const process = await deps.spawn();
    deps.onProgress?.(null);
    return process;
  }

  return {
    async ensureReady(): Promise<{ baseURL: string }> {
      if (running) return { baseURL: running.baseURL };

      // **失败的 promise 不能留。** 缓存住的话这个实例此后每次调用都以同一个错误
      // reject，再也没有重试的路径——embedder 那边踩过一次，同一个形状。
      starting ??= start().catch((error: unknown) => {
        starting = null;
        deps.onProgress?.(null);
        throw error;
      });

      running = await starting;
      return { baseURL: running.baseURL };
    },

    status(): EngineStatus {
      return { running: running !== null, baseURL: running?.baseURL ?? null };
    },

    stop(): void {
      running?.stop();
      running = null;
      starting = null;
    },
  };
}

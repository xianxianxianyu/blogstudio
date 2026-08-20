import { RecognizeError } from "../recognizer/recognizer";

/**
 * 偶发失败就再试一次。
 *
 * **为什么必须有这个**：目录识别是逐页调模型的，任何一页抛错都会把整轮作废——前面
 * 已经认好的页一起丢。而这类失败实测就是偶发的：同一张 253 KB 的目录页，同一个端点，
 * 失败过一次（502），紧接着连打六次全过。没有重试的话，一次网络抖动就等于「这本书
 * 的目录建不起来」，而读者能做的只有从头再来一遍——那正是重试该替他做的事。
 *
 * **只重试「过一会儿也许就好了」那一类。** `bad-output` 不重试：模型没按约定给 JSON
 * 是这张图加这个 prompt 的结果，再问一遍多半是同样的形状，白花一次钱。不认识的错更
 * 不重试——那通常是代码写错了，重试只会把 bug 藏起来。
 */
export interface RetryOptions {
  tries: number;
  /** 注入点，测试用来跳过真实等待。 */
  wait: (ms: number) => Promise<void>;
}

const BACKOFF_MS = 700;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 值得再试一次的：端点这一刻不通。 */
function transient(error: unknown): boolean {
  return error instanceof RecognizeError && error.kind === "model-unavailable";
}

export async function retrying<T>(
  attempt: () => Promise<T>,
  options: RetryOptions = { tries: 3, wait: sleep },
): Promise<T> {
  for (let tried = 1; ; tried++) {
    try {
      return await attempt();
    } catch (error) {
      // 试满了就把**最后一次**的错原样抛出去，不包一层。包一层只会让错误链更长，
      // 而读者要看的是「最后到底为什么不行」。
      if (tried >= options.tries || !transient(error)) throw error;
      // 递增退避：连着立刻重试三次，撞上的是同一阵故障，等于只试了一次。
      await options.wait(BACKOFF_MS * tried);
    }
  }
}

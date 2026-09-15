import { ModelError } from "./model-client";

/**
 * 重试策略。**两条路（SDK 那条和主进程那条裸 fetch）共用同一份。**
 *
 * 重试就是重新计费：Anthropic 的 Messages API 没有 idempotency key，同一个请求发两次
 * 在计费上就是两次。所以这套规矩只能有一份——两份迟早会漂，而漂出来的那一份多半是
 * 更宽松的那个。
 */

/**
 * 可以重试的状态码。**只有 429。**
 *
 * 判据是一句话：**上游明确回话说「我没做」。** 限流是在处理之前就把请求挡回来的，
 * 那一次不可能计过费，重试是干净的。
 *
 * 5xx 和 408 不在里面，哪怕它们看起来也像「没做成」——网关超时返回 504 的时候，
 * 上游很可能正把整个回答生成完并计上费。**那种情形在客户端这一侧分不出来**，
 * 分不出来就不能猜。
 */
export const RETRY_STATUS = new Set([429]);

/** 最多再发两次。加上第一次共三次。 */
export const RETRIES = 2;

/** 越等越久。限流时立刻重来，只是把同一堵墙再撞一次。 */
export const backoffMs = (attempt: number): number => 1000 * 2 ** attempt;

/**
 * 网关自己回话说「上游没接」——同一条判据的另一种写法。
 *
 * 前面那个 `v1.codx.qzz.io` 是一池账号轮着用的网关：轮到坏账号时它回 502
 * `{"error":{"type":"upstream_error","message":"Upstream access forbidden"}}`，那一次
 * 上游一个字都没跑，跟 429 一样干净；隔几秒再来多半就换到好账号了（真测过：同一分钟
 * 里 502 和 200 交替）。**只认这个形状**：裸的 502 / 504 仍然不碰，理由见 `RETRY_STATUS`。
 */
export function refusedByGateway(cause: unknown): boolean {
  const status = statusOf(cause);
  if (status !== 502 && status !== 503) return false;
  const body = (cause as { responseBody?: unknown } | null)?.responseBody;
  if (typeof body !== "string") return false;
  try {
    return (JSON.parse(body) as { error?: { type?: unknown } })?.error?.type === "upstream_error";
  } catch {
    return false;
  }
}

export const retryable = (error: unknown, attempt: number): boolean =>
  attempt < RETRIES &&
  error instanceof ModelError &&
  error.status !== undefined &&
  (RETRY_STATUS.has(error.status) || refusedByGateway(error.cause));

/** 上游响应体里那句人话（`{"error":{"message":…}}`），有就带上；没有就空串。 */
function upstreamMessage(cause: unknown): string {
  const body = (cause as { responseBody?: unknown } | null)?.responseBody;
  if (typeof body !== "string") return "";
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
    return typeof message === "string" ? message.slice(0, 200) : "";
  } catch {
    return "";
  }
}

/** SDK 各处对 HTTP 状态的叫法不一：`statusCode` 与 `status` 都见过。 */
export function statusOf(cause: unknown): number | undefined {
  const status =
    (cause as { statusCode?: number; status?: number } | null)?.statusCode ??
    (cause as { status?: number } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** 底层错误翻译成契约里的 ModelError，不往外漏（ADR-0007）。 */
export function toModelError(cause: unknown): ModelError {
  const status = statusOf(cause);
  if (typeof status === "number") {
    // 把上游那句话带上：SDK 只报状态行，而「HTTP 502」和「HTTP 502：Upstream access
    // forbidden」在界面上是两种排查方向。
    const said = upstreamMessage(cause);
    return new ModelError("http", `模型端点返回 HTTP ${status}${said ? `：${said}` : ""}`, { cause, status });
  }
  return new ModelError("http", "模型调用失败", { cause });
}

/** 真实的等待。测试注一个不等的，省得为了看重试真睡几秒。 */
export const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((done) => setTimeout(done, ms));

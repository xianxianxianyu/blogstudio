/**
 * 把 `cause` 链整条摊平成一行行文字。
 *
 * 只报最外层会把真正的原因吞掉——「model-unavailable：模型调用失败」这种话对排查毫无
 * 帮助，而 `RecognizeError` 特意保留了 `cause` 正是为了这一刻。这个教训付过一次学费：
 * 公式识别报「模型调用失败」，真实原因（baseURL 是相对路径，SDK 构造 URL 时直接抛）
 * 被外层吞掉，只能靠猜。
 *
 * 认 `kind` 是因为领域错误把可分支的信息放在那儿（`ModelError.kind`、
 * `RecognizeError.kind`），比 `name` 一律是 "Error" 有用。
 */
export function errorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  for (let current: unknown = error; current instanceof Error; ) {
    // 自引用或成环的 cause 会让这个循环永远转下去。真见过库这么干，而挂死的界面
    // 比一条难看的错误信息糟糕得多。
    if (seen.has(current)) break;
    seen.add(current);
    parts.push(`${(current as { kind?: string }).kind ?? current.name}: ${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }

  return parts.join("\n  ↳ ");
}

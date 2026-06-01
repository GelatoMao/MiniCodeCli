// @mini-code-cli/core — Shared tool error formatting
//
// 所有 `tool({ execute })` 的 catch 块都遵循相同的模式：
//   捕获 unknown 异常 → 提取字符串消息 → 返回 "Error <action>: <msg>"
//
// 将这个逻辑集中到这里有两个好处：
//   1. 措辞保持一致，模型在看到工具结果时能稳定识别错误格式
//   2. 消除每个工具文件里重复的 `err instanceof Error ? err.message : String(err)` 片段

/**
 * 从任意 unknown 值提取可读的错误消息字符串。
 *
 * - 如果是标准 Error 对象，返回 `.message`（已包含具体原因）
 * - 否则强制转换为字符串（覆盖 string、number、自定义对象等情况）
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 将工具执行失败格式化为模型可见的结果字符串。
 *
 * @param action - 短动词短语，描述正在做什么，例如 "reading file"、"searching"
 * @param err    - catch 块捕获的任意异常
 * @returns 格式为 `"Error <action>: <message>"` 的字符串，
 *          模型收到这种格式的工具结果后会理解操作失败并决定下一步
 *
 * @example
 * // 文件不存在时返回：
 * // "Error reading file: ENOENT: no such file or directory, open '/tmp/foo.ts'"
 * return formatToolError('reading file', err)
 */
export function formatToolError(action: string, err: unknown): string {
  return `Error ${action}: ${toErrorMessage(err)}`
}

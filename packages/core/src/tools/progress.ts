// @mini-code-cli/core — Tool progress reporter (side channel)
//
// 【问题背景】
// AI SDK 的 tool `execute` 函数签名是固定的：
//   execute(input, { toolCallId, messages, abortSignal }) => Promise<result>
// 我们无法在 streamText({ tools }) 的定义阶段把 UI 进度回调注入进去，
// 因为每次调用的回调实例是动态绑定到 React state 的，而 tool 定义是静态的。
//
// 【解决方案：模块级侧信道 registry】
// - agent loop 在收到模型的 tool-call 事件时，用 toolCallId 注册一个 reporter
// - 工具的 execute 函数内部通过 reportProgress(toolCallId, msg) 查找并调用它
// - agent loop 在收到 tool-result 后清理该 reporter，避免内存泄漏
//
// 这种 "registry by toolCallId" 模式对手动分发工具（writeFile、edit、shell）
// 同样有效——它们的执行发生在 tool-execution.ts 中，而非 AI SDK 内部，
// 但同样可以通过 toolCallId 找到对应的 reporter。

/** 进度回调函数类型。接收一条人类可读的状态消息，由 UI 层显示给用户。 */
export type ProgressReporter = (message: string) => void

/**
 * 活跃的进度 reporter 映射表。
 * key = toolCallId（由 AI SDK 生成的唯一字符串，如 "toolu_01ABC..."）
 * value = UI 层注册的回调函数
 *
 * 使用 Map 而非普通对象，是因为 toolCallId 是运行时动态字符串，
 * Map 在频繁增删时性能优于对象。
 */
const reporters = new Map<string, ProgressReporter>()

/**
 * 为指定 toolCallId 注册进度回调。
 * 应在 agent loop 收到 tool-call 事件时立即调用，确保工具 execute 开始前已就绪。
 *
 * @param toolCallId - AI SDK 分配的工具调用唯一 ID
 * @param fn         - 进度消息回调，通常会更新 React state 触发 UI 重绘
 */
export function setProgressReporter(toolCallId: string, fn: ProgressReporter): void {
  reporters.set(toolCallId, fn)
}

/**
 * 移除指定 toolCallId 的进度回调，防止内存泄漏。
 * 应在 agent loop 处理完 tool-result 后调用。
 *
 * @param toolCallId - 要清理的工具调用 ID
 */
export function clearProgressReporter(toolCallId: string): void {
  reporters.delete(toolCallId)
}

/**
 * 向 UI 层发送进度消息。如果没有注册对应的 reporter 则静默 no-op。
 *
 * 工具的 execute 函数内部调用此函数，无需感知外部依赖。
 * toolCallId 可能为 undefined（例如在单元测试中直接调用工具函数时），
 * 此时安全跳过，不产生任何副作用。
 *
 * @param toolCallId - 工具调用 ID（可能为 undefined）
 * @param message    - 展示给用户的进度消息，例如 "Reading /path/to/file"
 */
export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return
  reporters.get(toolCallId)?.(message)
}

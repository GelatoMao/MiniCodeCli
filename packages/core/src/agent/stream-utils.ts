// @mini-code-cli/core — Stream result helpers
//
// 说明：
//   AI SDK 的 streamText() 返回一个复杂的泛型对象，其中包含多个并发的 Promise
//   和一个异步迭代器 fullStream。
//
//   这里定义 StreamResult 接口，只声明我们实际使用的字段，
//   避免在 loop.ts 中到处写 as unknown as X 的类型断言。
//
//   drainStreamResult 是一个防御性工具：当流发生错误时，
//   AI SDK 会同时 reject response / finishReason / usage / toolCalls 这四个 Promise。
//   若我们只 await fullStream 的错误分支而没有给其他 Promise 添加 .catch()，
//   Node.js 的 unhandledRejection 扫描会先于我们的 catch 块运行，
//   打印 NoOutputGeneratedError 并可能终止进程。
//   提前调用 drainStreamResult 给它们都挂上静默的 noop catch handler 即可避免。
import type { ModelMessage } from 'ai'

// ── StreamResult ─────────────────────────────────────────────────────────────

/** streamText() 返回值的最小形状——只含 loop.ts 实际使用的字段。
 *
 *  fullStream 的 chunk 类型列举了所有我们关心的 discriminated-union 变体。
 *  SDK 还会产生 reasoning-delta / reasoning-start 等 chunk，
 *  我们在 streamChunksToUI 中统一忽略（drop-through）。*/
export interface StreamResult {
  /** 异步迭代器，逐 chunk 推送 streaming 内容。
   *  chunk.type 是 discriminated union：
   *    'text-delta'  — 模型生成的文字片段
   *    'tool-call'   — 模型决定调用工具
   *    'tool-result' — auto-execute 工具的执行结果（不经过手动分发）
   *    'error'       — 请求失败（SDK 不从迭代中 throw，而是放进 chunk）*/
  fullStream: AsyncIterable<{
    type: string
    /** 'text-delta' chunk 的文字内容 */
    text?: string
    /** 'tool-call' chunk 的工具名 */
    toolName?: string
    /** 'tool-call' chunk 的工具输入 */
    input?: unknown
    /** 'tool-result' chunk 的工具输出 */
    output?: unknown
    /** 'tool-call' / 'tool-result' chunk 的调用 ID，用于配对 */
    toolCallId?: string
    /** 'error' chunk 的原始 provider 错误（SDK 包裹后的 Error 或 unknown） */
    error?: unknown
  }>
  /** 流结束后解析为本轮 assistant + tool_result 消息数组。
   *  collectTurnResponse 从这里获取消息并推入 state.messages。*/
  response: Promise<{ messages: ModelMessage[] }>
  /** 本轮 token 用量。AI SDK v6 在 inputTokenDetails 中归一化了各厂商的
   *  cache 字段（Anthropic cache_read / OpenAI cached_tokens → cacheReadTokens）。*/
  usage: Promise<
    | {
        inputTokens?: number
        outputTokens?: number
        /** AI SDK v6 归一化的缓存字段（是 inputTokens 的子集，不要重复计入 total）*/
        inputTokenDetails?: {
          cacheReadTokens?: number
          /** Anthropic cache_creation_input_tokens */
          cacheWriteTokens?: number
        }
      }
    | undefined
  >
  /** 流结束原因：'stop' | 'tool-calls' | 'length' | 'content-filter' | ... */
  finishReason: Promise<string>
  /** 本轮所有工具调用（toolName + toolCallId + input）*/
  toolCalls: Promise<
    Array<{
      toolName: string
      toolCallId: string
      input: Record<string, unknown>
    }>
  >
}

// ── drainStreamResult ────────────────────────────────────────────────────────

/** 给 StreamResult 上所有挂起的 Promise 注册静默的 noop catch handler。
 *
 *  调用时机：在 streamChunksToUI 从 fullStream 捕获到错误之后立即调用。
 *  这样做是为了防止 Node.js 的 unhandledRejection 机制把 SDK 内部的
 *  NoOutputGeneratedError 打印到 stderr 甚至终止进程。
 *
 *  幂等性：即使某个 Promise 已经 settled，再加 .catch(noop) 也完全无害。
 *  稍后执行的 `await result.response` 仍然会正常 reject 并通过外层 catch 传播。*/
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}

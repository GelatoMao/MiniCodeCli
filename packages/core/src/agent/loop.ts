// @mini-code-cli/core — Agent Loop（编排：流式 streaming + 单轮 streamText）
//
// 本文件是 task3 的最小实现版本：
//   - 只处理 finishReason === 'stop'（纯文字回答）
//   - 不处理工具调用（task6 才接入完整 ReAct 循环）
//   - 不做 context 压缩、plan-mode、sub-agent（后续 task 逐步叠加）
//
// 核心函数调用链：
//   agentLoop
//     └─ runTurn
//           ├─ streamText (AI SDK)
//           ├─ streamChunksToUI  (消费 fullStream，分发 callbacks)
//           └─ collectTurnResponse (收集 response/usage 写入 state)
import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'

// ── 重导出 ───────────────────────────────────────────────────────────────────

export type { LoopState } from './loop-state.js'
export { createLoopState } from './loop-state.js'

// ── AgentLoopResult ──────────────────────────────────────────────────────────

/** agentLoop 的返回值。
 *
 *  - `state`：长生命周期会话状态（messages、tokenUsage 等）。
 *    交互式 CLI 保存在 loopStateRef，并在下次用户提交时作为 existingState 传回。
 *  - `turnCount`：本次 agentLoop 调用内跑了多少轮 streamText。
 *    注意：不累计跨次提交 — `--print` 模式和 sub-agent 是真正的消费者，
 *    交互式主循环一般不关心这个值。*/
export interface AgentLoopResult {
  state: LoopState
  turnCount: number
}

// ── streamChunksToUI ─────────────────────────────────────────────────────────

/** 消费 streamText 的 fullStream，将各类 chunk 分发给 UI callbacks。
 *
 *  chunk 处理规则：
 *    text-delta   → callbacks.onTextDelta（用户可见的文字流）
 *    tool-call    → callbacks.onToolCall（告知 UI 工具即将执行）
 *    tool-result  → callbacks.onToolResult（auto-execute 工具的执行结果）
 *    error        → 重新 throw（SDK 不从 fullStream 迭代中 throw，而是放进 chunk）
 *    其他         → 静默丢弃（reasoning-delta、reasoning-start 等思考链内容
 *                  是模型内部思考过程，不向用户展示）
 *
 *  为什么不直接用 result.text？
 *    result.text 需要等整个流结束才能解析，无法做流式 UI 更新。
 *    fullStream 可以边生成边推送 delta，体验更好。*/
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // AI SDK 不从 fullStream 迭代中 throw，而是把错误封装成 chunk 推入流然后关闭。
      // 如果不在这里 re-throw，外层循环会正常完成，然后 `await result.response`
      // 会以 NoOutputGeneratedError 拒绝 — 用户看到的是莫名其妙的泛型错误，
      // 而不是真实的 provider 错误（如"insufficient balance"）。
      // re-throw 原始错误，让外层 try/catch 捕获并做正确的错误分类展示。
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }

    if (chunk.type === 'text-delta') {
      // 流式文字 delta — 直接推给 UI 渲染
      callbacks.onTextDelta(chunk.text ?? '')
    } else if (chunk.type === 'tool-call') {
      // 模型决定调用工具 — 通知 UI 显示工具调用行
      // toolCallId 用于后续的 onToolResult / onToolProgress 配对
      callbacks.onToolCall(
        chunk.toolCallId ?? '',
        chunk.toolName ?? '',
        (chunk.input ?? {}) as Record<string, unknown>,
      )
    } else if (chunk.type === 'tool-result') {
      // auto-execute 工具（readFile、glob 等内置工具）的结果
      // 通过 result.toolCalls 收集的是手动分发工具，
      // 而这里的 tool-result chunk 是 AI SDK 直接执行的结果
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      callbacks.onToolResult(chunk.toolCallId ?? '', raw)
    }
    // 其他 chunk 类型（reasoning-delta 等）— 静默丢弃
  }
}

// ── collectTurnResponse ──────────────────────────────────────────────────────

/** 从已完成的 StreamResult 收集 response 和 usage，写入 state。
 *
 *  调用时机：streamChunksToUI 完成（fullStream 消耗完）之后。
 *
 *  主要工作：
 *    1. await result.response — 获取本轮产生的消息（assistant + tool_result）
 *    2. 将这些消息 push 进 state.messages，维护完整会话历史
 *    3. await result.usage   — 获取 token 用量
 *    4. 累加到 state.tokenUsage，更新 lastInputTokens 和 currentContextTokens
 *    5. 调用 callbacks.onUsageUpdate 通知 UI 刷新 token 计数器
 *    6. 返回 finishReason（'stop' / 'tool-calls' / 'length' / ...）*/
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  callbacks: AgentCallbacks,
): Promise<string> {
  // 等待 response — 包含本轮 assistant 消息和 auto-execute 工具结果
  const response = await result.response
  // 将本轮产生的所有消息追加到 state.messages，维护完整历史
  state.messages.push(...response.messages)

  // 等待 usage — 获取 token 计数
  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0

    // AI SDK v6 将各厂商的 cache 字段归一化到 inputTokenDetails：
    //   cacheReadTokens  ← Anthropic cache_read_input_tokens / OpenAI cached_tokens
    //   cacheWriteTokens ← Anthropic cache_creation_input_tokens（其他厂商: 0）
    // 两者都是 inputTokens 的子集，不重复计入 total
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens

    // currentContextTokens = 本轮 input + output，反映当前上下文窗口占用
    // 用于 UI 底部状态栏的 "N / M · X%" 指标（非累计，每轮覆盖）
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens

    // 通知 UI 刷新 token 计数器
    callbacks.onUsageUpdate(state.tokenUsage)
  }

  return result.finishReason
}

// ── TurnOutcome ──────────────────────────────────────────────────────────────

/** 单轮 runTurn 的结果类型。
 *  使用 discriminated union 让调用方可以安全地 switch/if-else 分支处理。*/
type TurnOutcome =
  /** 正常完成；finishReason 决定下一步动作（stop / tool-calls / length / ...）*/
  | { kind: 'done'; finishReason: string; result: StreamResult }
  /** 严重错误（已通过 callbacks.onError 上报）；调用方应 break 循环。*/
  | { kind: 'error' }
  /** 用户主动中断（Esc / Ctrl+C）。不报告 onError — UI 显示 [Request interrupted by user] 提示。*/
  | { kind: 'aborted' }

// ── isAbortError ─────────────────────────────────────────────────────────────

/** 判断一个错误是否来自用户中断（AbortController.abort()）。
 *
 *  为什么不只检查 error.name === 'AbortError'？
 *    部分 provider（尤其是通过自定义 fetch 接入的）会把底层的 AbortError
 *    包裹进自己的错误类，但仍然会在 abort 前先翻转 signal.aborted 标志。
 *    所以先检查 signal.aborted 是最可靠的方式。*/
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

// ── runTurn ──────────────────────────────────────────────────────────────────

/** 执行单轮 streamText 调用。
 *
 *  职责：
 *    1. 调用 AI SDK 的 streamText，传入 model、messages、system prompt 等
 *    2. 调用 streamChunksToUI 消费 fullStream，将 delta 推给 UI
 *    3. 调用 collectTurnResponse 收集 response/usage 写入 state
 *    4. 将各类错误（abort / api error）规范化为 TurnOutcome 返回
 *
 *  不直接处理工具调用 — 调用方（agentLoop）检查 finishReason 后决定是否进入
 *  工具执行分支（task6 实现）。*/
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
): Promise<TurnOutcome> {
  let result: StreamResult
  try {
    // streamText 返回一个"立即可读"的结果对象 — 它内部已经发起了 fetch 请求，
    // fullStream 是一个 async iterable，消费时才真正消耗网络 IO。
    // 这里不需要 await，只是创建对象。
    result = streamText({
      model,
      system: systemPrompt,
      messages: state.messages,
      // 无工具（task3 阶段），tools 不传
      maxRetries: 3,
      abortSignal: options.abortSignal,
      // 屏蔽 SDK 默认的 console.error(error)（会把完整 RetryError 堆栈 dump 到 stderr）
      // 我们在下面的 catch 中用 callbacks.onError 给用户展示友好信息
      onError: () => {},
    }) as unknown as StreamResult
  } catch (err) {
    // streamText 同步抛出（极少见，通常是参数校验失败）
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    return { kind: 'error' }
  }

  // 提前给所有兄弟 Promise 挂上 noop catch，防止 Node.js unhandledRejection
  // 在我们进入错误处理分支之前先触发。幂等操作，无副作用。
  drainStreamResult(result)

  // 消费 fullStream，分发 chunk 给 UI
  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    // 流中途出错（网络断开、provider 返回 4xx/5xx 等）
    // 再次 drain，防止后续 await 触发 unhandledRejection
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    return { kind: 'error' }
  }

  // 收集 response + usage 写入 state
  try {
    const finishReason = await collectTurnResponse(result, state, callbacks)
    return { kind: 'done', finishReason, result }
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    return { kind: 'error' }
  }
}

// ── agentLoop ────────────────────────────────────────────────────────────────

/** 主 agent 循环。
 *
 *  task3 阶段的简化版本：
 *    - 只处理 finishReason === 'stop'（纯文字回答，模型自然结束）
 *    - finishReason === 'tool-calls' 时打印警告并退出（task6 完整实现）
 *    - finishReason === 'length' 时报错（task6 可选扩展为自动续写）
 *
 *  @param userMessage 用户输入（字符串或多模态内容）
 *  @param model       AI SDK LanguageModel 实例（由 registry.languageModel() 创建）
 *  @param options     运行选项（modelId、trustMode、abortSignal 等）
 *  @param callbacks   UI 回调（onTextDelta、onToolCall 等）
 *  @param existingState 可选：从上一次 agentLoop 调用延续的 state（多轮对话）
 */
export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
): Promise<AgentLoopResult> {
  // 使用已有 state（多轮对话续接）或创建新 state（会话首次提交）
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // 将用户消息推入历史
  state.messages.push({ role: 'user', content: userMessage })

  // 每次 agentLoop 调用独立的 turn 计数器（不跨次累计）
  let turn = 0

  // task3 使用静态系统提示，task-A 会替换为 buildSystemPrompt()
  const systemPrompt =
    options.systemPromptExtra ??
    'You are a helpful AI assistant. Respond concisely and accurately to the user\'s questions.'

  // No `maxTurns` → 运行到模型 stop 或用户中断
  // task3 阶段不会无限循环（只处理 stop，遇到 tool-calls 就退出）
  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks)

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break

    if (outcome.finishReason === 'stop') {
      // 正常结束 — 模型已输出完整回答
      break
    }

    if (outcome.finishReason === 'tool-calls') {
      // task3 阶段暂不处理工具调用（task6 实现完整 ReAct 循环）
      // 这里收到 tool-calls 说明传入了工具，但我们目前不传工具，
      // 所以正常使用中不应该走到这个分支
      callbacks.onError(new Error('[task3] tool-calls finishReason received — tool execution not yet implemented'))
      break
    }

    if (outcome.finishReason === 'length') {
      // 输出 token 耗尽 — task6 可扩展为自动续写（MAX_CONTINUATIONS 机制）
      callbacks.onError(new Error('Response truncated: output token limit reached. Try a narrower question.'))
      break
    }

    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('Response stopped by the provider content filter.'))
      break
    }

    // 未知 finishReason — 安全退出，避免无限循环
    break
  }

  // 超出 maxTurns 检查（仅在设置了上限时）
  if (options.maxTurns !== undefined && turn >= options.maxTurns) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  return { state, turnCount: turn }
}

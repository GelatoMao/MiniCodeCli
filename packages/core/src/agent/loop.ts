// @mini-code-cli/core — Agent Loop（编排：流式 streaming + 完整 ReAct 工具调用循环）
//
// task6 在 task3 基础上新增：
//   - buildTools()：汇总工具注册表，传给 streamText
//   - finishReason === 'tool-calls' 分支：调用 processToolCalls 执行工具，继续循环
//   - finishReason === 'length' 分支：推入续写提示，最多续写 3 次（MAX_CONTINUATIONS）
//   - runTurn 前调用 repairOrphanToolCalls（防御性修复孤立 tool_call）
//   - collectTurnResponse 里调用 truncateToolResultsInMessages（auto-execute 结果截断）
//   - 在 streamChunksToUI 里注册 progress reporter（setProgressReporter）
//
// task13 新增：
//   - runTurn 中调用 applyCacheControl()，在发送给 API 前注入 Prompt Caching 标记
//   - Anthropic：在系统提示和末尾 3 条消息注入 cache_control: { type: 'ephemeral' }
//   - OpenAI：通过 promptCacheKey 设置前缀缓存 key
//   - 其他 provider：不作修改，依赖字节稳定的系统提示隐式触发 prefix cache
//
// task14 新增：
//   - 主循环每轮开始前调用 flushPendingMessages（增量写 JSONL，crash-safe 持久化）
//   - flushPendingMessages 之后调用 checkAndCompressContext（context 压缩，tokens 超限时触发）
//   - 正常 stop 后调用 appendUsage（写 usage 快照，便于后续会话统计）
//   - agentLoop 新增 cwd 参数传递给 session-store
//
// task15 新增：
//   - buildTools 接受可选的 toolsOverride 参数
//     - toolsOverride 非空时直接使用（sub-agent 场景：工具已过滤，不含 task 工具）
//     - toolsOverride 为空时重新构建（主 agent：toolRegistry + task 工具）
//   - agentLoop 新增可选参数 toolsOverride（runner.ts 通过此参数注入子工具集）
//   - 主 agent 的 buildTools 通过 createSubAgentRegistry 构建 task 工具并注入
//
// task16 新增：
//   - buildTools 从 options.mcpRegistry 注入 MCP 工具（bridgeAllMcpTools）
//   - MCP 工具为手动分发（无 execute），产出 tool-call chunk 后由 handleMcpToolCall 处理
//   - toolsOverride 场景（sub-agent）不注入 MCP 工具（sub-agent 工具白名单不含 MCP）
//
// 核心函数调用链：
//   agentLoop
//     └─ while loop
//           ├─ flushPendingMessages（task14：增量写 JSONL）
//           ├─ checkAndCompressContext（task14：context 压缩）
//           ├─ runTurn
//           │     ├─ repairOrphanToolCalls（防御性修复）
//           │     ├─ applyCacheControl（task13：注入缓存断点）
//           │     ├─ streamText（传 system / messages / tools）
//           │     ├─ streamChunksToUI（含 progress reporter 注册）
//           │     └─ collectTurnResponse（含 truncateToolResultsInMessages）
//           ├─ 'stop'    → appendUsage → break（正常结束）
//           ├─ 'tool-calls' → processToolCalls → continue（ReAct 循环）
//           └─ 'length'  → push 续写提示 → continue（最多 3 次）
import { streamText } from 'ai'
import type { LanguageModel, UserContent } from 'ai'

import { applyCacheControl } from '../providers/cache-control.js'
import { toolRegistry, truncateToolResult } from '../tools/index.js'
import { createTaskTool } from '../tools/task.js'
import { clearProgressReporter, setProgressReporter } from '../tools/progress.js'
import { bridgeAllMcpTools } from '../mcp/tool-bridge.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { createLoopState } from './loop-state.js'
import type { LoopState } from './loop-state.js'
import { checkAndCompressContext } from './compression.js'
import { flushPendingMessages, appendUsage } from './session-store.js'
import { createSubAgentRegistry } from './sub-agents/registry.js'
import { drainStreamResult } from './stream-utils.js'
import type { StreamResult } from './stream-utils.js'
import { processToolCalls } from './tool-execution.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from './tool-result-sanitize.js'

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

// ── buildTools ───────────────────────────────────────────────────────────────

/** 构建本次 session 的工具集。
 *
 *  task6 阶段：返回静态 toolRegistry（readFile/writeFile/edit/glob/grep/listDir/shell）。
 *
 *  task15 新增：
 *    - 如果传入 toolsOverride（sub-agent 场景），直接返回它（已由 runner.ts 过滤过）
 *    - 否则构建完整工具集：toolRegistry + task 工具（sub-agent 委托）
 *    - task 工具通过 createSubAgentRegistry 动态构建，包含所有可用 sub-agent 的描述
 *
 *  task16 新增：
 *    - 如果 options.mcpRegistry 非空且不是 toolsOverride 场景，
 *      调用 bridgeAllMcpTools 将所有 MCP 工具合并到工具集
 *    - MCP 工具名格式："<serverName>__<toolName>"（命名空间前缀防冲突）
 *    - sub-agent (toolsOverride) 场景不注入 MCP 工具（工具白名单已固定）
 *
 *  - 有 execute 的工具（readFile/glob/grep/listDir）：AI SDK 在 fullStream 内部自动执行
 *  - 无 execute 的工具（writeFile/edit/shell/task/MCP）：产出 tool-call chunk，
 *    由 agentLoop 在 finishReason='tool-calls' 时调用 processToolCalls 手动处理
 *
 *  @param options       AgentOptions（task16：通过 mcpRegistry 字段注入 MCP）
 *  @param cwd           当前工作目录（用于加载项目级自定义 sub-agent）
 *  @param toolsOverride 如果非 null，直接返回它（用于 sub-agent 工具过滤）*/
async function buildTools(
  options: AgentOptions,
  cwd?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolsOverride?: Record<string, any> | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  // sub-agent 场景：工具集已由 runner.ts 过滤，直接使用
  // sub-agent 不注入 MCP 工具（工具白名单由 built-in.ts 固定）
  if (toolsOverride != null) {
    return toolsOverride
  }

  // 主 agent 场景：构建完整工具集（静态工具 + task 工具 + MCP 工具）
  const registry = await createSubAgentRegistry(cwd)
  const taskTool = createTaskTool(registry)

  // task16：注入 MCP 工具
  // mcpRegistry 由 CLI 在启动时调用 loadMcpFromDisk() 初始化并传入
  // 若无 MCP 配置或加载失败，mcpRegistry 为 undefined，mcpTools 为空对象
  const mcpTools = options.mcpRegistry ? bridgeAllMcpTools(options.mcpRegistry) : {}

  return {
    ...toolRegistry,
    task: taskTool,
    ...mcpTools,
  }
}

// ── streamChunksToUI ─────────────────────────────────────────────────────────

/** 消费 streamText 的 fullStream，将各类 chunk 分发给 UI callbacks。
 *
 *  chunk 处理规则：
 *    text-delta   → callbacks.onTextDelta（用户可见的文字流）
 *    tool-call    → setProgressReporter + callbacks.onToolCall（告知 UI 工具即将执行）
 *    tool-result  → clearProgressReporter + callbacks.onToolResult（auto-execute 工具结果）
 *    error        → 重新 throw（SDK 不从 fullStream 迭代中 throw，而是放进 chunk）
 *    其他         → 静默丢弃（reasoning-delta 等思考链内容不向用户展示）
 *
 *  为什么在 tool-call 时注册 progress reporter？
 *    AI SDK 会在 tool-call event 之后同步调用 auto-execute 工具的 execute()，
 *    execute() 内部通过 reportProgress(toolCallId) 向 UI 推送实时状态。
 *    必须在 tool-call event 时（执行开始前）注册，否则首批 progress 消息丢失。*/
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
      callbacks.onTextDelta(chunk.text ?? '')
    } else if (chunk.type === 'tool-call') {
      const toolCallId = chunk.toolCallId ?? ''
      // 在工具执行开始前注册 progress reporter，确保 execute() 内部能推送进度
      if (toolCallId) {
        setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))
      }
      callbacks.onToolCall(
        toolCallId,
        chunk.toolName ?? '',
        (chunk.input ?? {}) as Record<string, unknown>,
      )
    } else if (chunk.type === 'tool-result') {
      // auto-execute 工具（readFile/glob 等）的结果
      const raw = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output ?? '')
      if (chunk.toolCallId) clearProgressReporter(chunk.toolCallId)
      callbacks.onToolResult(chunk.toolCallId ?? '', truncateToolResult(raw))
    }
    // 其他 chunk 类型（reasoning-delta 等）— 静默丢弃
  }
}

// ── collectTurnResponse ──────────────────────────────────────────────────────

/** 从已完成的 StreamResult 收集 response 和 usage，写入 state。
 *
 *  调用时机：streamChunksToUI 完成（fullStream 消耗完）之后。
 *
 *  task6 新增：
 *    - 在 push 之前调用 truncateToolResultsInMessages，防止 auto-execute 工具
 *      的超长结果（如 grep 匹配 2000 行）在每轮请求中占满 context window。*/
async function collectTurnResponse(
  result: StreamResult,
  state: LoopState,
  callbacks: AgentCallbacks,
): Promise<string> {
  const response = await result.response
  // 截断 auto-execute 工具结果（手动路径已经截断，这里处理 SDK 自动执行的部分）
  truncateToolResultsInMessages(response.messages)
  // 将本轮产生的所有消息追加到 state.messages，维护完整历史
  state.messages.push(...response.messages)

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens
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
 *  task6 相比 task3 的变化：
 *    1. 接受 effectiveTools 参数并传给 streamText
 *    2. 在调用 streamText 前执行 repairOrphanToolCalls（防御性修复）
 *
 *  task13 新增：
 *    3. 调用 applyCacheControl 为 Anthropic / OpenAI 注入 Prompt Caching 标记
 *       - Anthropic：系统提示 + 末尾 3 条消息注入 cache_control
 *       - OpenAI：系统提示注入 promptCacheKey
 *       - 其他：不修改，依赖字节稳定的前缀缓存自动命中
 *    4. 将 system 由字符串改为传 SystemModelMessage 对象，以携带 providerOptions*/
async function runTurn(
  state: LoopState,
  model: LanguageModel,
  options: AgentOptions,
  systemPrompt: string,
  callbacks: AgentCallbacks,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any>,
): Promise<TurnOutcome> {
  // 防御性修复：在每次 API 调用前确保 tool_call ↔ tool_result 配对完整。
  // 如果上一轮有孤立的 tool_call（模型输出 malformed 工具输入 → SDK 校验拒绝
  // 且未产生配对 result），这里会合成一条错误 result，防止 422。
  repairOrphanToolCalls(state.messages)

  // task13：注入 Prompt Caching 控制标记。
  // 返回的 systemMessage 和 cachedMessages 是带有 providerOptions 的新对象，
  // 不修改 state.messages（state 中保留原始消息，避免重复叠加断点）。
  const { systemMessage, messages: cachedMessages } = applyCacheControl(
    options.modelId,
    systemPrompt,
    state.messages,
    state.sessionId,
  )

  let result: StreamResult
  try {
    result = streamText({
      model,
      // system 字段接受字符串或 SystemModelMessage，这里传对象以携带 providerOptions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      system: systemMessage as any,
      messages: cachedMessages,
      tools: effectiveTools,
      maxRetries: 3,
      abortSignal: options.abortSignal,
      onError: () => {},
    }) as unknown as StreamResult
  } catch (err) {
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    return { kind: 'error' }
  }

  // 预先给所有兄弟 Promise 挂 noop catch，防止 Node.js unhandledRejection
  drainStreamResult(result)

  try {
    await streamChunksToUI(result, callbacks)
  } catch (err) {
    drainStreamResult(result)
    if (isAbortError(err, options.abortSignal)) return { kind: 'aborted' }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    return { kind: 'error' }
  }

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
 *  task6 完整 ReAct 实现：
 *    - 传入 tools 给 streamText，使模型能调用工具
 *    - finishReason === 'tool-calls' → processToolCalls → 继续循环
 *    - finishReason === 'length' → 推入续写提示，最多 MAX_CONTINUATIONS 次
 *    - 循环守卫（loop-guard.ts）防止模型陷入死循环
 *
 *  task14 新增：
 *    - 每轮开始前 flushPendingMessages（增量 JSONL 持久化）
 *    - flushPendingMessages 后 checkAndCompressContext（context 压缩）
 *    - 正常 stop 后 appendUsage（写 token usage 快照）
 *
 *  task15 新增：
 *    - 新增可选参数 toolsOverride：sub-agent 通过此参数传入过滤后的工具集
 *    - 主 agent 调用时不传 toolsOverride，由 buildTools 构建完整工具集（含 task 工具）
 *    - processToolCalls 需要访问 effectiveTools 来处理 task 工具调用
 *
 *  @param userMessage    用户输入（字符串或多模态内容）
 *  @param model          AI SDK LanguageModel 实例（由 registry.languageModel() 创建）
 *  @param options        运行选项（modelId、trustMode、abortSignal 等）
 *  @param callbacks      UI 回调（onTextDelta、onToolCall 等）
 *  @param existingState  可选：从上一次 agentLoop 调用延续的 state（多轮对话）
 *  @param cwd            工作目录（默认 process.cwd()），传给 session-store
 *  @param toolsOverride  可选：直接使用的工具集（sub-agent 场景，跳过 buildTools 构建）
 */
export async function agentLoop(
  userMessage: UserContent,
  model: LanguageModel,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  existingState?: LoopState,
  cwd?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolsOverride?: Record<string, any> | null,
): Promise<AgentLoopResult> {
  const state = existingState ?? createLoopState(options.permissionMode ?? 'default')

  // 将用户消息推入历史
  state.messages.push({ role: 'user', content: userMessage })

  let turn = 0

  // task6 使用静态系统提示，task-A 会替换为 buildSystemPrompt()
  const systemPrompt =
    options.systemPromptExtra ??
    "You are a helpful AI assistant. Respond concisely and accurately to the user's questions."

  // 构建工具集（本次 session 内稳定，不需要每轮重建）
  // task15：如果传入 toolsOverride（sub-agent 场景），buildTools 直接返回它
  const effectiveTools = await buildTools(options, cwd, toolsOverride)

  // 自动续写：finishReason === 'length' 时推入续写提示，最多续写 MAX_CONTINUATIONS 次。
  // 推理模型在输出 token 不足前有时会截断回答——
  // 旧行为是直接报错，看起来像是程序崩溃；续写机制让回答能自然完成。
  const MAX_CONTINUATIONS = 3
  let continuationAttempts = 0
  // 追踪是否以正常 stop 退出循环（用于判断是否满足"正常完成"语义）
  let completedNormally = false

  while (options.maxTurns === undefined || turn < options.maxTurns) {
    turn++

    // ── task14：增量持久化 ──────────────────────────────────────────────────
    // 在每轮 runTurn 之前先把新消息写入 JSONL 文件。
    // 这样即使程序崩溃，已处理的消息也不会丢失（crash-safe）。
    // flushPendingMessages 是幂等的，第二次调用只追加新增部分。
    try {
      flushPendingMessages(state, options.modelId, cwd)
    } catch {
      // 持久化失败不阻断 agent loop（如：磁盘满、权限不足）
    }

    // ── task14：context 压缩 ───────────────────────────────────────────────
    // 当上一轮的 inputTokens 超过阈值时，触发 LLM 摘要压缩。
    // 首轮（lastInputTokens === 0）不会触发（getCompressionThreshold 通常 > 0）。
    if (state.lastInputTokens > 0) {
      await checkAndCompressContext(
        state,
        model,
        options.modelId,
        callbacks.onContextCompressed,
        cwd,
      )
    }

    const outcome = await runTurn(state, model, options, systemPrompt, callbacks, effectiveTools)

    if (outcome.kind === 'error') break
    if (outcome.kind === 'aborted') break

    if (outcome.finishReason === 'tool-calls') {
      // 有工具调用轮次 → 重置续写计数器（模型在取得进展，不是卡住了）
      continuationAttempts = 0
      let toolCalls: Awaited<StreamResult['toolCalls']>
      try {
        toolCalls = await outcome.result.toolCalls
      } catch (err) {
        if (isAbortError(err, options.abortSignal)) break
        callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        break
      }
      await processToolCalls(toolCalls, state, options, callbacks, effectiveTools)
      // processToolCalls 在中断时会合成 tool_result，但接下来的 streamText 会立刻
      // 以已中断的 signal 拒绝——直接 break 省掉这次无意义的请求。
      if (options.abortSignal?.aborted) break
      continue
    }

    if (outcome.finishReason === 'length') {
      if (continuationAttempts < MAX_CONTINUATIONS) {
        continuationAttempts++
        // 续写提示进 state.messages 但不进 UI，用户看到的是连续的流式回答。
        state.messages.push({
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
        })
        continue
      }
      callbacks.onError(
        new Error(
          `Response still truncated after ${MAX_CONTINUATIONS} continuation attempts — ask a narrower question.`,
        ),
      )
      break
    }

    if (outcome.finishReason === 'stop') {
      completedNormally = true
      // ── task14：写 usage 快照 ───────────────────────────────────────────
      // 正常完成时追加 usage 记录，便于后续统计和会话恢复时显示历史消耗。
      try {
        appendUsage(state, cwd)
      } catch {
        // 写 usage 失败不影响主流程
      }
    }

    if (outcome.finishReason === 'content-filter') {
      callbacks.onError(new Error('Response stopped by the provider content filter.'))
    }

    break
  }

  // 超出 maxTurns（且非正常 stop）时报错
  if (options.maxTurns !== undefined && turn >= options.maxTurns && !completedNormally) {
    callbacks.onError(new Error(`Reached maximum turns (${options.maxTurns}). Stopping agent loop.`))
  }

  return { state, turnCount: turn }
}

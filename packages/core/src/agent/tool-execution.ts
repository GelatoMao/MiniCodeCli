// @mini-code-cli/core — 工具执行与调度
//
// 负责处理 agentLoop 收到 finishReason === 'tool-calls' 后的全部逻辑：
//   1. 区分"自动执行工具"（readFile/glob/grep/listDir）和"手动分发工具"（writeFile/edit/shell/task）
//   2. 对手动工具依次执行：Loop Guard → 权限检查 → 实际执行 → 推送结果
//   3. 把工具结果消息写入 state.messages，让下一轮 streamText 能看到结果
//
// task15 新增：
//   - handleTaskTool：task 工具处理器，委托给 runSubAgent 执行子 agentLoop
//   - processToolCalls 新增参数 effectiveTools，传给 handleTaskTool 进行工具白名单过滤
//   - task 工具被放入 BYPASS_LOOP_GUARD_HANDLERS（绕过循环守卫，有独立的并行批处理）
//
// 主要导出：
//   processToolCalls  — 处理单轮模型输出的所有工具调用
//   partitionToolCalls — 将 task 工具的连续调用分批（并行执行）
import fs from 'node:fs/promises'
import path from 'node:path'

import type { ModelMessage } from 'ai'

import { checkPermission } from '../permissions/index.js'
import { truncateToolResult } from '../tools/index.js'
import { clearProgressReporter, reportProgress } from '../tools/progress.js'
import { getShellProvider } from '../tools/shell-provider.js'
import type { AgentCallbacks, AgentOptions } from '../types/index.js'
import { checkForLoop, recordToolCall } from './loop-guard.js'
import type { LoopState } from './loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from './messages.js'
// (SubAgentRegistry type is used implicitly via dynamic imports in handleTaskTool)

// ── isAbortError ──────────────────────────────────────────────────────────────

/** 判断一个错误是否来自用户中断（AbortController.abort()）。
 *
 *  与 loop.ts 中的相同逻辑保持独立（不共享）——独立 6 行比增加跨模块依赖更合理。*/
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true
  }
  return false
}

// ── countOccurrences ─────────────────────────────────────────────────────────

/** 不产生中间数组地计算子字符串出现次数。*/
function countOccurrences(content: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

// ── executeWriteTool ─────────────────────────────────────────────────────────

/** 执行 writeFile 或 edit 工具。
 *
 *  返回展示给模型的结果字符串（成功消息或 "Error: ..." 格式的错误）。
 *  失败用 toolErrorString 格式封装，而不是 throw，让调用方能统一判断
 *  isToolErrorString 来翻转 UI 颜色。*/
async function executeWriteTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (toolName === 'writeFile') {
    const filePath = input.filePath as string
    const content = input.content as string
    reportProgress(toolCallId, `Writing ${filePath}`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, { encoding: 'utf-8', signal })
    const parts = content.split('\n')
    const lineCount = content.endsWith('\n') ? parts.length - 1 : parts.length
    return `File written: ${filePath} (${lineCount} lines)`
  }

  if (toolName === 'edit') {
    const filePath = input.filePath as string
    const oldString = input.oldString as string
    const newString = input.newString as string
    const replaceAll = (input.replaceAll as boolean) ?? false

    reportProgress(toolCallId, `Editing ${filePath}`)
    const content = await fs.readFile(filePath, { encoding: 'utf-8', signal })
    if (!replaceAll) {
      const count = countOccurrences(content, oldString)
      if (count === 0) return toolErrorString(`old_string not found in ${filePath}`)
      if (count > 1) {
        return toolErrorString(
          `old_string is not unique in ${filePath} (found ${count} occurrences). Provide more context or set replaceAll: true.`,
        )
      }
    }
    const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString)
    await fs.writeFile(filePath, newContent, { encoding: 'utf-8', signal })
    return `File edited: ${filePath}`
  }

  return toolErrorString('unknown write tool')
}

// ── executeShell ─────────────────────────────────────────────────────────────

/** 执行 shell 命令，带流式 stdout/stderr 输出和进度节流。
 *
 *  节流逻辑（50ms）：PowerShell 的 Format-Table 等命令会在 ~1ms 内发出大量行，
 *  每行触发一次 setState → ChatInput 重绘链路代价高。节流到 20fps 既能感知
 *  实时进度，又大幅减少帧对帧抖动。模型仍能看到完整输出；节流只影响实时进度显示。*/
async function executeShell(
  command: string,
  timeout: number,
  signal: AbortSignal | undefined,
  callbacks: AgentCallbacks,
  toolCallId: string,
): Promise<{ output: string; isError: boolean }> {
  const proc = getShellProvider().spawn(command, { timeout, signal })

  reportProgress(toolCallId, 'Running command...')

  let lastProgressTime = 0
  const PROGRESS_THROTTLE_MS = 50

  const onChunk = (chunk: Buffer) => {
    const s = chunk.toString()
    callbacks.onShellOutput(s)
    const now = Date.now()
    if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return
    // 取该批次最后一行非空内容作为进度消息。
    // 长时间运行的命令（tsc、测试套件）会流式输出大量行；
    // 显示最新一行是"当前在做什么"的自然信号。
    const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last) {
      lastProgressTime = now
      const trimmed = last.length > 120 ? last.slice(0, 117) + '...' : last
      reportProgress(toolCallId, trimmed)
    }
  }

  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)

  const result = await proc
  const toStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  const stdout = toStr(result.stdout)
  const stderr = toStr(result.stderr)

  // 当 execa 因超出 maxBuffer 而终止子进程时，仍然有部分输出。
  // 输出截断提示，避免模型静默丢失上下文。
  const isMaxBuffer = result.isMaxBuffer ?? false
  let combinedStdout = stdout
  let combinedStderr = stderr
  if (isMaxBuffer) {
    const INLINE_CAP = 30_000
    if (combinedStdout.length > INLINE_CAP)
      combinedStdout = combinedStdout.slice(0, INLINE_CAP) + '\n... [stdout truncated — exceeded buffer limit]'
    if (combinedStderr.length > INLINE_CAP)
      combinedStderr = combinedStderr.slice(0, INLINE_CAP) + '\n... [stderr truncated — exceeded buffer limit]'
  }

  const output = [combinedStdout, combinedStderr].filter(Boolean).join('\n').trim()
  if (result.exitCode !== 0 || isMaxBuffer) {
    const suffix = isMaxBuffer ? ' (output exceeded buffer limit)' : ''
    const text = output ? `${output}\nExit code ${result.exitCode}${suffix}` : `Exit code ${result.exitCode}${suffix}`
    return { output: text, isError: true }
  }
  return { output: output || 'Done', isError: false }
}

// ── pushToolResult ────────────────────────────────────────────────────────────

/** 将工具结果推入 state.messages 并通知 UI。
 *
 *  手动分发工具的统一出口——每次工具执行结束（成功或失败）都通过这里。
 *  清理 progress reporter 防止内存泄漏。*/
function pushToolResult(
  state: LoopState,
  callbacks: AgentCallbacks,
  toolCallId: string,
  toolName: string,
  output: string,
  isError = false,
): void {
  state.messages.push(toolResultMessage(toolCallId, toolName, output))
  // 清理手动分发工具的 progress reporter。
  // auto-execute 工具在 stream 的 tool-result 事件中清理，这里是 no-op。
  clearProgressReporter(toolCallId)
  callbacks.onToolResult(toolCallId, output, isError)
}

// ── ToolCall / HandlerCtx ─────────────────────────────────────────────────────

type ToolCall = { toolName: string; toolCallId: string; input: Record<string, unknown> }

/** 传给每个工具处理器的上下文——省去每处都重复列 5 个位置参数。*/
interface HandlerCtx {
  toolName: string
  input: Record<string, unknown>
  toolCallId: string
  state: LoopState
  options: AgentOptions
  callbacks: AgentCallbacks
  /** task15 新增：当前 session 的完整工具集（用于 task 工具的白名单过滤）*/
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any>
}

// ── handleAskUser ─────────────────────────────────────────────────────────────

/** askUser 工具处理器。
 *
 *  刻意绕过循环守卫：模型两次提出相同问题通常是故意的（比如用户答案模糊）；
 *  如果守卫拦截它，会悄无声息地破坏 UX。*/
async function handleAskUser(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, callbacks } = ctx
  const question = input.question as string
  const optionsList = input.options as { label: string; description: string }[]
  const answer = await callbacks.onAskUser(question, optionsList)
  pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
}

// ── handleTaskTool ─────────────────────────────────────────────────────────────

/** task 工具处理器（task15 新增）。
 *
 *  将子任务委托给独立的 sub-agent 运行。
 *
 *  绕过循环守卫的理由：
 *    - task 工具的每次调用通常对应不同的子任务（不同 prompt），
 *      但 hash 可能相同（例如"探索目录"类的通用任务）。
 *    - 循环守卫会误杀合法的并行 task 调用。
 *    - task 工具有自己的安全边界（sub-agent 不能再调用 task），
 *      递归问题不需要循环守卫来处理。
 *
 *  绕过权限检查的理由：
 *    - task 工具本身是只读操作（委托调用）；实际的写操作在子 agentLoop 内部
 *      单独经过权限检查，不需要在父 agent 重复。
 */
async function handleTaskTool(ctx: HandlerCtx): Promise<void> {
  const { input, toolCallId, toolName, state, options, callbacks, effectiveTools } = ctx

  const subagentName = input.subagent as string
  const prompt = input.prompt as string

  // 动态 import 避免循环依赖（runner.ts → loop.ts → tool-execution.ts → runner.ts）
  const { runSubAgent } = await import('./sub-agents/runner.js')
  const { createSubAgentRegistry } = await import('./sub-agents/registry.js')

  // 从注册表中查找 sub-agent 定义
  const registry = await createSubAgentRegistry()
  const def = registry.get(subagentName)

  if (!def) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      `Error: Unknown sub-agent "${subagentName}". Available: ${registry.list().map((a) => a.name).join(', ')}`,
      true,
    )
    return
  }

  // 通知 UI：task 工具正在执行（显示 sub-agent 名称）
  reportProgress(toolCallId, `Running ${subagentName} sub-agent...`)

  let result: Awaited<ReturnType<typeof runSubAgent>>
  try {
    result = await runSubAgent(
      def,
      prompt,
      // model 不在 ctx 里，通过 options 的 modelRegistry 获取
      // 注意：这里需要从外部传入 model，因为 HandlerCtx 没有 model 字段
      // 临时方案：通过 options 里的 modelRegistry 重建
      options.modelRegistry!.languageModel(options.modelId),
      options,
      callbacks,
      state,
      effectiveTools,
    )
  } catch (err) {
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      `Error: Sub-agent "${subagentName}" failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    )
    return
  }

  pushToolResult(
    state,
    callbacks,
    toolCallId,
    toolName,
    result.output,
    false,
  )
}

// ── BYPASS_LOOP_GUARD_HANDLERS ────────────────────────────────────────────────

type ToolHandler = (ctx: HandlerCtx) => Promise<void>

/** 绕过循环守卫和 writeFile/edit/shell 权限+执行管道的特殊工具。
 *  每个处理器负责自己调用 pushToolResult。
 *  task6 只有 askUser；task15 新增 task。*/
const BYPASS_LOOP_GUARD_HANDLERS: Record<string, ToolHandler> = {
  askUser: handleAskUser,
  task: handleTaskTool,
}

// ── applyLoopGuard ────────────────────────────────────────────────────────────

/** 对非 bypass 工具运行循环守卫。如果工具被拦截则返回 true（调用方应停止分发）。
 *
 *  auto-execute 工具不会到达这里——processToolCalls 的预扫描已经跳过它们，
 *  因为它们的结果已经在 SDK 的 response.messages 里了。
 *
 *  `deferred` 收集必须在本轮所有工具结果之后才能追加的消息——
 *  在中间推 user 消息会产生 assistant→tool A→user→tool B 这种模式，
 *  DeepSeek 的严格排序校验会 400 拒绝。*/
async function applyLoopGuard(ctx: HandlerCtx, deferred: ModelMessage[]): Promise<boolean> {
  const { toolName, input, toolCallId, state, callbacks } = ctx
  const loopCheck = checkForLoop(state, toolName, input, toolCallId)

  if (loopCheck.kind === 'ok') {
    recordToolCall(state, toolName, input, loopCheck.hash)
    return false
  }

  recordToolCall(state, toolName, input, loopCheck.hash)
  const guardMessage = `[loop-guard] ${loopCheck.message}`
  // 合成结果，工具体不运行，无副作用，不弹权限框。
  pushToolResult(state, callbacks, toolCallId, toolName, guardMessage, true)

  if (loopCheck.kind === 'hard-block') {
    const answer = await callbacks
      .onAskUser(`模型在反复以相同参数调用 ${toolName}，请选择如何处理：`, [
        { label: 'Pause', description: '暂停本轮——你可以输入新的指令。' },
        { label: 'Continue', description: '让模型继续尝试；循环守卫保持激活。' },
      ])
      .catch(() => 'Pause')
    if (answer.toLowerCase().startsWith('pause')) {
      // 清除最近调用窗口，避免守卫在用户引导后的下一轮立即再次触发。
      state.recentToolCalls = []
      // 推迟到本次迭代结束后，确保 user 消息落在所有工具结果之后。
      deferred.push({
        role: 'user',
        content: '[loop-guard] 用户已暂停循环。请等待用户的进一步指令，不要继续调用工具。',
      })
    }
  }
  return true
}

// ── checkWriteOrShellPermission ───────────────────────────────────────────────

/** 对 writeFile/edit/shell 运行权限检查。
 *  返回 true 表示可以继续执行，false 表示已被拒绝/中止。*/
async function checkWriteOrShellPermission(ctx: HandlerCtx): Promise<boolean> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  if (toolName !== 'writeFile' && toolName !== 'edit' && toolName !== 'shell') return true

  const approved = await checkPermission(
    { toolCallId, toolName, input },
    options.trustMode,
    callbacks.onAskPermission,
    state.permissionMode,
    process.cwd(),
  )
  if (options.abortSignal?.aborted) {
    pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
    return false
  }
  if (!approved) {
    pushToolResult(state, callbacks, toolCallId, toolName, 'Permission denied by user.')
    return false
  }
  return true
}

// ── executeWriteOrShell ───────────────────────────────────────────────────────

/** 实际运行 writeFile/edit/shell 工具体。
 *  auto-execute 工具（readFile/glob/grep 等）不会到达这里，返回 null。*/
async function executeWriteOrShell(ctx: HandlerCtx): Promise<{ output: string; isError: boolean } | null> {
  const { toolName, input, toolCallId, state, options, callbacks } = ctx
  try {
    if (toolName === 'writeFile' || toolName === 'edit') {
      const output = await executeWriteTool(toolName, input, toolCallId, options.abortSignal)
      // executeWriteTool 对 in-band 失败（未找到匹配、匹配不唯一）返回 "Error: ..." 字符串而非 throw
      const isError = isToolErrorString(output)
      if (!isError) state.filesModified.add(input.filePath as string)
      return { output, isError }
    }
    if (toolName === 'shell') {
      const timeout = (input.timeout as number) ?? 30000
      const shellResult = await executeShell(
        input.command as string,
        timeout,
        options.abortSignal,
        callbacks,
        toolCallId,
      )
      return { output: shellResult.output, isError: shellResult.isError }
    }
    // 有 execute 的工具（readFile/glob/grep 等）由 AI SDK 自动执行，返回 null
    return null
  } catch (err) {
    return { output: toolErrorFromUnknown(err), isError: true }
  }
}

// ── handleToolCall ────────────────────────────────────────────────────────────

/** 处理单次工具调用。返回时该调用已完全分发完毕。
 *
 *  `deferred` 是本轮的延迟消息队列，由 processToolCalls 在全部工具结果推入后统一 flush。*/
async function handleToolCall(
  tc: ToolCall,
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  deferred: ModelMessage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any>,
): Promise<void> {
  const ctx: HandlerCtx = {
    toolName: tc.toolName,
    input: tc.input,
    toolCallId: tc.toolCallId,
    state,
    options,
    callbacks,
    effectiveTools,
  }

  // 先尝试 bypass 路由（askUser 等特殊工具绕过循环守卫）
  const bypassHandler = BYPASS_LOOP_GUARD_HANDLERS[ctx.toolName]
  if (bypassHandler) {
    await bypassHandler(ctx)
    return
  }

  // 循环守卫
  if (await applyLoopGuard(ctx, deferred)) return
  // 权限检查
  if (!(await checkWriteOrShellPermission(ctx))) return

  // 执行工具体
  const result = await executeWriteOrShell(ctx)
  if (result == null) return // auto-execute 工具，SDK 已处理

  pushToolResult(state, callbacks, ctx.toolCallId, ctx.toolName, truncateToolResult(result.output), result.isError)
}

// ── collectActiveAssistantToolCallIds ─────────────────────────────────────────

/** 收集本轮 assistant 消息中实际提交的所有 toolCallId。
 *
 *  为什么需要这个？
 *  SDK 在 zod 校验失败时会发出 tool-error chunk 并将该 tool_call 排除在
 *  response.messages 之外，但 result.toolCalls promise 里可能还包含它（"幽灵调用"）。
 *  对幽灵调用执行工具体会产生两个坏结果：
 *    1. writeFile/edit/shell 会触发真实的副作用，但模型并未正式提交该调用。
 *    2. 推入的 tool_result 是孤立的（没有对应的 assistant tool_call），
 *       下次 API 请求会以 "tool must be a response..." 400 拒绝。
 *
 *  从 messages 末尾向前扫，遇到 user 消息就停止——覆盖多 assistant 轮结构，
 *  同时不让旧轮的 id 渗进来。*/
function collectActiveAssistantToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

// ── collectFulfilledToolCallIds ───────────────────────────────────────────────

/** 收集当前轮中已有 tool-result 消息的 toolCallId（auto-execute 工具的结果已经在里面）。
 *
 *  auto-execute 工具（readFile/glob/grep/listDir）的结果由 SDK 通过 response.messages
 *  注入 state.messages，在 collectTurnResponse 后 processToolCalls 运行之前已就位。
 *  对这些 id 重新执行工具体会产生重复副作用或重复 tool-result（破坏消息排序）。*/
function collectFulfilledToolCallIds(state: LoopState): Set<string> {
  const ids = new Set<string>()
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        ids.add(part.toolCallId)
      }
    }
  }
  return ids
}

// ── partitionToolCalls ────────────────────────────────────────────────────────

/** 将工具调用列表分批：连续的 task 工具调用合为一批（可并行），其他都是单元素批次。
 *
 *  task6 无 task 工具，但保留结构方便 task15 扩展时直接可用。
 *  目前所有工具都是单元素批次，效果等同于逐个串行执行。*/
export function partitionToolCalls(calls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = []
  let i = 0
  while (i < calls.length) {
    let end = i + 1
    if (calls[i]!.toolName === 'task') {
      while (end < calls.length && calls[end]!.toolName === 'task') {
        end++
      }
    }
    batches.push(calls.slice(i, end))
    i = end
  }
  return batches
}

// ── processToolCalls ──────────────────────────────────────────────────────────

/** 处理单轮模型输出的全部工具调用。
 *
 *  连续的 task 工具调用并行分发（Promise.all），其他工具串行执行。
 *  详细原因见 partitionToolCalls 注释。*/
export async function processToolCalls(
  toolCalls: ToolCall[],
  state: LoopState,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectiveTools: Record<string, any> = {},
): Promise<void> {
  const activeIds = collectActiveAssistantToolCallIds(state)
  const fulfilledIds = collectFulfilledToolCallIds(state)
  // 本轮延迟消息队列——在所有工具结果推入后才 flush，避免中间插入 user 消息破坏排序。
  const deferred: ModelMessage[] = []

  // 预扫描：剔除幽灵调用和已完成调用，剩余放入 liveCalls。
  const liveCalls: ToolCall[] = []
  for (const tc of toolCalls) {
    // 跳过幽灵调用（SDK 校验拒绝的调用不在 assistant 消息里）
    if (activeIds.size > 0 && !activeIds.has(tc.toolCallId)) {
      continue
    }

    // 跳过已完成调用（auto-execute 工具的结果已在 state.messages 里）
    // 但仍然记录到循环守卫窗口，以便对重复的 auto-execute 调用也能触发守卫。
    if (fulfilledIds.has(tc.toolCallId)) {
      const loopCheck = checkForLoop(state, tc.toolName, tc.input, tc.toolCallId)
      recordToolCall(state, tc.toolName, tc.input, loopCheck.hash)
      if (loopCheck.kind !== 'ok') {
        deferred.push({ role: 'user', content: `[loop-guard] ${loopCheck.message}` })
      }
      continue
    }

    liveCalls.push(tc)
  }

  // 按批次分发。单元素批次的 Promise.all 行为与普通 await 等价。
  const batches = partitionToolCalls(liveCalls)
  let dispatched = 0
  for (const batch of batches) {
    // 用户按下 Esc / Ctrl+C。为剩余每个工具调用推入合成的 tool-result，
    // 避免孤立 tool_call 导致下一次 API 请求 400。
    if (options.abortSignal?.aborted) {
      for (let j = dispatched; j < liveCalls.length; j++) {
        pushToolResult(
          state,
          callbacks,
          liveCalls[j]!.toolCallId,
          liveCalls[j]!.toolName,
          '[Tool execution interrupted by user]',
          true,
        )
      }
      break
    }

    await Promise.all(batch.map((tc) => handleToolCall(tc, state, options, callbacks, deferred, effectiveTools)))
    dispatched += batch.length
  }

  // 将延迟消息追加到 state.messages 末尾。
  // 它们在所有 tool_result 之后，不会破坏 assistant→tool 排序。
  if (deferred.length > 0) state.messages.push(...deferred)
}

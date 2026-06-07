// @mini-code-cli/core — Sub-Agent 运行器
//
// runSubAgent() 用独立的 LoopState 运行一个子 agentLoop，实现上下文隔离：
//
// 核心设计原则：
//   1. 独立 LoopState：sub-agent 有自己的消息历史，与父 agent 完全隔离。
//      这避免了子任务的中间过程污染父 agent 的上下文窗口。
//
//   2. 工具白名单过滤：根据 SubAgentDef.allowedTools 过滤父 agent 的工具集。
//      如果 allowedTools 为空，继承父 agent 的所有工具（task 工具强制剔除）。
//
//   3. 禁止递归 task 工具：从传入的 parentTools 中剔除 'task'，
//      防止 sub-agent 再次调用 task 工具（无限嵌套）。
//
//   4. token 汇聚：sub-agent 产生的 token 用量累计到 parentState，
//      保证用户看到的总用量准确反映实际 API 调用成本。
//
//   5. 回调中转：子 agent 的 onTextDelta / onToolCall 等回调转发给父回调，
//      UI 仍能展示 sub-agent 的执行过程。
//
// 工具注入机制：
//   runSubAgent 将过滤好的子工具集通过 agentLoop 的 toolsOverride 参数传入，
//   buildTools() 检测到 toolsOverride 时直接返回它，而不是重新构建完整工具集。
//   这样 sub-agent 不会意外获得 task 工具（即使 buildTools 重新构建也不行）。
//
// 调用链：
//   task 工具（createTaskTool）
//     └─ handleTaskTool（tool-execution.ts 中的 BYPASS 处理器）
//           └─ runSubAgent（这里）
//                 └─ agentLoop（toolsOverride 过滤了 task 工具）
import type { LanguageModel } from 'ai'

import type { AgentCallbacks, AgentOptions, TokenUsage } from '../../types/index.js'
import { agentLoop } from '../loop.js'
import { createLoopState } from '../loop-state.js'
import type { LoopState } from '../loop-state.js'
import type { SubAgentDef } from './types.js'

// ── filterTools ──────────────────────────────────────────────────────────────

/**
 * 根据工具白名单过滤工具集，并强制移除 'task' 工具防止递归。
 *
 * @param parentTools   父 agent 的完整工具集
 * @param allowedTools  白名单（空数组表示继承所有非 task 工具）
 */
function filterTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentTools: Record<string, any>,
  allowedTools: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered: Record<string, any> = {}

  const names = allowedTools.length > 0
    ? allowedTools
    : Object.keys(parentTools)

  for (const name of names) {
    // 强制剔除 task 工具，防止无限递归
    if (name === 'task') continue
    if (parentTools[name] !== undefined) {
      filtered[name] = parentTools[name]
    }
  }
  return filtered
}

// ── addTokenUsage ─────────────────────────────────────────────────────────────

/** 将 delta 的 token 用量累加到 target 上。*/
function addTokenUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.totalTokens += delta.totalTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheCreationTokens += delta.cacheCreationTokens
  // currentContextTokens 不累加，始终反映最后一轮的窗口使用量
  target.currentContextTokens = delta.currentContextTokens
}

// ── SubAgentResult ────────────────────────────────────────────────────────────

/** runSubAgent 的返回值。*/
export interface SubAgentResult {
  /** Sub-agent 执行完毕时所有 onTextDelta 合并的完整文本输出。*/
  output: string
  /** Sub-agent 消耗的 token 用量（不含父 agent 用量）。*/
  tokenUsage: TokenUsage
}

// ── runSubAgent ───────────────────────────────────────────────────────────────

/**
 * 用独立 LoopState 运行 sub-agent，返回输出文本和 token 用量。
 *
 * @param def          Sub-agent 定义（工具白名单、系统提示等）
 * @param prompt       父 agent 发给 sub-agent 的任务描述
 * @param model        复用父 agent 的 LanguageModel 实例
 * @param parentOptions 父 agent 的选项（继承 abortSignal、trustMode 等）
 * @param parentCallbacks 父 agent 的回调（sub-agent 事件转发给父 UI）
 * @param parentState  父 agent 的 LoopState（用于 token 汇聚）
 * @param parentTools  父 agent 的完整工具集（按白名单过滤后传给 sub-agent）
 * @param cwd          当前工作目录（传给 session-store）
 */
export async function runSubAgent(
  def: SubAgentDef,
  prompt: string,
  model: LanguageModel,
  parentOptions: AgentOptions,
  parentCallbacks: AgentCallbacks,
  parentState: LoopState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentTools: Record<string, any>,
  cwd?: string,
): Promise<SubAgentResult> {
  // 创建独立 LoopState，与父 agent 完全隔离
  const subState = createLoopState(parentOptions.permissionMode ?? 'default')

  // 汇集 sub-agent 的文本输出（delta → 拼接）
  let textBuffer = ''

  // 按白名单过滤工具（task 工具被强制排除）
  const subTools = filterTools(parentTools, def.allowedTools)

  // ── 构建 sub-agent 的 AgentOptions ─────────────────────────────────────────
  // 继承父 agent 的关键选项，但：
  //   - systemPromptExtra 改为 sub-agent 的专属系统提示
  //   - 限制 maxTurns 防止失控（默认 30 轮）
  const subOptions: AgentOptions = {
    ...parentOptions,
    systemPromptExtra: def.systemPrompt,
    maxTurns: Math.min(parentOptions.maxTurns ?? 30, 30),
  }

  // ── 构建 sub-agent 的 AgentCallbacks ───────────────────────────────────────
  // 大部分回调直接转发给父 agent 的 callbacks，让 UI 能展示 sub-agent 进度。
  // 特殊处理 onTextDelta：同时累积到本地 buffer（用于构建返回值）。
  const subCallbacks: AgentCallbacks = {
    onTextDelta: (text) => {
      textBuffer += text
      parentCallbacks.onTextDelta(text)
    },
    onToolCall: parentCallbacks.onToolCall,
    onToolProgress: parentCallbacks.onToolProgress,
    onToolResult: parentCallbacks.onToolResult,
    onAskPermission: parentCallbacks.onAskPermission,
    onAskUser: parentCallbacks.onAskUser,
    onShellOutput: parentCallbacks.onShellOutput,
    onUsageUpdate: (usage) => {
      // 转发给父 UI，但不修改父 state（汇聚在 runSubAgent 返回后处理）
      parentCallbacks.onUsageUpdate(usage)
    },
    onError: parentCallbacks.onError,
    onContextCompressed: parentCallbacks.onContextCompressed,
  }

  // ── 运行 sub-agent ──────────────────────────────────────────────────────────
  // 通过 toolsOverride 参数直接传入过滤后的工具集，
  // loop.ts 的 buildTools 检测到该参数时直接返回，不重建（含 task 工具的）完整工具集。
  const result = await agentLoop(
    prompt,
    model,
    subOptions,
    subCallbacks,
    subState,
    cwd,
    subTools, // toolsOverride：过滤后的子工具集，不含 task 工具
  )

  // ── token 汇聚 ──────────────────────────────────────────────────────────────
  // 将 sub-agent 的 token 用量加到 parentState 上，保证总用量统计正确
  addTokenUsage(parentState.tokenUsage, result.state.tokenUsage)
  // 同步最后的 lastInputTokens（用于压缩触发判断）
  parentState.lastInputTokens = result.state.lastInputTokens

  return {
    output: textBuffer || '[Sub-agent completed with no text output]',
    tokenUsage: result.state.tokenUsage,
  }
}

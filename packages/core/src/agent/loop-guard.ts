// @mini-code-cli/core — 死循环断路器（Doom-loop circuit breaker）
//
// 检测模型是否在用相同参数反复调用同一工具——通常是因为上一次调用失败了，
// 而模型的"最优解"还是用同样的方式重试。在 Windows 环境中这个问题最常见于
// shell 命令因引号问题失败后模型不做任何修改直接重试 5~10 次，
// 每次失败都把完整堆栈追加到上下文。
//
// 两阶段机制：
//   Stage 1（软警告，默认阈值 3）：注入一条合成的 tool-result，告诉模型
//     "这个完全相同的调用已经失败了 3 次，停下来换个思路"。
//     模型通常在下一轮看到这条合成结果后会调整策略。
//   Stage 2（硬中断，默认阈值 5）：中止本轮并提示用户——
//     软警告后还有 5 次相同调用说明提示已经没有帮助，
//     继续追加上下文无益。
//
// 检测方式：对 `{toolName, stableInputJson}` 计算 SHA256。
// stable stringify 对对象键排序，使 `{a:1,b:2}` 和 `{b:2,a:1}` 产生相同哈希。
//
// 调优注意：我们不使用"连续完全相同的 3 次"谓词——
// 那会漏掉模型先调 `foo`，然后读了文件，再调 `foo` 的情形。
// 我们改为查看最近 N 次同名工具调用，检查是否有 K 次共享同一哈希。
import crypto from 'node:crypto'

import type { LoopState } from './loop-state.js'
import { toolResultMessage } from './messages.js'

/** 触发软警告提示的最小重复次数。*/
export const SOFT_LOOP_THRESHOLD = 3

/** 触发硬中断提示用户的最小重复次数。*/
export const HARD_LOOP_THRESHOLD = 5

/** 扫描重复时检查的滑动窗口大小。*/
export const LOOP_WINDOW_SIZE = 8

// ── stableStringify ──────────────────────────────────────────────────────────

/** 对对象键排序的稳定 JSON 序列化。
 *  相同语义的输入无论键序如何都会产生相同的字符串，
 *  从而使哈希值具有稳定性。*/
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}

// ── hashToolCall ─────────────────────────────────────────────────────────────

/** 对工具调用计算用于重复检测的哈希值。
 *  截断为 16 个十六进制字符——
 *  在 8 条目窗口中，该长度的碰撞概率可以忽略不计。*/
export function hashToolCall(toolName: string, input: unknown): string {
  const payload = toolName + '\x00' + stableStringify(input)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

// ── LoopCheck ─────────────────────────────────────────────────────────────────

/** 携带预计算哈希的公共头部，避免调用方重复哈希。*/
interface LoopCheckBase {
  hash: string
}

export type LoopCheck =
  /** 未检测到循环 — 正常分发此工具调用。*/
  | (LoopCheckBase & { kind: 'ok' })
  /** 在软阈值检测到循环 — 注入一条合成 tool-result 告诉模型停止，
   *  并跳过本轮实际执行该工具。
   *  `toolCallId` 是当前调用的 id，以便合成结果能对应到它。*/
  | (LoopCheckBase & { kind: 'soft-block'; toolCallId: string; message: string })
  /** 在硬阈值检测到循环 — 中止本轮并提示用户。*/
  | (LoopCheckBase & { kind: 'hard-block'; toolName: string; message: string })

// ── checkForLoop ─────────────────────────────────────────────────────────────

/**
 * 检查传入的工具调用是否是窗口中最近调用的重复，并报告调用方应该怎么做。
 * 不改变 state —— 调用方在决定执行后通过 {@link recordToolCall} 提交哈希。
 * 返回的 `hash` 应传给 `recordToolCall` 以避免对同一输入二次计算 SHA256。
 *
 * 只计算同时满足"相同哈希"且"相同 toolName"的匹配；
 * 不同工具的具有相同参数的调用不触发守卫。
 */
export function checkForLoop(state: LoopState, toolName: string, input: unknown, toolCallId: string): LoopCheck {
  const hash = hashToolCall(toolName, input)
  const window = state.recentToolCalls.slice(-LOOP_WINDOW_SIZE)

  let priorMatches = 0
  for (const entry of window) {
    if (entry.toolName === toolName && entry.hash === hash) priorMatches++
  }

  // 当前传入的调用是第 priorMatches+1 次，所以阈值比较是 priorMatches + 1 >= threshold

  if (priorMatches + 1 >= HARD_LOOP_THRESHOLD) {
    return {
      kind: 'hard-block',
      hash,
      toolName,
      message: `工具 ${toolName} 以相同参数被调用了 ${priorMatches + 1} 次。模型陷入循环，中止本轮。`,
    }
  }

  if (priorMatches + 1 >= SOFT_LOOP_THRESHOLD) {
    return {
      kind: 'soft-block',
      hash,
      toolCallId,
      message:
        `这个完全相同的 ${toolName} 调用（参数一致）本会话内已经尝试了 ${priorMatches + 1} 次，结果相同。` +
        '不要再重试。改变思路——有意义地修改参数、换用其他工具，或者询问用户该怎么做。',
    }
  }

  return { kind: 'ok', hash }
}

// ── recordToolCall ────────────────────────────────────────────────────────────

/** 把工具调用提交到滑动窗口中。
 *  限制数组大小，防止长时间运行的 agent 无限增长。
 *  传入 {@link checkForLoop} 返回的 `hash` 以避免重新计算；
 *  仅在走了其他路径时才省略（会触发重新哈希）。*/
export function recordToolCall(state: LoopState, toolName: string, input: unknown, hash?: string): void {
  const h = hash ?? hashToolCall(toolName, input)
  state.recentToolCalls.push({ toolName, hash: h })
  // 保留 2 倍窗口大小——让 checkForLoop 在活跃对比窗口之外也有一些历史，
  // 方便在不改变持久化占用量的情况下调整 LOOP_WINDOW_SIZE。
  const cap = LOOP_WINDOW_SIZE * 2
  if (state.recentToolCalls.length > cap) {
    state.recentToolCalls.splice(0, state.recentToolCalls.length - cap)
  }
}

// ── syntheticLoopBlockResult ──────────────────────────────────────────────────

/** 构建一条合成 tool-result 消息，告诉模型此次调用被循环守卫拦截。
 *  模型把它当作工具的真实返回值来处理，通常在下一轮会调整策略。*/
export function syntheticLoopBlockResult(toolName: string, toolCallId: string, message: string) {
  return toolResultMessage(toolCallId, toolName, `[loop-guard] ${message}`)
}

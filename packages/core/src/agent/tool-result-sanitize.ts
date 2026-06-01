// @mini-code-cli/core — 工具结果消息修复与截断
//
// 本模块负责两件事：
//
// 1. repairOrphanToolCalls（孤立调用修复）
//    AI SDK auto-execute 工具的结果通过 response.messages 进入 state.messages，
//    绕过手动路径。某些情况下（模型输出 malformed tool input → SDK 校验拒绝）
//    会出现"孤立"：
//      - 正向孤立（tool_call 没有对应 tool_result）：产生错误 422
//      - 反向孤立（tool_result 没有前驱 tool_call）：产生错误 422
//    本函数双向修复，保证每次 API 请求的消息历史合法。
//
// 2. truncateToolResultsInMessages（结果截断）
//    auto-execute 工具（readFile/grep/glob/listDir 等）的结果通过 response.messages
//    全量进入 state.messages，不经过手动路径的 truncateToolResult 过滤。
//    本函数在结果落入 state 之后补做截断，避免超长文件或大型 grep 输出
//    在每轮请求中持续占用 context window。
import type { ModelMessage } from 'ai'

import { truncateToolResult } from '../tools/truncate.js'
import type { TruncateOptions } from '../tools/truncate.js'

// ── 每工具截断策略 ────────────────────────────────────────────────────────────

/** 各工具的默认截断策略。
 *
 *  head-tail：保留文件开头和结尾，适合有意义的前后缀（如文件声明 + 末尾导出）。
 *  head：只保留开头，适合词典序有意义的列表（glob 路径、目录条目）。
 *
 *  未列出的工具使用 head-tail 作为保守默认。*/
const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep: { direction: 'head', maxLines: 500 },
  glob: { direction: 'head', maxLines: 500 },
  listDir: { direction: 'head', maxLines: 500 },
}

function policyFor(toolName: string | undefined): TruncateOptions {
  if (!toolName) return { direction: 'head-tail' }
  return PER_TOOL_POLICY[toolName] ?? { direction: 'head-tail' }
}

// ── ToolResultLike ────────────────────────────────────────────────────────────

/** 从 AI SDK 工具结果 part 中提取我们需要操作的字段。
 *  其他字段原样保留，避免意外修改 SDK 的私有属性。*/
type ToolResultLike = {
  type: 'tool-result'
  toolName?: string
  output?: {
    type?: 'text' | 'content' | string
    value?: unknown
  }
}

// ── repairOrphanToolCalls ─────────────────────────────────────────────────────

/**
 * 双向修复 messages 中孤立的 tool_call ↔ tool_result 配对。
 *
 * Provider 的严格要求：
 *   - 每个 assistant tool_call 必须有配对的 tool_result
 *   - 每个 tool_result 必须有前驱的 assistant tool_call
 * 任何一种孤立都会让下次 API 请求 400。
 *
 * 孤立的产生原因：
 *   - 正向（tool_call 无 result）：模型发出了 malformed 工具输入（如缺少必填字段），
 *     SDK 校验失败，发出 tool-error event，某些情况下不在 response.messages 里
 *     产生配对的 tool_result。我们为其合成一条错误 result。
 *   - 反向（tool_result 无 call）：SDK 发出 tool-error 并将 tool_call 排除出
 *     response.messages，但 processToolCalls 仍然处理了 result.toolCalls 里的
 *     "幽灵调用"，把 tool_result 推入 state.messages。我们删除这种孤立结果。
 *
 * 对 messages 原地修改。幂等（运行两次效果相同）。
 */
export function repairOrphanToolCalls(messages: ModelMessage[]): void {
  // 第一步：收集所有 assistant 消息中出现过的 toolCallId
  const expected = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>) {
      if (part?.type === 'tool-call' && typeof part.toolCallId === 'string') {
        expected.add(part.toolCallId)
        if (typeof part.toolName === 'string') toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  // 第二步：反向扫描，删除没有前驱 tool_call 的 tool_result（反向孤立）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    const parts = msg.content as Array<{ type?: string; toolCallId?: string }>
    const kept = parts.filter((part) => {
      if (part?.type !== 'tool-result') return true
      if (typeof part.toolCallId !== 'string') return true
      return expected.has(part.toolCallId)
    })
    if (kept.length === 0) {
      // 整条 tool 消息都是孤立的——判断删除是否安全。
      // 若前后都是 assistant 消息，Anthropic 会拒绝（需要 user/assistant 交替），
      // 用占位文本替换；否则直接删除。
      const prev = messages[i - 1]
      const next = messages[i + 1]
      if (prev?.role === 'assistant' && next?.role === 'assistant') {
        messages[i] = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '[Stale tool result discarded — no matching tool_call in history.]',
            },
          ],
        } as ModelMessage
      } else {
        messages.splice(i, 1)
      }
    } else if (kept.length !== parts.length) {
      // 部分 part 是孤立的，过滤后原地更新
      ;(msg as { content: unknown }).content = kept
    }
  }

  // 第三步：收集当前已有 tool_result 的 id（反向孤立清理后重新扫描）
  const fulfilled = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
        fulfilled.add(part.toolCallId)
      }
    }
  }

  // 第四步：为正向孤立（tool_call 无 result）合成错误结果
  const orphanParts: Array<{
    type: 'tool-result'
    toolCallId: string
    toolName: string
    output: { type: 'text'; value: string }
  }> = []
  for (const id of expected) {
    if (fulfilled.has(id)) continue
    const name = toolNameById.get(id) ?? 'unknown'
    orphanParts.push({
      type: 'tool-result',
      toolCallId: id,
      toolName: name,
      output: {
        type: 'text',
        value:
          'Error: Tool input failed validation (likely missing required fields). The assistant should retry with the correct schema.',
      },
    })
  }
  if (orphanParts.length > 0) {
    // 若末尾已有 tool 消息（processToolCalls 推入了真实结果），合并进去；
    // 否则新建一条 tool 消息。避免相邻两条 tool 消息（某些 provider 不接受）。
    const tail = messages[messages.length - 1]
    if (tail && tail.role === 'tool' && Array.isArray(tail.content)) {
      ;(tail.content as unknown[]).push(...(orphanParts as unknown[]))
    } else {
      messages.push({
        role: 'tool',
        content: orphanParts as never,
      } as ModelMessage)
    }
  }
}

// ── truncateToolResultsInMessages ─────────────────────────────────────────────

/**
 * 对 messages 中所有 tool_result part 的输出做截断（原地修改）。
 *
 * 只修改 output.value 字段，消息的其他结构字段保持原样。
 * 通过 policyFor(toolName) 应用各工具的专属截断策略。
 */
export function truncateToolResultsInMessages(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    if (!Array.isArray(msg.content)) continue

    for (const part of msg.content as unknown as ToolResultLike[]) {
      if (part?.type !== 'tool-result') continue
      const output = part.output
      if (!output) continue

      // 文本输出格式：{ type: 'text', value: string }
      if (output.type === 'text' && typeof output.value === 'string') {
        const truncated = truncateToolResult(output.value, policyFor(part.toolName))
        if (truncated.length !== output.value.length) {
          output.value = truncated
        }
        continue
      }

      // 内容数组格式：{ type: 'content', value: Array<{ type: string, text?: string, ... }> }
      // 只截断文本条目；图像/文件数据由其他地方处理。
      if (output.type === 'content' && Array.isArray(output.value)) {
        const entries = output.value as Array<{ type?: string; text?: string }>
        for (const entry of entries) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            const truncated = truncateToolResult(entry.text, policyFor(part.toolName))
            if (truncated.length !== entry.text.length) {
              entry.text = truncated
            }
          }
        }
      }
    }
  }
}

// @mini-code-cli/core — Context 压缩
//
// 当累积的对话 tokens 超过模型 context window 的 80% 时，触发 LLM 摘要压缩：
//   1. 调用同一 LLM，让它把全部历史消息总结成一段紧凑的摘要
//   2. 用一条 assistant 消息（内容为摘要）替换所有旧消息
//   3. 重置 systemPromptCache（系统提示下轮会重建，包含"压缩摘要"标注）
//   4. 写入 compact-boundary JSONL 行（便于恢复时识别压缩边界）
//   5. 更新 persistedMessageCount（新起点只有 1 条消息）
//
// 设计权衡：
//   - 为什么让 AI 生成摘要，而不是简单截断？
//     截断会丢失早期上下文（如"当前目录结构""已修改文件"等），
//     而 LLM 摘要能保留语义上重要的信息。
//   - 为什么保留全部消息直到压缩触发，而不是滑动窗口？
//     sliding window 难以保证 tool_call/result 配对；
//     全量摘要后从 0 重建更简单，且摘要本身会带入所有必要上下文。
//   - 摘要提示词设计（见 SUMMARIZATION_PROMPT）尽量让模型：
//     保留文件路径、代码片段、未完成任务等关键信息，
//     压缩"来回确认"类的冗余对话。

import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { LoopState } from './loop-state.js'
import { appendCompactBoundary } from './session-store.js'
import { getCompressionThreshold, getMaxOutputTokens } from './context-window.js'

// ── 摘要提示词 ────────────────────────────────────────────────────────────────

const SUMMARIZATION_PROMPT = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the conversation history below.

The summary will replace the full history to free up context window space. The AI assistant will continue the task using only this summary plus future messages.

Requirements for the summary:
1. Preserve ALL technically important information:
   - File paths that were read, created, or modified
   - Code snippets or file contents that are still relevant
   - Shell commands that were executed and their key outputs
   - Current state of any ongoing task
   - Any decisions made or constraints established
2. Compress repetitive exchanges (confirmations, back-and-forth) into single statements
3. Keep the summary under 2000 tokens
4. Write in third person: "The user asked...", "The assistant..."
5. End with a "Current Status:" section describing what is in progress

Reply with ONLY the summary text, no preamble.`

// ── checkAndCompressContext ──────────────────────────────────────────────────

/**
 * 检查 context 是否需要压缩，如需要则执行 LLM 摘要压缩。
 *
 * 调用时机：agentLoop 每轮 runTurn 之前（在 flushPendingMessages 之后）。
 *
 * 压缩条件：`state.lastInputTokens >= getCompressionThreshold(modelId)`
 *
 * 压缩流程：
 *   1. 调用 compressMessages（LLM 生成摘要）
 *   2. 用摘要替换 state.messages
 *   3. 重置 systemPromptCache（触发下轮系统提示重建）
 *   4. 写入 compact-boundary JSONL 行
 *   5. 更新 persistedMessageCount
 *   6. 调用 callbacks.onContextCompressed（UI 通知）
 *
 * 压缩失败时：
 *   - 静默降级（不修改 state），打印 warning 到 stderr
 *   - 不中断 agent loop（宁可让 API 报 413 也不崩溃）
 *
 * @param state      当前 LoopState
 * @param model      当前使用的 LanguageModel
 * @param modelId    模型 ID 字符串（用于判断阈值）
 * @param onContextCompressed  压缩完成后的 UI 回调（可选）
 * @param cwd        工作目录（用于写 compact-boundary）
 */
export async function checkAndCompressContext(
  state: LoopState,
  model: LanguageModel,
  modelId: string,
  onContextCompressed?: () => void,
  cwd?: string,
): Promise<void> {
  const threshold = getCompressionThreshold(modelId)

  // 还没超过阈值，不需要压缩
  if (state.lastInputTokens < threshold) return

  // 历史消息太少，压缩没意义（少于 4 条时跳过）
  if (state.messages.length < 4) return

  try {
    const summary = await compressMessages(state.messages, model, modelId)

    // 写入 compact-boundary 到 JSONL（在修改 state 之前，确保能恢复）
    appendCompactBoundary(state, summary, cwd)

    // 用摘要替换消息历史
    // 保留形式：一条 user 消息说明这是压缩摘要，一条 assistant 消息是摘要内容
    state.messages = [
      {
        role: 'user',
        content: '[Context compressed — summary of conversation so far follows]',
      },
      {
        role: 'assistant',
        content: summary,
      },
    ]

    // 重置系统提示缓存（下轮会重新构建，新系统提示中会包含"已压缩"标注）
    state.systemPromptCache = null

    // 重置 persistedMessageCount：压缩后消息列表从头开始，旧消息已通过
    // compact-boundary 行持久化，新的 2 条消息会在下次 flush 时写入
    state.persistedMessageCount = 0

    // 重置 lastInputTokens，防止下一轮又立即触发压缩
    state.lastInputTokens = 0

    // 通知 UI
    if (onContextCompressed) onContextCompressed()
  } catch (err) {
    // 压缩失败：静默降级，打印警告
    console.error('[context compression] Failed to compress context:', err)
    // 不修改 state，让 agent loop 继续（可能会遇到 413，但不崩溃）
  }
}

// ── compressMessages ──────────────────────────────────────────────────────────

/**
 * 调用 LLM 将对话历史压缩成文字摘要。
 *
 * 实现细节：
 *   - 使用 generateText（非流式）：摘要不需要增量显示
 *   - 将 messages 格式化成可读文本后放入 user 消息
 *   - maxTokens 设为模型 maxOutputTokens 的 1/4（避免摘要本身太长）
 *
 * @param messages  当前完整消息历史
 * @param model     LLM 实例
 * @param modelId   模型 ID（用于 maxTokens 限制）
 * @returns         摘要文字
 */
export async function compressMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  modelId: string,
): Promise<string> {
  const formattedHistory = formatMessagesForSummary(messages)
  const maxOutputTokens = getMaxOutputTokens(modelId)
  // 摘要最多使用 1/4 的输出预算（通常是 2000~8000 tokens）
  const summaryMaxTokens = Math.min(2000, Math.floor(maxOutputTokens / 4))

  const { text } = await generateText({
    model,
    maxOutputTokens: summaryMaxTokens,
    maxRetries: 1,
    messages: [
      {
        role: 'user',
        content: `${SUMMARIZATION_PROMPT}\n\n---\n\n${formattedHistory}`,
      },
    ],
  })

  if (!text.trim()) {
    throw new Error('LLM returned empty summary')
  }

  return text.trim()
}

// ── formatMessagesForSummary ──────────────────────────────────────────────────

/**
 * 将 ModelMessage 数组格式化成 LLM 可读的文字（用于摘要请求的输入）。
 *
 * 格式：
 *   [user]
 *   <用户消息文字>
 *
 *   [assistant]
 *   <助手回复文字（包含工具调用描述）>
 *
 *   [tool_result: toolName]
 *   <工具执行结果（截断为 500 字符）>
 *
 * 复杂的多模态内容（图片等）直接标注类型，不展开。
 */
function formatMessagesForSummary(messages: ModelMessage[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractTextContent(msg.content)
      lines.push(`[user]\n${text}`)
    } else if (msg.role === 'assistant') {
      const text = extractAssistantContent(msg.content)
      if (text) lines.push(`[assistant]\n${text}`)
    } else if (msg.role === 'tool') {
      const text = extractToolResultContent(msg.content)
      if (text) lines.push(`[tool_result]\n${text}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

// ── 内容提取工具 ──────────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 1000)
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text')
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n')
      .slice(0, 1000)
  }
  return String(content).slice(0, 500)
}

function extractAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 2000)
  if (!Array.isArray(content)) return String(content).slice(0, 500)

  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as { type?: string; text?: string; toolName?: string; input?: unknown }
    if (p.type === 'text' && p.text) {
      parts.push(p.text.slice(0, 1000))
    } else if (p.type === 'tool-call') {
      // 工具调用：只记录工具名称和关键参数，不展开完整输入
      const inputSummary = JSON.stringify(p.input ?? {}).slice(0, 200)
      parts.push(`[called tool: ${p.toolName ?? 'unknown'}] ${inputSummary}`)
    } else if (p.type === 'reasoning') {
      // reasoning 内容：标注但不展开（通常很长）
      parts.push('[reasoning: <compressed>]')
    }
  }
  return parts.join('\n').slice(0, 2000)
}

function extractToolResultContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content).slice(0, 500)

  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as { type?: string; toolName?: string; result?: unknown; isError?: boolean }
    if (p.type === 'tool-result') {
      const resultStr = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? '')
      const prefix = p.isError ? `[ERROR from ${p.toolName ?? 'tool'}]` : `[${p.toolName ?? 'tool'}]`
      parts.push(`${prefix} ${resultStr.slice(0, 500)}`)
    }
  }
  return parts.join('\n').slice(0, 1000)
}

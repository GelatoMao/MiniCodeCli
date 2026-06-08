// @mini-code-cli/core — Memory Extractor（自动记忆提取）
//
// 需求 6.6：THE MemoryExtractor SHALL 在每轮正常结束后异步提取关键事实，
//           写入 auto-memory.md。
//
// 工作流程：
//   1. agentLoop 正常 stop 后，异步调用 runMemoryExtractor（不阻塞主流程）
//   2. 构造一个特殊提示，要求 LLM 从本次对话中提取值得记住的事实
//   3. 解析 LLM 返回的 Markdown 列表，追加到项目 auto-memory.md
//
// 设计权衡：
//   - 为什么异步？记忆提取不影响用户体验，且可能较慢（1-2秒），不应阻塞对话流。
//   - 为什么不在同一个 LLM 调用中提取？保持 agentLoop 的单一职责；
//     记忆提取是"后台维护"，与当前任务无关。
//   - 错误处理：提取失败完全静默，不影响主流程。

import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import { appendAutoMemory, getProjectAutoMemoryPath } from '../knowledge/auto-memory.js'

// ── 提取提示词 ────────────────────────────────────────────────────────────────

const MEMORY_EXTRACTION_PROMPT = `You are a memory assistant. Review the conversation below and extract ONLY the most important facts worth remembering for future sessions.

Focus on:
- User preferences (coding style, tools, frameworks)
- Project-specific conventions (naming, file structure)
- Important decisions made
- Key information about the codebase

Output rules:
- Output ONLY a bullet list, one fact per line, starting with "- "
- Each fact must be a single concise sentence (under 100 chars)
- Output NOTHING else — no intro, no explanation, no blank lines between items
- If there is nothing worth remembering, output exactly: NONE

Example output:
- User prefers TypeScript with strict mode enabled
- Project uses pnpm workspaces with two packages: core and cli
- Naming convention: camelCase for variables, PascalCase for types`

// ── 解析 LLM 输出 ─────────────────────────────────────────────────────────────

/** 从 LLM 输出的 Markdown 列表中提取事实字符串数组。
 *  过滤掉空行和非列表行，也过滤掉 "NONE" 响应。*/
function parseFacts(text: string): string[] {
  if (text.trim() === 'NONE') return []

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())  // 去掉 "- " 前缀
    .filter((fact) => fact.length > 0)
}

// ── runMemoryExtractor ────────────────────────────────────────────────────────

/** 异步提取本轮对话的关键事实并写入 auto-memory.md。
 *
 *  设计约定：
 *   - 本函数返回 void Promise，调用方用 `void runMemoryExtractor(...)` 触发（不 await）
 *   - 任何错误均静默忽略，不影响主流程
 *   - 只提取最后一轮的新消息（existingMessageCount 之后的部分）
 *
 *  @param messages              当前 session 的完整消息列表
 *  @param existingMessageCount  提取前已有的消息数（避免重复提取旧内容）
 *  @param model                 用于提取的 LLM 实例（通常是主 agent 同款模型）
 *  @param cwd                   工作目录（用于确定 auto-memory.md 位置）*/
export async function runMemoryExtractor(
  messages: ModelMessage[],
  existingMessageCount: number,
  model: LanguageModel,
  cwd: string = process.cwd(),
): Promise<void> {
  try {
    // 只取本轮新增的消息（existingMessageCount 之后）
    const newMessages = messages.slice(existingMessageCount)
    if (newMessages.length === 0) return

    // 将消息序列化为文本供 LLM 分析
    const conversationText = newMessages
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Tool'
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((part) => 'text' in part && typeof part.text === 'string')
                  .map((part) => ('text' in part ? part.text : ''))
                  .join('\n')
              : String(msg.content)
        return `${role}: ${content}`
      })
      .join('\n\n')

    // 如果对话内容太短（少于 100 个字符），跳过提取
    if (conversationText.trim().length < 100) return

    // 调用 LLM 提取事实
    const result = await generateText({
      model,
      system: MEMORY_EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<conversation>\n${conversationText}\n</conversation>`,
        },
      ],
      maxOutputTokens: 500,
      temperature: 0,   // 确定性输出（字节稳定）
    })

    const facts = parseFacts(result.text ?? '')
    if (facts.length === 0) return

    // 追加到项目 auto-memory.md
    const memoryPath = getProjectAutoMemoryPath(cwd)
    appendAutoMemory(memoryPath, facts)
  } catch {
    // 记忆提取失败完全静默，不影响主流程
  }
}

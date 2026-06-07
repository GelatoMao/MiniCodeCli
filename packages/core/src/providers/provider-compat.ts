// @mini-code-cli/core — Provider 兼容性适配层
//
// 不同 provider 对多模态内容的支持程度不同：
//   - 视觉模型（Claude Sonnet/Haiku、GPT-4o、Gemini 等）：支持图片
//   - 纯文本模型（DeepSeek、旧版 GLM、Moonshot 等）：不支持图片
//
// 当用户通过 @path 引用图片文件时，系统会将其编码为 ImagePart。
// 如果直接发送给不支持视觉的模型，API 会返回 400/422 错误。
//
// 本模块实现"降级"策略：对非视觉模型，将消息中的二进制内容（ImagePart）
// 替换为纯文本占位符，确保模型至少知道"这里有一张图，但我无法处理"。
//
// 降级比直接抛错更好：用户仍然能完成任务（AI 可以基于文件名推断内容），
// 且体验比收到一个神秘的 422 错误要友好得多。

import type { ModelMessage } from 'ai'

// ─── 内部类型别名 ──────────────────────────────────────────────────────────────
// ModelMessage['content'] 是联合类型（string | Part[] | ToolContent 等），
// 需要用 any 绕过严格的类型检查，在运行时按 part.type 做判断。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageContent = any

// ─── 视觉模型列表 ───────────────────────────────────────────────────────────
//
// 维护哪些模型支持图片输入。
// 判断依据：
//   - Anthropic Claude 3+ 全系列支持视觉
//   - OpenAI GPT-4V、GPT-4o、o1 支持视觉
//   - Google Gemini 全系列支持视觉
//   - DeepSeek 不支持视觉（截至 2025-06）
//   - Alibaba qwen-vl-* 支持，其他不支持
//   - xAI grok-vision-* 支持，其他不支持
//   - Zhipu GLM-4V 支持，其他不支持
//   - Moonshot 不支持视觉

const VISION_MODEL_PATTERNS: RegExp[] = [
  // Anthropic Claude 3+（全系列支持）
  /^anthropic:claude-[3-9]/i,
  /^anthropic:claude-haiku/i,
  /^anthropic:claude-sonnet/i,
  /^anthropic:claude-opus/i,
  // OpenAI 视觉模型
  /^openai:gpt-4[- ](vision|v)/i,
  /^openai:gpt-4o/i,
  /^openai:o1/i,
  /^openai:o3/i,
  // Google Gemini（全系列支持多模态）
  /^google:gemini/i,
  // Alibaba 通义千问视觉版
  /^alibaba:qwen-vl/i,
  // xAI 视觉版
  /^xai:grok.*vision/i,
  // 智谱 GLM-4V
  /^zhipu:glm-4v/i,
]

/**
 * 判断给定模型 ID 是否支持视觉（图片）输入。
 *
 * @param modelId 完整的模型 ID（如 "anthropic:claude-sonnet-4-5"）
 */
export function modelSupportsVision(modelId: string): boolean {
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(modelId))
}

/**
 * 图片降级占位符文本模板。
 *
 * 向模型说明有图片但无法处理，并提供文件名（如果有）让模型推断上下文。
 */
function imagePlaceholder(mimeType?: string, filename?: string): string {
  const typeHint = mimeType ? ` (${mimeType})` : ''
  const nameHint = filename ? ` "${filename}"` : ''
  return `[图片${nameHint}${typeHint}：该模型不支持视觉输入，图片内容无法处理]`
}

/**
 * 将单条消息内容中的二进制 Part（图片）替换为文本占位符。
 *
 * 对 `content` 数组中的每个 Part：
 *   - ImagePart（type: 'image'）→ 替换为文本占位符
 *   - FilePart（type: 'file', mimeType 以 'image/' 开头）→ 替换为文本占位符
 *   - 其他 Part → 原样保留
 *
 * 如果 content 是字符串（简单文本消息），直接返回，不做处理。
 */
function downgradeBinaryParts(content: MessageContent): MessageContent {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content

  return content.map((part) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = part as any

    if (p.type === 'image') {
      // ImagePart: { type: 'image', image: string|URL|Uint8Array|ArrayBuffer, mimeType?: string }
      const mimeType: string | undefined = p.mimeType
      return {
        type: 'text' as const,
        text: imagePlaceholder(mimeType),
      }
    }

    if (p.type === 'file' && typeof p.mimeType === 'string' && p.mimeType.startsWith('image/')) {
      // FilePart 里包含图片文件
      return {
        type: 'text' as const,
        text: imagePlaceholder(p.mimeType),
      }
    }

    return part
  })
}

/**
 * 对整个消息数组进行图片降级处理。
 *
 * 遍历所有消息，将图片内容替换为文本占位符，使消息可以发送给非视觉模型。
 *
 * 设计约定：
 *   - 只处理 user / assistant 消息中的 content（tool 消息不含图片）
 *   - 原消息对象不被修改（返回新数组），保证 LoopState 的引用稳定性
 *   - 如果没有任何图片，返回原数组引用（节省分配）
 *
 * @param messages 原始消息数组
 * @returns 降级后的消息数组（如无图片则返回原引用）
 */
export function downgradeBinaryPartsForProvider(messages: ModelMessage[]): ModelMessage[] {
  let hasChanges = false

  const result = messages.map((msg) => {
    const originalContent = msg.content
    const downgraded = downgradeBinaryParts(originalContent as MessageContent)

    if (downgraded !== originalContent) {
      hasChanges = true
      return { ...msg, content: downgraded } as ModelMessage
    }
    return msg
  })

  // 无任何改动时返回原引用，避免触发 React 不必要的重渲染
  return hasChanges ? result : messages
}

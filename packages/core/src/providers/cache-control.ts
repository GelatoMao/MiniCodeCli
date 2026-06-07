// @mini-code-cli/core — Prompt Caching 断点注入
//
// 职责：
//   为支持服务端缓存的 Provider 在消息/Part 上注入缓存控制标记，
//   从而将重复前缀的计算成本摊销到第一次请求，后续请求命中缓存后
//   只需支付极低的 cache read token 费用。
//
// 两种实现：
//
//   1. Anthropic — cache_control 断点注入（最多 4 个，超过静默忽略）
//      通过 providerOptions.anthropic.cacheControl = { type: 'ephemeral' }
//      标记在消息或 Part 上，由 Anthropic SDK 传递给 API。
//
//      断点选择策略（贪婪，从最长稳定前缀到最短动态内容）：
//        Slot 0: 系统提示（跨 session 几乎不变，缓存命中率最高）
//        Slot 1-3: messages 数组末尾 3 条工具结果/助手消息
//                  （一轮对话产出的结果，在同一 session 内不变）
//
//      为什么用最多 4 个断点？
//        Anthropic 当前 API 最多支持 4 个 cache_control 断点。
//        超过后 API 返回 400 错误。本模块确保注入不超过限制。
//
//   2. OpenAI — promptCacheKey 前缀缓存
//      通过 providerOptions.openai.promptCacheKey = sessionId 告知 OpenAI
//      在服务端按 sessionId 缓存前缀。同一 sessionId 的请求会命中 Disk Cache，
//      显著降低输入 token 费用（缓存命中约减少 50% 费用）。
//
//   3. OpenAI-compatible（DeepSeek / Moonshot 等）
//      这类 provider 依赖系统提示的字节稳定（prefix cache）自动命中，
//      无需显式配置。只要 systemPromptCache 在整个 session 内容不变，
//      prefix cache 就会生效。本模块不做任何额外处理。
//
// 重要约束：
//   本函数只做"注入"，不修改消息内容本身。
//   对不支持 prompt cache 的 provider（Google / Alibaba 等），不注入任何标记。

import type { ModelMessage, SystemModelMessage } from 'ai'

import { capabilitiesOf } from './capabilities.js'

// ── 类型辅助 ──────────────────────────────────────────────────────────────────
//
// AI SDK 的 ModelMessage / Part 类型都有可选的 providerOptions 字段，
// 类型为 Record<string, Record<string, unknown>>（即 ProviderOptions）。
// 这里使用局部 interface 而非导入原始类型，避免复杂的泛型传递。

// Anthropic cache_control 注入值（符合 Anthropic SDK Schema）
const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const

// Anthropic 单次请求最多允许 4 个 cache_control 断点
// 超过会导致 API 400 错误
const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4

// ── applyCacheControl ─────────────────────────────────────────────────────────

/**
 * 为一次 `runTurn` 调用注入 Prompt Caching 控制信息。
 *
 * - Anthropic：在系统提示和消息末尾注入 `cache_control: { type: 'ephemeral' }` 断点。
 * - OpenAI：在系统消息上设置 `promptCacheKey: sessionId` 前缀缓存 key。
 * - 其他 provider：不做任何处理，原样返回。
 *
 * 注意：函数返回**新的**系统消息对象和浅拷贝后的消息数组，不会原地修改
 * `state.messages`。调用方决定是否将结果传入 streamText。
 *
 * @param modelId      当前模型 ID（格式：`provider:model`）
 * @param systemPrompt 系统提示文本
 * @param messages     本轮已有的历史消息（不含系统消息）
 * @param sessionId    会话 ID（用于 OpenAI promptCacheKey）
 * @returns            处理后的 `{ systemMessage, messages }`，可直接传入 streamText
 */
export function applyCacheControl(
  modelId: string,
  systemPrompt: string,
  messages: ModelMessage[],
  sessionId: string,
): { systemMessage: SystemModelMessage; messages: ModelMessage[] } {
  const caps = capabilitiesOf(modelId)
  const provider = modelId.split(':')[0] ?? ''

  // 构造基础系统消息（无缓存标记）
  const baseSystemMessage: SystemModelMessage = {
    role: 'system',
    content: systemPrompt,
  }

  // ── 不支持 prompt cache 的 provider：直接返回 ────────────────────────────
  if (!caps.supportsPromptCache) {
    return { systemMessage: baseSystemMessage, messages }
  }

  // ── Anthropic：cache_control 断点注入 ────────────────────────────────────
  if (provider === 'anthropic') {
    return applyAnthropicCacheControl(baseSystemMessage, messages)
  }

  // ── OpenAI：promptCacheKey 前缀缓存 ─────────────────────────────────────
  if (provider === 'openai') {
    return applyOpenAICacheControl(baseSystemMessage, messages, sessionId)
  }

  // 兜底（其他声明 supportsPromptCache 的 provider）
  return { systemMessage: baseSystemMessage, messages }
}

// ── applyAnthropicCacheControl ────────────────────────────────────────────────

/**
 * Anthropic 断点注入策略：
 *
 * 断点预算 = MAX_ANTHROPIC_CACHE_BREAKPOINTS（4）
 *   Slot 0 → 系统消息（优先级最高，缓存命中率最高）
 *   Slot 1-3 → messages 数组末尾 3 条消息（tool-result / assistant 轮次）
 *
 * 断点注入规则：
 *   - 系统消息：在消息级别的 providerOptions 注入
 *   - 普通消息：在消息级别的 providerOptions 注入（每条消息只注入一次）
 *
 * 已有断点不重复注入（幂等），防止每次 turn 都叠加 providerOptions。
 */
function applyAnthropicCacheControl(
  systemMessage: SystemModelMessage,
  messages: ModelMessage[],
): { systemMessage: SystemModelMessage; messages: ModelMessage[] } {
  let remaining = MAX_ANTHROPIC_CACHE_BREAKPOINTS

  // Slot 0：系统消息
  const systemWithCache: SystemModelMessage = {
    ...systemMessage,
    providerOptions: {
      ...systemMessage.providerOptions,
      anthropic: {
        ...(systemMessage.providerOptions?.anthropic as Record<string, unknown> | undefined),
        cacheControl: ANTHROPIC_CACHE_CONTROL,
      },
    },
  }
  remaining--

  // 无可用断点余量 → 直接返回（防止 messages 为空时出错）
  if (remaining <= 0 || messages.length === 0) {
    return { systemMessage: systemWithCache, messages }
  }

  // Slot 1-3：messages 末尾 remaining 条消息
  // 策略：从数组末尾往前找，最多注入 remaining 个断点
  const annotated = [...messages] as ModelMessage[]
  let injected = 0

  for (let i = annotated.length - 1; i >= 0 && injected < remaining; i--) {
    const msg = annotated[i]!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = (msg.providerOptions?.anthropic as any)?.cacheControl
    if (existing) continue // 已有断点，跳过（幂等）

    annotated[i] = {
      ...msg,
      providerOptions: {
        ...msg.providerOptions,
        anthropic: {
          ...(msg.providerOptions?.anthropic as Record<string, unknown> | undefined),
          cacheControl: ANTHROPIC_CACHE_CONTROL,
        },
      },
    } as ModelMessage
    injected++
  }

  return { systemMessage: systemWithCache, messages: annotated }
}

// ── applyOpenAICacheControl ───────────────────────────────────────────────────

/**
 * OpenAI promptCacheKey 注入策略：
 *
 * 在系统消息上设置 `providerOptions.openai.promptCacheKey = sessionId`。
 * OpenAI 后端以此为 key 识别前缀，相同 key 的请求共享磁盘缓存。
 *
 * sessionId 在整个会话内不变，因此同一会话的所有 turn 都能命中缓存。
 * 注意：OpenAI 要求 promptCacheKey 最长 256 字节（我们的 sessionId 格式远短于此）。
 */
function applyOpenAICacheControl(
  systemMessage: SystemModelMessage,
  messages: ModelMessage[],
  sessionId: string,
): { systemMessage: SystemModelMessage; messages: ModelMessage[] } {
  const systemWithCache: SystemModelMessage = {
    ...systemMessage,
    providerOptions: {
      ...systemMessage.providerOptions,
      openai: {
        ...(systemMessage.providerOptions?.openai as Record<string, unknown> | undefined),
        promptCacheKey: sessionId,
      },
    },
  }

  return { systemMessage: systemWithCache, messages }
}

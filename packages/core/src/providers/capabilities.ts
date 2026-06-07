// @mini-code-cli/core — Model Capabilities
//
// 职责：
//   根据模型 ID 返回该模型支持的能力标志。
//   目前涵盖：
//     - supportsVision   — 是否能处理图片（视觉模型）
//     - supportsThinking — 是否支持扩展思考（Chain-of-Thought）
//     - supportsPromptCache — 是否支持服务端 Prompt Caching
//
// 命名惯例：
//   modelId 格式为 "provider:model-name"，如 "anthropic:claude-sonnet-4-5"。
//   当不含冒号时（如仅 "claude-sonnet-4-5"），则将整个字符串视作 model 名，
//   provider 为空字符串，依然能匹配 model 部分的前缀规则。

// ── ModelCapabilities ─────────────────────────────────────────────────────────

export interface ModelCapabilities {
  /** 是否支持视觉（图片输入）*/
  supportsVision: boolean
  /** 是否支持扩展思考（reasoning/thinking 特性）*/
  supportsThinking: boolean
  /** 是否支持服务端 Prompt Caching
   *  Anthropic：cache_control 断点注入
   *  OpenAI：promptCacheKey 前缀缓存
   *  OpenAI-compatible（DeepSeek/Moonshot 等）：依赖系统提示字节稳定，无需显式配置*/
  supportsPromptCache: boolean
}

// ── 能力判断规则 ──────────────────────────────────────────────────────────────
//
// 设计原则：
//   1. 先按 provider 做粗分（避免跨 provider 误判）
//   2. 再按 model 名子串/前缀做细分
//   3. 兜底返回 false（未知模型不开启实验性特性）
//
// 更新策略：
//   各厂商发布新模型时，在对应的子集合中添加名称子串即可，
//   不需要修改判断逻辑本身。

// Anthropic 视觉模型（含 opus/sonnet/haiku 系列全部版本）
const ANTHROPIC_VISION_MODELS = new Set([
  'claude-3',
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
])

// Anthropic 扩展思考模型
// claude-3-7 / claude-opus-4 / claude-sonnet-4-5 支持 thinking
const ANTHROPIC_THINKING_MODELS = new Set([
  'claude-3-7',
  'claude-opus-4',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
])

// OpenAI 视觉模型
const OPENAI_VISION_MODELS = new Set([
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4-vision',
  'gpt-4.1',
  'gpt-5',
  'o1',
  'o3',
  'o4',
])

// OpenAI 推理模型（o 系列，支持 reasoning 但不支持 thinking 参数）
const OPENAI_REASONING_MODELS = new Set(['o1', 'o3', 'o4'])

// ── capabilitiesOf ───────────────────────────────────────────────────────────

/**
 * 返回指定模型 ID 的能力标志集合。
 *
 * @param modelId  格式：`provider:model-name`（如 `anthropic:claude-sonnet-4-5`）
 *                 或仅 `model-name`（如 `claude-sonnet-4-5`）
 */
export function capabilitiesOf(modelId: string): ModelCapabilities {
  const colonIdx = modelId.indexOf(':')
  const provider = colonIdx >= 0 ? modelId.slice(0, colonIdx) : ''
  const model = colonIdx >= 0 ? modelId.slice(colonIdx + 1) : modelId

  // ── Anthropic ────────────────────────────────────────────────────────────
  if (provider === 'anthropic' || (!provider && model.startsWith('claude'))) {
    const supportsVision = [...ANTHROPIC_VISION_MODELS].some((prefix) => model.startsWith(prefix))
    const supportsThinking = [...ANTHROPIC_THINKING_MODELS].some((prefix) => model.startsWith(prefix))
    return {
      supportsVision,
      supportsThinking,
      // Anthropic 所有 claude-3+ 模型均支持 cache_control 断点
      supportsPromptCache: supportsVision,
    }
  }

  // ── OpenAI ───────────────────────────────────────────────────────────────
  if (provider === 'openai') {
    const supportsVision = [...OPENAI_VISION_MODELS].some((prefix) => model.startsWith(prefix))
    const isReasoning = [...OPENAI_REASONING_MODELS].some((prefix) => model.startsWith(prefix))
    return {
      supportsVision,
      // OpenAI 推理模型内置 CoT，但不通过"thinking"字段暴露给用户
      supportsThinking: false,
      // GPT-4o+ 和 o1/o3 支持 promptCacheKey 前缀缓存
      supportsPromptCache: supportsVision || isReasoning,
    }
  }

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  if (provider === 'deepseek') {
    // deepseek-reasoner（R1 系列）支持 thinking；deepseek-chat 不支持
    const supportsThinking = model.includes('reasoner') || model.includes('r1')
    return {
      supportsVision: false,
      supportsThinking,
      // DeepSeek 依赖系统提示字节稳定的隐式 prefix cache，无需显式配置
      supportsPromptCache: false,
    }
  }

  // ── Google ───────────────────────────────────────────────────────────────
  if (provider === 'google') {
    // Gemini 1.5+ 和 2.0 系列支持视觉
    const supportsVision =
      model.includes('gemini-1.5') || model.includes('gemini-2') || model.includes('flash') || model.includes('pro')
    return {
      supportsVision,
      supportsThinking: model.includes('2.0-flash-thinking') || model.includes('gemini-2.5'),
      // Google 的 Context Caching 通过独立 API 管理，不在此处处理
      supportsPromptCache: false,
    }
  }

  // ── Alibaba / xAI / Zhipu / Moonshot / OpenAI-compatible ────────────────
  // 这些 provider 目前默认不开启任何高级特性
  return {
    supportsVision: false,
    supportsThinking: false,
    supportsPromptCache: false,
  }
}

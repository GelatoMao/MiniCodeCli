// @mini-code-cli/core — Context Window 工具函数
//
// 职责：
//   根据模型 ID 返回合适的 context window 配置，用于：
//     1. 判断何时触发 context 压缩（输入 tokens 超过阈值）
//     2. 确定每次请求允许的最大输出 tokens
//
// 设计原则：
//   - 宁可保守（提前压缩）也不让 API 返回 413 错误
//   - 压缩阈值 = 80% 的 context window 大小（留 20% 给新输出）
//   - 最大输出 tokens 取自 provider 文档的官方上限

// ── 模型 Context Window 配置 ────────────────────────────────────────────────

interface ContextConfig {
  /** 模型总 context window 大小（tokens）*/
  contextWindow: number
  /** 每次请求允许的最大输出 tokens */
  maxOutputTokens: number
}

// 已知模型的 context window 配置。
// key 可以是 "provider:model-name" 或仅 model-name 的前缀。
// getContextConfig 会从最具体到最宽泛依次匹配。
const KNOWN_CONTEXTS: [prefix: string, config: ContextConfig][] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // claude-opus-4 系列：200K context，32K 最大输出
  ['anthropic:claude-opus-4', { contextWindow: 200_000, maxOutputTokens: 32_000 }],
  // claude-sonnet-4 系列：200K context，64K 最大输出
  ['anthropic:claude-sonnet-4', { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  // claude-haiku-4 系列：200K context，8K 最大输出
  ['anthropic:claude-haiku-4', { contextWindow: 200_000, maxOutputTokens: 8_192 }],
  // claude-3 系列旧模型
  ['anthropic:claude-3-5-sonnet', { contextWindow: 200_000, maxOutputTokens: 8_192 }],
  ['anthropic:claude-3-5-haiku', { contextWindow: 200_000, maxOutputTokens: 8_192 }],
  ['anthropic:claude-3-7', { contextWindow: 200_000, maxOutputTokens: 64_000 }],
  // Anthropic 默认兜底
  ['anthropic:', { contextWindow: 200_000, maxOutputTokens: 8_192 }],

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // gpt-4.1 系列：1M context
  ['openai:gpt-4.1', { contextWindow: 1_000_000, maxOutputTokens: 32_768 }],
  // gpt-4o 系列：128K context
  ['openai:gpt-4o', { contextWindow: 128_000, maxOutputTokens: 16_384 }],
  // o3/o1 推理模型
  ['openai:o3', { contextWindow: 200_000, maxOutputTokens: 100_000 }],
  ['openai:o1', { contextWindow: 200_000, maxOutputTokens: 100_000 }],
  // OpenAI 默认兜底
  ['openai:', { contextWindow: 128_000, maxOutputTokens: 16_384 }],

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  ['deepseek:deepseek-reasoner', { contextWindow: 64_000, maxOutputTokens: 8_000 }],
  ['deepseek:', { contextWindow: 64_000, maxOutputTokens: 8_000 }],

  // ── Google ───────────────────────────────────────────────────────────────
  // gemini 2.0/2.5 系列：1M context
  ['google:gemini-2', { contextWindow: 1_000_000, maxOutputTokens: 8_192 }],
  // gemini 1.5 系列
  ['google:gemini-1.5-pro', { contextWindow: 2_000_000, maxOutputTokens: 8_192 }],
  ['google:gemini-1.5-flash', { contextWindow: 1_000_000, maxOutputTokens: 8_192 }],
  // Google 默认兜底
  ['google:', { contextWindow: 1_000_000, maxOutputTokens: 8_192 }],

  // ── Alibaba / xAI / Zhipu / Moonshot ────────────────────────────────────
  ['alibaba:', { contextWindow: 32_000, maxOutputTokens: 6_000 }],
  ['xai:', { contextWindow: 131_072, maxOutputTokens: 131_072 }],
  ['zhipu:', { contextWindow: 128_000, maxOutputTokens: 4_096 }],
  ['moonshot:', { contextWindow: 128_000, maxOutputTokens: 4_096 }],
]

/** 默认配置（未知模型兜底）*/
const DEFAULT_CONFIG: ContextConfig = {
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
}

/**
 * 根据模型 ID 获取 context window 配置。
 * 从最具体到最宽泛依次匹配 KNOWN_CONTEXTS。
 */
function getContextConfig(modelId: string): ContextConfig {
  for (const [prefix, config] of KNOWN_CONTEXTS) {
    if (modelId.startsWith(prefix)) return config
  }
  return DEFAULT_CONFIG
}

// ── getCompressionThreshold ──────────────────────────────────────────────────

/** 压缩触发阈值比例（输入 tokens 占 context window 的比例上限）。
 *  超过此比例时触发 LLM 摘要压缩。
 *  设置为 80%：留 20% 余量给新一轮的输入和模型输出，防止 413 错误。*/
const COMPRESSION_THRESHOLD_RATIO = 0.8

/**
 * 返回指定模型的压缩触发阈值（tokens 数）。
 *
 * 当 `state.lastInputTokens >= getCompressionThreshold(modelId)` 时，
 * agentLoop 应触发 `checkAndCompressContext`。
 *
 * @param modelId  格式：`provider:model-name`
 */
export function getCompressionThreshold(modelId: string): number {
  const { contextWindow } = getContextConfig(modelId)
  return Math.floor(contextWindow * COMPRESSION_THRESHOLD_RATIO)
}

// ── getMaxOutputTokens ───────────────────────────────────────────────────────

/**
 * 返回指定模型单次请求允许的最大输出 tokens。
 *
 * 在 compression.ts 中调用 LLM 生成摘要时，需要知道允许的最大输出，
 * 防止摘要生成本身超过模型输出限制。
 *
 * @param modelId  格式：`provider:model-name`
 */
export function getMaxOutputTokens(modelId: string): number {
  return getContextConfig(modelId).maxOutputTokens
}

/**
 * 返回指定模型的完整 context window 大小（tokens）。
 * 用于在 UI 中显示 context 使用率（currentContextTokens / contextWindow）。
 */
export function getContextWindowSize(modelId: string): number {
  return getContextConfig(modelId).contextWindow
}

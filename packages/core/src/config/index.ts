// @mini-code-cli/core — Configuration resolution
//
// API keys always come from environment variables (provider-specific keys
// like ANTHROPIC_API_KEY — never stored on disk).
//
// The default **model** can come from three sources, in precedence order:
//   1. `--model` CLI flag (explicit `input` arg)
//   2. `MINI_CODE_MODEL` environment variable
//   3. Smart default: first provider (by PROVIDER_DETECTION_ORDER) with a key

import { MODEL_ALIASES, PROVIDER_DETECTION_ORDER } from '../types/index.js'

// ─── Provider → Environment Variable Mapping ───
//
// 每个 provider 对应的环境变量名，用于读取 API Key。
// OpenAI 兼容 endpoint 需要额外配置 base URL。

/** Provider → environment variable mapping */
const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
  xai: 'XAI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  // OpenAI 兼容自定义 endpoint：需要 KEY + BASE_URL 两个环境变量
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
}

/** Get API key for a provider — reads from environment variables only */
function getApiKey(provider: string): string | undefined {
  const envKey = ENV_MAP[provider]
  return envKey ? process.env[envKey] : undefined
}

/** Get the env var name for a provider */
export function getEnvVarName(provider: string): string | undefined {
  return ENV_MAP[provider]
}

/** Check which providers have API keys configured (env vars only) */
export function getAvailableProviders(): string[] {
  return Object.keys(ENV_MAP).filter((p) => getApiKey(p))
}

/**
 * Resolve a model ID with three levels of precedence:
 *   1. Explicit `input` (e.g. --model CLI flag)
 *   2. `MINI_CODE_MODEL` environment variable
 *   3. Smart default: first provider (by PROVIDER_DETECTION_ORDER) with an API key
 *
 * Aliases in MODEL_ALIASES (e.g. "sonnet" → "anthropic:claude-sonnet-4-5")
 * are expanded at all levels. Returns null if no provider is configured.
 */
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? process.env.MINI_CODE_MODEL
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit
  }

  for (const { envKey, defaultModel } of PROVIDER_DETECTION_ORDER) {
    if (process.env[envKey]) return defaultModel
  }

  return null
}

/**
 * Build provider options with API keys from env vars.
 *
 * 每个字段仅在对应 API Key 已配置时才存在（undefined 表示未配置）。
 * registry.ts 通过检查这些字段决定是否注册该 provider。
 *
 * OpenAI 兼容 endpoint 额外返回 baseURL（来自 OPENAI_COMPATIBLE_BASE_URL）。
 */
export function getProviderOptions() {
  return {
    anthropic: getApiKey('anthropic'),
    openai: getApiKey('openai'),
    deepseek: getApiKey('deepseek'),
    google: getApiKey('google'),
    alibaba: getApiKey('alibaba'),
    xai: getApiKey('xai'),
    zhipu: getApiKey('zhipu'),
    moonshot: getApiKey('moonshot'),
    // OpenAI 兼容 endpoint：需要 KEY + BASE_URL
    openaiCompatible: getApiKey('openai-compatible')
      ? {
          apiKey: getApiKey('openai-compatible')!,
          baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? '',
        }
      : undefined,
  }
}

/**
 * 获取指定 provider 的 API Key 环境变量名（用于错误提示）。
 *
 * 兼容旧版调用方式，供 CLI 入口（index.ts）使用。
 */
export { ENV_MAP as PROVIDER_ENV_MAP }

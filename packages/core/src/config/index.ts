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

/** Provider → environment variable mapping */
const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
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

/** Build provider options with API keys from env vars */
export function getProviderOptions() {
  return {
    anthropic: getApiKey('anthropic'),
    openai: getApiKey('openai'),
    deepseek: getApiKey('deepseek'),
  }
}

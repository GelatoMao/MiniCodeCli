// @mini-code-cli/core — 公开 API 导出

// ─── Types ───
export type { AgentOptions, AgentCallbacks, TokenUsage, PermissionLevel, PermissionMode, LanguageModel, ModelMessage } from './types/index.js'
export { MODEL_ALIASES, PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS } from './types/index.js'

// ─── Config ───
export { getAvailableProviders, resolveModelId, getEnvVarName, getProviderOptions } from './config/index.js'

// ─── Providers ───
export { createModelRegistry, permanentErrorFetch, deepseekReasoningFetch } from './providers/registry.js'
export { modelSupportsVision, downgradeBinaryPartsForProvider } from './providers/provider-compat.js'

// ─── Agent ───
export { agentLoop, createLoopState } from './agent/loop.js'
export type { LoopState, AgentLoopResult } from './agent/loop.js'
export type { StreamResult } from './agent/stream-utils.js'

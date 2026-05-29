// @mini-code-cli/core — Public type definitions
import type { LanguageModel, ModelMessage } from 'ai'

// ─── Permission ───

export type PermissionLevel = 'always-allow' | 'ask' | 'deny'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

// ─── Token usage ───

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  currentContextTokens: number
}

// ─── Agent callbacks (core → UI bridge) ───

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId: string, toolName: string, input: Record<string, unknown>) => void
  onToolProgress: (toolCallId: string, message: string) => void
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }) => Promise<'yes' | 'always' | 'no'>
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onError: (error: Error) => void
}

// ─── Agent options ───

export interface AgentOptions {
  modelId: string
  trustMode: boolean
  maxTurns?: number
  printMode: boolean
  permissionMode?: PermissionMode
  systemPromptExtra?: string
  abortSignal?: AbortSignal
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry?: { languageModel: (...args: any[]) => LanguageModel }
}

// ─── Model aliases ───

export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic:claude-sonnet-4-5',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt4: 'openai:gpt-4.1',
  deepseek: 'deepseek:deepseek-chat',
}

// ─── Provider detection order (for smart defaults) ───

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-5' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-4.1' },
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-chat' },
] as const

// ─── Re-export AI SDK types ───

export type { ModelMessage, LanguageModel }

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
//
// 短别名 → 规范化模型 ID（provider:model-id 格式）。
// 用于 --model 标志和 /model 命令中，方便用户输入。

export const MODEL_ALIASES: Record<string, string> = {
  // Anthropic
  sonnet: 'anthropic:claude-sonnet-4-5',
  haiku: 'anthropic:claude-haiku-4-5',
  opus: 'anthropic:claude-opus-4-5',
  // OpenAI
  gpt4: 'openai:gpt-4.1',
  gpt4o: 'openai:gpt-4o',
  'gpt-4o': 'openai:gpt-4o',
  o1: 'openai:o1',
  o3: 'openai:o3',
  // DeepSeek
  deepseek: 'deepseek:deepseek-chat',
  'deepseek-r1': 'deepseek:deepseek-reasoner',
  // Google
  gemini: 'google:gemini-2.0-flash',
  'gemini-pro': 'google:gemini-1.5-pro',
  // Alibaba
  qwen: 'alibaba:qwen-plus',
  'qwen-max': 'alibaba:qwen-max',
  // xAI
  grok: 'xai:grok-beta',
  'grok-3': 'xai:grok-3-latest',
  // Zhipu
  glm: 'zhipu:glm-4-plus',
  // Moonshot
  moonshot: 'moonshot:moonshot-v1-8k',
  kimi: 'moonshot:moonshot-v1-8k',
}

// ─── Provider detection order (for smart defaults) ───
//
// 按此顺序检测可用 Provider：第一个有 API Key 的 Provider 作为默认。

export const PROVIDER_DETECTION_ORDER = [
  { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'anthropic:claude-sonnet-4-5' },
  { envKey: 'OPENAI_API_KEY', defaultModel: 'openai:gpt-4o' },
  { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek:deepseek-chat' },
  { envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultModel: 'google:gemini-2.0-flash' },
  { envKey: 'ALIBABA_API_KEY', defaultModel: 'alibaba:qwen-plus' },
  { envKey: 'XAI_API_KEY', defaultModel: 'xai:grok-beta' },
  { envKey: 'ZHIPU_API_KEY', defaultModel: 'zhipu:glm-4-plus' },
  { envKey: 'MOONSHOT_API_KEY', defaultModel: 'moonshot:moonshot-v1-8k' },
  // OpenAI 兼容自定义 endpoint
  { envKey: 'OPENAI_COMPATIBLE_API_KEY', defaultModel: 'openai-compatible:default' },
] as const

// ─── Provider key URLs (用于 No API Key 提示) ───
//
// 显示给用户，帮助他们快速找到申请 API Key 的页面。

export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/',
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/',
  google: 'https://aistudio.google.com/apikey',
  alibaba: 'https://bailian.console.aliyun.com/',
  xai: 'https://console.x.ai/',
  zhipu: 'https://open.bigmodel.cn/',
  moonshot: 'https://platform.moonshot.cn/',
}

// ─── Re-export AI SDK types ───

export type { ModelMessage, LanguageModel }

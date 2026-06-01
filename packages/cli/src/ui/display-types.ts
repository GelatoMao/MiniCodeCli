// @mini-code-cli/cli — UI 层消息展示类型
//
// Task 8：为 stdout-writer 和 ChatInput 定义 DisplayMessage 和相关类型。
// 这些类型是 CLI 的 UI 层专属，不依赖 @mini-code-cli/core。
// 随着 Task 9~11 逐步扩展，更多字段会在这里补充。

/** 工具调用的展示状态 */
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error' | 'denied'

/** 单个工具调用的展示数据 */
export interface DisplayToolCall {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  status: ToolCallStatus
  output?: string
  durationMs?: number
}

/**
 * UI 层消息展示结构（agentLoop callbacks → React state 的映射结果）
 *
 * - `role: 'user'`：用户输入消息
 * - `role: 'assistant'`：AI 回复（可能含文字和工具调用）
 * - `kind === 'command-echo'`：斜杠命令回显行（紧凑格式，无尾部空行）
 * - `kind === 'command-result'`：斜杠命令结果行
 * - `streamingChunk === true`：流式传输中的文字片段（尚未完成）
 */
export interface DisplayMessage {
  role: 'user' | 'assistant'
  content?: string
  toolCalls?: DisplayToolCall[]
  kind?: 'command-echo' | 'command-result'
  /** 是否为流式文字片段（true 时使用不同的行间距规则） */
  streamingChunk?: boolean
}

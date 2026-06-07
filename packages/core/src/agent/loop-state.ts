// @mini-code-cli/core — Shared agent loop state
//
// 说明：这是 LoopState 的 task14 版本，在 task6 基础上新增了会话持久化所需的字段：
//   - persistedMessageCount：已写入 JSONL 文件的消息数（增量写入的游标）
//   - sessionFilePath：本次会话的 JSONL 文件绝对路径（首次 flush 时确定）
//   - taskSlug：任务简短标题（从第一条用户消息提取，用于文件名和列表显示）
import type { ModelMessage } from 'ai'

import type { PermissionMode, TokenUsage } from '../types/index.js'

// ── ToolCallRecord ────────────────────────────────────────────────────────────

/** Loop Guard 记录的单次工具调用，保存名称和参数哈希（非原始输入，节省内存）。*/
export interface ToolCallRecord {
  toolName: string
  hash: string
}

// LoopState 保存整个会话期间的可变状态。
// agentLoop 在用户每次提交消息时接收 existingState 并原地修改，
// 而不是每次都新建，从而实现多轮对话的上下文延续。
export interface LoopState {
  /** 完整的会话消息历史（user / assistant / tool 轮替）*/
  messages: ModelMessage[]
  /** 累计 token 用量（跨所有 turn 累加）*/
  tokenUsage: TokenUsage
  /** 最近一次 API 响应的真实 inputTokens，用于触发 context 压缩。
   *  与 tokenUsage.inputTokens（累计）不同，这是"最后一次请求花了多少"。*/
  lastInputTokens: number
  /** 会话 ID（YYYYMMDD-HHMMSS-mmm 格式），用于文件名、前缀缓存 key 等。*/
  sessionId: string
  /** 会话启动时间（ISO 8601）*/
  startedAt: string
  /** 被修改过的文件路径集合（用于会话摘要和权限追踪）*/
  filesModified: Set<string>
  /** 系统提示缓存。
   *  首次 turn 构建后写入，之后复用以保证 prefix 字节稳定，
   *  实现 OpenAI-compatible providers 的自动前缀缓存。
   *  permissionMode 变化时由 tool-execution 置为 null 以触发重建。*/
  systemPromptCache: string | null
  /** 当前权限模式 — 影响系统提示和可用工具集。*/
  permissionMode: PermissionMode
  /** Loop Guard 滑动窗口。
   *  记录最近 N 次工具调用的 { toolName, hash } 对，
   *  用于检测模型是否在循环重复相同的调用。
   *  task6 新增，由 loop-guard.ts 维护。*/
  recentToolCalls: ToolCallRecord[]

  // ── task14 新增：会话持久化字段 ─────────────────────────────────────────────

  /** 已写入 JSONL 文件的消息数量（增量写入的游标）。
   *  flushPendingMessages 只写 messages.slice(persistedMessageCount) 的部分，
   *  写完后更新此字段。0 表示还未持久化任何消息。*/
  persistedMessageCount: number
  /** 本次会话的 JSONL 文件绝对路径。
   *  第一次调用 flushPendingMessages 时由 getSessionFilePath 确定并写入此字段，
   *  之后复用（避免每次重新计算）。null 表示还未初始化。*/
  sessionFilePath: string | null
  /** 任务简短标题（用于文件名和会话列表显示）。
   *  由外部（CLI 或 use-agent）在创建 LoopState 后立即设置，
   *  或由 hydrateLoopState 从 LoadedSession 恢复。
   *  空字符串表示未设置（显示时用 firstPrompt 代替）。*/
  taskSlug: string
}

// ── generateSessionId ────────────────────────────────────────────────────────

/** 生成人类可读的会话 ID：`YYYYMMDD-HHMMSS-mmm`（本地时间，毫秒尾以保证
 *  同一秒内快速连续启动的唯一性）。比旧版 Date.now().toString(36) 更易读。*/
function generateSessionId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  )
}

// ── createLoopState ─────────────────────────────────────────────────────────

/** 创建一个初始 LoopState。
 *
 * @param initialMode 初始权限模式（默认 'default'）。
 *   通过 options.permissionMode 传入，与 CLI 的 --plan 标志对应。*/
export function createLoopState(initialMode: PermissionMode = 'default'): LoopState {
  return {
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: generateSessionId(),
    startedAt: new Date().toISOString(),
    filesModified: new Set(),
    systemPromptCache: null,
    permissionMode: initialMode,
    recentToolCalls: [],
    // task14 新增：会话持久化初始值
    persistedMessageCount: 0,
    sessionFilePath: null,
    taskSlug: '',
  }
}

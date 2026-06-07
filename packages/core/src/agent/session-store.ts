// @mini-code-cli/core — 会话持久化（JSONL 格式）
//
// 设计目标：
//   将对话历史增量写入 JSONL 文件（每行一个 JSON 对象），
//   支持崩溃恢复和跨次恢复（--continue / --resume）。
//
// JSONL 文件格式（每行一条记录）：
//   {"type":"header","sessionId":"...","modelId":"...","firstPrompt":"...","createdAt":...}
//   {"type":"message","role":"user","content":"..."}
//   {"type":"message","role":"assistant","content":[...]}
//   {"type":"usage","inputTokens":...,"outputTokens":...,"totalTokens":...}
//   {"type":"compact-boundary","summary":"..."}
//
// 增量写入策略：
//   - header 行只写一次（idempotent：文件已存在时跳过）
//   - messages 只追加新增部分（state.persistedMessageCount 跟踪已写条数）
//   - usage 每轮 stop 后写一条快照
//
// 文件位置：
//   `.mini-code/sessions/<sessionId>.jsonl`（项目本地）
//   会话列表索引不做单独文件，通过目录扫描实现。
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ModelMessage } from 'ai'

import { MINI_CODE_DIR } from '../utils.js'
import type { LoopState } from './loop-state.js'

// ── JSONL 行类型定义 ──────────────────────────────────────────────────────────

export interface HeaderRecord {
  type: 'header'
  sessionId: string
  taskSlug: string
  modelId: string
  firstPrompt: string
  createdAt: number
}

export interface MessageRecord {
  type: 'message'
  role: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any
}

export interface UsageRecord {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface CompactBoundaryRecord {
  type: 'compact-boundary'
  summary: string
}

export type SessionRecord = HeaderRecord | MessageRecord | UsageRecord | CompactBoundaryRecord

// ── LoadedSession ─────────────────────────────────────────────────────────────

/**
 * 从磁盘加载会话后的结构化表示。
 * `hydrateLoopState` 会消费此结构重建 LoopState。
 */
export interface LoadedSession {
  sessionId: string
  taskSlug: string
  modelId: string
  firstPrompt: string
  createdAt: number
  messages: ModelMessage[]
  lastSummary?: string
}

// ── 路径工具 ─────────────────────────────────────────────────────────────────

/**
 * 返回会话文件路径。
 * 优先使用项目本地目录（cwd），如果 cwd 为空则使用用户目录。
 *
 * @param sessionId  会话 ID（YYYYMMDD-HHMMSS-mmm）
 * @param cwd        工作目录（可选，默认用 process.cwd()）
 */
export function getSessionFilePath(sessionId: string, cwd?: string): string {
  const base = cwd ?? process.cwd()
  return path.join(base, MINI_CODE_DIR, 'sessions', `${sessionId}.jsonl`)
}

/**
 * 返回会话目录路径。
 */
function getSessionDir(cwd?: string): string {
  const base = cwd ?? process.cwd()
  return path.join(base, MINI_CODE_DIR, 'sessions')
}

// ── 文件写入工具 ──────────────────────────────────────────────────────────────

/**
 * 向文件追加一行 JSON。
 * 文件和父目录不存在时自动创建。
 */
function appendLine(filePath: string, record: SessionRecord): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  // .gitignore：sessions/ 目录属于本地状态，不应入 git
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    try {
      fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
    } catch {
      // 写 .gitignore 失败不影响主流程
    }
  }
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8')
}

// ── appendHeader ──────────────────────────────────────────────────────────────

/**
 * 写入会话 header 行（idempotent）。
 *
 * 检查文件是否已存在：
 *   - 存在 → 跳过（防止重复写 header）
 *   - 不存在 → 写入 header
 *
 * @param filePath    会话文件的绝对路径
 * @param sessionId   会话 ID
 * @param taskSlug    任务简短标题（从第一条用户消息提取，用于文件名）
 * @param modelId     使用的模型 ID（如 "anthropic:claude-sonnet-4-5"）
 * @param firstPrompt 第一条用户消息的文字内容（用于 UI 展示）
 */
export function appendHeader(
  filePath: string,
  sessionId: string,
  taskSlug: string,
  modelId: string,
  firstPrompt: string,
): void {
  if (fs.existsSync(filePath)) return
  const record: HeaderRecord = {
    type: 'header',
    sessionId,
    taskSlug,
    modelId,
    firstPrompt,
    createdAt: Date.now(),
  }
  appendLine(filePath, record)
}

// ── flushPendingMessages ─────────────────────────────────────────────────────

/**
 * 将 state.messages 中尚未持久化的消息增量追加到 JSONL 文件。
 *
 * 依赖 state.persistedMessageCount 追踪已写条数：
 *   - 只写 messages.slice(persistedMessageCount) 的部分
 *   - 写完后将 persistedMessageCount 推进到 messages.length
 *
 * 首次调用时会先确保 header 已写（idempotent 调用 appendHeader）。
 *
 * @param state    当前 LoopState（需包含 persistedMessageCount 字段）
 * @param modelId  使用的模型 ID（写 header 时需要）
 * @param cwd      工作目录（默认 process.cwd()）
 */
export function flushPendingMessages(state: LoopState, modelId: string, cwd?: string): void {
  const filePath = state.sessionFilePath ?? getSessionFilePath(state.sessionId, cwd)

  // 确保 state.sessionFilePath 已设置
  if (!state.sessionFilePath) {
    state.sessionFilePath = filePath
  }

  // 提取第一条用户消息的文字内容作为 firstPrompt
  const firstUserMsg = state.messages.find((m) => m.role === 'user')
  const firstPrompt =
    typeof firstUserMsg?.content === 'string'
      ? firstUserMsg.content.slice(0, 200)
      : JSON.stringify(firstUserMsg?.content ?? '').slice(0, 200)

  // 写 header（idempotent）
  appendHeader(filePath, state.sessionId, state.taskSlug ?? '', modelId, firstPrompt)

  // 增量追加新消息
  const pending = state.messages.slice(state.persistedMessageCount)
  for (const msg of pending) {
    const record: MessageRecord = {
      type: 'message',
      role: msg.role,
      content: msg.content,
    }
    appendLine(filePath, record)
  }
  state.persistedMessageCount = state.messages.length
}

// ── appendUsage ───────────────────────────────────────────────────────────────

/**
 * 追加 usage 快照行到会话文件。
 * 在每轮正常 stop 后调用，记录当前累计 token 用量。
 *
 * @param state  当前 LoopState
 * @param cwd    工作目录（默认 process.cwd()）
 */
export function appendUsage(state: LoopState, cwd?: string): void {
  const filePath = state.sessionFilePath ?? getSessionFilePath(state.sessionId, cwd)
  const record: UsageRecord = {
    type: 'usage',
    inputTokens: state.tokenUsage.inputTokens,
    outputTokens: state.tokenUsage.outputTokens,
    totalTokens: state.tokenUsage.totalTokens,
    cacheReadTokens: state.tokenUsage.cacheReadTokens,
    cacheCreationTokens: state.tokenUsage.cacheCreationTokens,
  }
  appendLine(filePath, record)
}

// ── appendCompactBoundary ─────────────────────────────────────────────────────

/**
 * 追加一条压缩边界记录，标记 context 压缩发生的位置。
 * compression.ts 在压缩完成后调用此函数。
 *
 * @param state    当前 LoopState
 * @param summary  LLM 生成的历史摘要文字
 * @param cwd      工作目录（默认 process.cwd()）
 */
export function appendCompactBoundary(state: LoopState, summary: string, cwd?: string): void {
  const filePath = state.sessionFilePath ?? getSessionFilePath(state.sessionId, cwd)
  const record: CompactBoundaryRecord = {
    type: 'compact-boundary',
    summary,
  }
  appendLine(filePath, record)
}

// ── loadSession ───────────────────────────────────────────────────────────────

/**
 * 从 JSONL 文件加载会话，重建 LoadedSession。
 *
 * 解析规则：
 *   - header 行 → 元数据（sessionId / taskSlug / modelId / firstPrompt / createdAt）
 *   - message 行 → 推入 messages 数组
 *   - compact-boundary 行 → 清空 messages（只保留后续消息），记录 summary
 *   - usage 行 → 静默忽略（不需要重建）
 *   - 解析失败的行 → 静默跳过
 *
 * @param filePath  会话文件的绝对路径
 * @returns LoadedSession，如果文件不存在或无 header 则返回 null
 */
export function loadSession(filePath: string): LoadedSession | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }

  const lines = raw.split('\n').filter((l) => l.trim())

  let header: HeaderRecord | null = null
  const messages: ModelMessage[] = []
  let lastSummary: string | undefined

  for (const line of lines) {
    let record: SessionRecord
    try {
      record = JSON.parse(line) as SessionRecord
    } catch {
      continue // 跳过解析失败的行
    }

    if (record.type === 'header') {
      header = record
    } else if (record.type === 'message') {
      messages.push({
        role: record.role as ModelMessage['role'],
        content: record.content,
      } as ModelMessage)
    } else if (record.type === 'compact-boundary') {
      // 压缩边界：清空旧消息，之后的消息是压缩后的新起点
      messages.length = 0
      lastSummary = record.summary
    }
    // usage 行：静默忽略
  }

  if (!header) return null

  return {
    sessionId: header.sessionId,
    taskSlug: header.taskSlug,
    modelId: header.modelId,
    firstPrompt: header.firstPrompt,
    createdAt: header.createdAt,
    messages,
    lastSummary,
  }
}

// ── listSessions ──────────────────────────────────────────────────────────────

/**
 * 列出指定目录下的所有会话，按创建时间倒序排列（最新在前）。
 * 只读 header 行以提高效率（不全量解析每个文件）。
 *
 * @param cwd  工作目录（默认 process.cwd()）
 * @returns    HeaderRecord 数组，已按 createdAt 倒序排序
 */
export function listSessions(cwd?: string): HeaderRecord[] {
  const sessionDir = getSessionDir(cwd)

  let files: string[]
  try {
    files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }

  const headers: HeaderRecord[] = []
  for (const file of files) {
    const filePath = path.join(sessionDir, file)
    let firstLine: string
    try {
      // 只读第一行（header）
      const content = fs.readFileSync(filePath, 'utf-8')
      firstLine = content.split('\n')[0] ?? ''
    } catch {
      continue
    }
    try {
      const record = JSON.parse(firstLine) as SessionRecord
      if (record.type === 'header') {
        headers.push(record)
      }
    } catch {
      continue
    }
  }

  // 按创建时间倒序
  return headers.sort((a, b) => b.createdAt - a.createdAt)
}

// ── pickLatestSession ──────────────────────────────────────────────────────────

/**
 * 找到最近一次会话（createdAt 最大的那条）。
 *
 * @param cwd  工作目录（默认 process.cwd()）
 * @returns    最新的 HeaderRecord，如果无会话记录则返回 null
 */
export function pickLatestSession(cwd?: string): HeaderRecord | null {
  const all = listSessions(cwd)
  return all[0] ?? null
}

/**
 * 通过 sessionId 前缀、taskSlug 或文件名精确/模糊查找会话。
 *
 * 匹配优先级：
 *   1. sessionId 完全匹配
 *   2. sessionId 以 query 开头
 *   3. taskSlug 包含 query（大小写不敏感）
 *
 * @param query  sessionId / slug / 文件名前缀
 * @param cwd    工作目录
 */
export function findSession(query: string, cwd?: string): HeaderRecord | null {
  const all = listSessions(cwd)
  // 完全匹配
  const exact = all.find((h) => h.sessionId === query)
  if (exact) return exact
  // 前缀匹配 sessionId
  const prefix = all.find((h) => h.sessionId.startsWith(query))
  if (prefix) return prefix
  // taskSlug 模糊匹配
  const slug = all.find((h) => h.taskSlug.toLowerCase().includes(query.toLowerCase()))
  if (slug) return slug
  return null
}

// ── hydrateLoopState ──────────────────────────────────────────────────────────

/**
 * 从 LoadedSession 重建 LoopState，用于 --continue / --resume 续传。
 *
 * 重建策略：
 *   - messages：直接使用 loadSession 解析出的消息列表
 *   - persistedMessageCount：设为 messages.length（已全部持久化）
 *   - sessionFilePath：重新计算
 *   - 其他字段（tokenUsage / systemPromptCache 等）：使用初始默认值
 *     因为 tokenUsage 只用于 UI 显示，不影响 agent 功能；
 *     systemPromptCache 会在首次 runTurn 时重新构建。
 *
 * @param session        从 loadSession 得到的 LoadedSession
 * @param permissionMode 权限模式（来自 CLI 标志）
 * @param cwd            工作目录（默认 process.cwd()）
 */
export function hydrateLoopState(
  session: LoadedSession,
  permissionMode: import('../types/index.js').PermissionMode = 'default',
  cwd?: string,
): LoopState {
  const filePath = getSessionFilePath(session.sessionId, cwd)

  return {
    messages: session.messages,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      currentContextTokens: 0,
    },
    lastInputTokens: 0,
    sessionId: session.sessionId,
    taskSlug: session.taskSlug,
    startedAt: new Date(session.createdAt).toISOString(),
    filesModified: new Set(),
    systemPromptCache: null,
    permissionMode,
    recentToolCalls: [],
    persistedMessageCount: session.messages.length,
    sessionFilePath: filePath,
  }
}

// ── 通过 homedir 的全局会话目录（供未来 --resume 列表用） ─────────────────────────

/**
 * 获取用户全局会话目录（~/.mini-code/sessions）。
 * 目前未使用，预留给未来的全局会话列表功能。
 */
export function getGlobalSessionDir(): string {
  return path.join(os.homedir(), '.mini-code', 'sessions')
}

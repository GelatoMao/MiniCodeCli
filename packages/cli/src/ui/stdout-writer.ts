// @mini-code-cli/cli — 直接写入 stdout 的消息写入器
//
// 为何存在：Ink 的布局引擎对 CJK 字符的视觉宽度计算有误。
// 我们通过 Ink 的 `useStdout()` 钩子拿到 `write` 函数，
// 将消息历史完全在 Ink 之外渲染，写入原始 ANSI 字节。
//
// Ink 仍持有屏幕底部的动态区域（spinner、进行中的工具调用、权限对话框、
// 聊天输入框）。该区域内容短且大多是 ASCII，Ink 自身的度量足够精确。
//
// Task 10 — 完整版：补全工具行渲染（duration 显示、状态图标）和 Markdown 前置渲染。
// Task 11 — Markdown 集成：助手回复内容通过 renderMarkdown 渲染再写入 scrollback。
//           对于流式片段（streamingChunk=true），不做 Markdown 渲染（逐字符渲染时
//           Markdown 语法可能不完整），等 agentLoop 完成后提交为正式消息时再渲染。

import { renderMarkdown, hasMarkdownSyntax } from './render-markdown.js'

/** Ink 提供的 stdout 写入函数类型（与 Ink 的 log-update 协调） */
export type InkWrite = (data: string) => void

/** 将所有 \n 替换为 \r\n。
 *  防止在 stdout 的 ONLCR 输出转换被禁用的终端（如 VS Code）上，
 *  光标停留在行末列，导致下一帧的 cell-buffer 重绘覆盖当前文字。 */
function toCRLF(s: string): string {
  return s.replace(/\r?\n/g, '\r\n')
}

/**
 * 前一次 scrollback 写入是否在其最后内容行下方留有完整空行。
 * 用于维持相邻实体之间恰好一行空行的间距规则。
 * 初始化为 true，使会话第一次写入不产生前导空行。
 */
let prevWriteEndedWithBlankRow = true

/**
 * 前一次写入是否为流式文字片段。
 * 当下一次写入也是流式片段时，视为同一 assistant 消息的延续，
 * 不插入 `prevWriteEndedWithBlankRow` 机制本应添加的前导空行。
 */
let prevWriteWasStreamingChunk = false

/** 重置间距标志（/clear 后调用） */
export function resetScrollbackSpacing(): void {
  prevWriteEndedWithBlankRow = true
  prevWriteWasStreamingChunk = false
}

/** 前一次 scrollback 写入是否以空行结尾（供 ChatInput 帧构建器读取） */
export function lastWriteEndedWithBlankRow(): boolean {
  return prevWriteEndedWithBlankRow
}

// ── 颜色常量（与 palette.ts 保持一致）─────────────────────────────────────────

const C_RESET = '\x1b[0m'
const C_GRAY = '\x1b[38;2;136;136;136m'   // #888888
const C_GREEN = '\x1b[38;2;78;186;101m'   // #4eba65（完成）
const C_BLUE = '\x1b[38;2;147;165;255m'   // #93a5ff（运行中）
const C_RED = '\x1b[38;2;255;107;128m'    // #ff6b80（错误）
const C_YELLOW = '\x1b[38;2;255;193;7m'   // #ffc107（警告/等待）
const C_DIM = '\x1b[2m'
const C_BOLD = '\x1b[1m'
const C_GRAY_90 = '\x1b[90m'              // ANSI 亮黑，等价于 chalk.gray()

// ── 用户消息 ──────────────────────────────────────────────────────────────

/**
 * 向 scrollback 写入用户消息。
 * `compact` 为 true 时用于斜杠命令回显：省略尾部空行，
 * 使后续的 `⎿ result` 行紧贴回显行。
 */
function writeUserMessage(write: InkWrite, content: string, compact = false): void {
  const arrow = `${C_GRAY}❯${C_RESET}`
  const lines = content.split('\n')
  const [first = '', ...rest] = lines
  const indentedRest = rest.map((line) => `  ${line}`)
  const body = [`${arrow} ${first}`, ...indentedRest].join('\n')
  const trailing = compact ? '\n' : '\n\n'
  write(toCRLF('\n' + body + trailing))
}

// ── 工具调用行（Task 10 完整版）────────────────────────────────────────────────

/**
 * 工具调用状态对应的图标（彩色圆点）。
 *
 * 状态图标设计：
 *   - pending:   蓝色○（等待执行）
 *   - running:   蓝色●（运行中，配合 spinner 脉冲）
 *   - completed: 绿色●（成功）
 *   - error:     红色●（失败）
 *   - denied:    黄色○（被拒绝）
 */
function toolStatusIcon(status: string): string {
  switch (status) {
    case 'pending': return `${C_BLUE}○${C_RESET}`
    case 'running': return `${C_BLUE}●${C_RESET}`
    case 'completed': return `${C_GREEN}●${C_RESET}`
    case 'error': return `${C_RED}●${C_RESET}`
    case 'denied': return `${C_YELLOW}○${C_RESET}`
    default: return `${C_GRAY}●${C_RESET}`
  }
}

/**
 * 格式化 duration 毫秒为人类可读字符串。
 * < 1s → "Xms"；>= 1s → "X.Xs"；>= 60s → "Xm Xs"
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const rem = Math.round(secs % 60)
  return `${mins}m ${rem}s`
}

/**
 * 将工具输入格式化为简短摘要（单行），用于工具行的描述部分。
 * 最长 80 字符。
 */
function formatToolInputSummary(toolName: string, input: Record<string, unknown>): string {
  // 常见工具的专用摘要格式
  switch (toolName) {
    case 'readFile':
    case 'read_file': {
      const path = input['path'] ?? input['file_path']
      return path ? String(path) : ''
    }
    case 'writeFile':
    case 'write_file': {
      const path = input['path'] ?? input['file_path']
      return path ? String(path) : ''
    }
    case 'edit': {
      const path = input['path'] ?? input['file_path']
      return path ? String(path) : ''
    }
    case 'listDir':
    case 'list_dir': {
      const path = input['path'] ?? input['directory']
      return path ? String(path) : ''
    }
    case 'glob': {
      const pattern = input['pattern']
      return pattern ? String(pattern) : ''
    }
    case 'grep': {
      const pattern = input['pattern']
      return pattern ? String(pattern) : ''
    }
    case 'shell': {
      const cmd = input['command']
      if (!cmd) return ''
      const s = String(cmd)
      return s.length > 80 ? s.slice(0, 77) + '…' : s
    }
    default: {
      // 通用：取第一个字符串类型的值
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.length > 0) {
          return v.length > 80 ? v.slice(0, 77) + '…' : v
        }
      }
      return ''
    }
  }
}

/**
 * 将工具输出格式化为单行摘要（最长 120 字符）。
 * 去掉首尾空白，换行符替换为空格。
 */
function formatOutputSummary(output: string): string {
  const oneline = output.trim().replace(/\r?\n/g, ' ')
  return oneline.length > 120 ? oneline.slice(0, 117) + '…' : oneline
}

/**
 * 格式化一条工具调用行（Task 10 完整版）。
 *
 * 格式：
 *   " ● <toolName> <inputSummary>  [duration]"   ← 主行
 *   "    ⎿  <outputSummary>"                      ← 输出摘要（可选，仅 completed/error）
 *
 * 参数：
 *   @param toolName 工具名称
 *   @param input 工具输入（用于摘要）
 *   @param status 工具状态
 *   @param output 工具输出（可选）
 *   @param durationMs 执行耗时（毫秒，可选）
 */
export function formatToolCallLine(
  toolName: string,
  input: Record<string, unknown>,
  status: string,
  output?: string,
  durationMs?: number,
): string {
  const icon = toolStatusIcon(status)
  const inputSummary = formatToolInputSummary(toolName, input)

  // 耗时部分（仅 completed/error 且有 durationMs 时显示）
  let durationStr = ''
  if (durationMs !== undefined && (status === 'completed' || status === 'error')) {
    durationStr = `  ${C_GRAY_90}[${formatDuration(durationMs)}]${C_RESET}`
  }

  // 工具名粗体
  const nameStr = `${C_BOLD}${toolName}${C_RESET}`
  const inputStr = inputSummary ? ` ${C_GRAY}${inputSummary}${C_RESET}` : ''

  const mainLine = ` ${icon} ${nameStr}${inputStr}${durationStr}`

  // 输出摘要行（仅在有输出内容时显示）
  if (output && output.trim() && (status === 'completed' || status === 'error')) {
    const summary = formatOutputSummary(output)
    const color = status === 'error' ? C_RED : C_GRAY_90
    const outputLine = `   ${C_GRAY_90}⎿${C_RESET}  ${color}${summary}${C_RESET}`
    return `${mainLine}\n${outputLine}`
  }

  return mainLine
}

// ── 主写入函数 ────────────────────────────────────────────────────────────────

/**
 * 将一条 DisplayMessage 打印到 scrollback（通过 InkWrite 函数）。
 *
 * Task 10 版本：完整实现用户消息、工具调用行（含 duration）、助手文字内容写入。
 * Markdown 渲染（Task 11）补全后在此集成。
 */
export function writeMessageToStdout(
  write: InkWrite,
  msg: {
    role: 'user' | 'assistant'
    content?: string
    toolCalls?: Array<{
      toolCallId: string
      toolName: string
      input?: Record<string, unknown>
      status: string
      output?: string
      durationMs?: number
    }>
    kind?: 'command-echo' | 'command-result'
    streamingChunk?: boolean
  },
): void {
  if (msg.role === 'user') {
    writeUserMessage(write, msg.content ?? '', msg.kind === 'command-echo')
    prevWriteEndedWithBlankRow = msg.kind !== 'command-echo'
    prevWriteWasStreamingChunk = false
    return
  }

  // 斜杠命令结果行
  if (msg.kind === 'command-result' && msg.content) {
    const lines = msg.content.split('\n')
    const head = `  ${C_GRAY_90}⎿${C_RESET}  ${lines[0] ?? ''}`
    const tail = lines.slice(1).map((l) => `     ${l}`)
    write(toCRLF([head, ...tail].join('\n') + '\n'))
    prevWriteEndedWithBlankRow = false
    prevWriteWasStreamingChunk = false
    return
  }

  // 工具调用行（Task 10：完整格式，含 duration）
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const lead = prevWriteEndedWithBlankRow ? '' : '\n'
      const line = formatToolCallLine(
        tc.toolName,
        tc.input ?? {},
        tc.status,
        tc.output,
        tc.durationMs,
      )
      write(toCRLF(lead + line + '\n'))
      prevWriteEndedWithBlankRow = false
      prevWriteWasStreamingChunk = false
    }
  }

  // 助手文字内容
  // Task 11：非流式消息使用 Markdown 渲染；流式片段原样输出（内容可能不完整）。
  if (msg.content) {
    const isStreamContinuation = !!msg.streamingChunk && prevWriteWasStreamingChunk
    if (!prevWriteEndedWithBlankRow && !isStreamContinuation) {
      write(toCRLF('\n'))
      prevWriteEndedWithBlankRow = true
    }

    let renderedContent: string
    if (msg.streamingChunk) {
      // 流式片段：原样输出（Markdown 语法可能不完整，不做渲染）
      renderedContent = msg.content.endsWith('\n') ? msg.content : msg.content + '\n'
    } else {
      // 完整消息：检测是否有 Markdown 语法，有则渲染
      const text = msg.content
      const rendered = hasMarkdownSyntax(text) ? renderMarkdown(text) : text
      renderedContent = rendered + '\n\n'
    }

    write(toCRLF(renderedContent))

    if (msg.streamingChunk) {
      prevWriteEndedWithBlankRow = renderedContent.endsWith('\n\n')
      prevWriteWasStreamingChunk = true
    } else {
      prevWriteEndedWithBlankRow = true
      prevWriteWasStreamingChunk = false
    }
  }
}

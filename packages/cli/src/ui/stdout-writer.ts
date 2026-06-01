// @mini-code-cli/cli — 直接写入 stdout 的消息写入器（简化版）
//
// 为何存在：Ink 的布局引擎对 CJK 字符的视觉宽度计算有误。
// 我们通过 Ink 的 `useStdout()` 钩子拿到 `write` 函数，
// 将消息历史完全在 Ink 之外渲染，写入原始 ANSI 字节。
//
// Ink 仍持有屏幕底部的动态区域（spinner、进行中的工具调用、权限对话框、
// 聊天输入框）。该区域内容短且大多是 ASCII，Ink 自身的度量足够精确。
//
// Task 8 — 简化版，Task 10/11 将补全完整渲染逻辑（Markdown、工具行等）。

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

// ── 用户消息 ──────────────────────────────────────────────────────────────

/**
 * 向 scrollback 写入用户消息。
 * `compact` 为 true 时用于斜杠命令回显：省略尾部空行，
 * 使后续的 `⎿ result` 行紧贴回显行。
 */
function writeUserMessage(write: InkWrite, content: string, compact = false): void {
  const arrow = '\x1b[38;2;136;136;136m❯\x1b[0m' // 灰色箭头
  const lines = content.split('\n')
  const [first = '', ...rest] = lines
  const indentedRest = rest.map((line) => `  ${line}`)
  const body = [`${arrow} ${first}`, ...indentedRest].join('\n')
  const trailing = compact ? '\n' : '\n\n'
  write(toCRLF('\n' + body + trailing))
}

// ── 工具调用行（简化版） ──────────────────────────────────────────────────

function formatSimpleToolCall(toolName: string, status: string, output?: string): string {
  const bullet = status === 'completed' ? '\x1b[38;2;78;186;101m●\x1b[0m' : '\x1b[38;2;147;165;255m●\x1b[0m'
  const line1 = ` ${bullet} \x1b[1m${toolName}\x1b[0m`
  if (!output) return line1
  const summary = output.length > 120 ? output.slice(0, 117) + '…' : output
  return `${line1}\n   \x1b[90m⎿\x1b[0m  ${summary}`
}

// ── 主写入函数 ────────────────────────────────────────────────────────────

/**
 * 将一条 DisplayMessage 打印到 scrollback（通过 Ink write 函数）。
 *
 * Task 8 版本：实现基础的用户消息和工具调用行写入。
 * 完整 Markdown 渲染、工具结果折叠等逻辑在 Task 10/11 补全。
 */
export function writeMessageToStdout(
  write: InkWrite,
  msg: {
    role: 'user' | 'assistant'
    content?: string
    toolCalls?: Array<{ toolCallId: string; toolName: string; status: string; output?: string }>
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
    const head = `  \x1b[90m⎿\x1b[0m  ${lines[0] ?? ''}`
    const tail = lines.slice(1).map((l) => `     ${l}`)
    write(toCRLF([head, ...tail].join('\n') + '\n'))
    prevWriteEndedWithBlankRow = false
    prevWriteWasStreamingChunk = false
    return
  }

  // 工具调用行
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const lead = prevWriteEndedWithBlankRow ? '' : '\n'
      write(toCRLF(lead + formatSimpleToolCall(tc.toolName, tc.status, tc.output) + '\n'))
      prevWriteEndedWithBlankRow = false
      prevWriteWasStreamingChunk = false
    }
  }

  // 助手文字内容
  if (msg.content) {
    const isStreamContinuation = !!msg.streamingChunk && prevWriteWasStreamingChunk
    if (!prevWriteEndedWithBlankRow && !isStreamContinuation) {
      write(toCRLF('\n'))
      prevWriteEndedWithBlankRow = true
    }

    const out = msg.streamingChunk
      ? msg.content.endsWith('\n')
        ? msg.content
        : msg.content + '\n'
      : msg.content + '\n\n'

    write(toCRLF(out))

    if (msg.streamingChunk) {
      prevWriteEndedWithBlankRow = out.endsWith('\n\n')
      prevWriteWasStreamingChunk = true
    } else {
      prevWriteEndedWithBlankRow = true
      prevWriteWasStreamingChunk = false
    }
  }
}

// @mini-code-cli/cli — 底部动态区域（spinner + 输入框）+ scrollback 提交路径
//
// 渲染策略 — CELL 级差分，直接写 STDOUT：
//   Ink 的 Yoga 布局和 log-update 对 CJK/IME 字符宽度计算有误。
//   为绕过两个引擎，我们自己渲染整个底部区域：
//
//     - 每帧 = Cell 二维网格（char + style + visual width）
//     - 逐 cell 与上一帧做差分
//     - 将所有变更合并为单次 process.stdout.write()
//     - 未变更的 CJK cell 永不重新发射 → 无重绘抖动
//
//   向 Ink 返回 null，使 Ink 的动态区域始终为空；
//   我们拥有 scrollback 以下的一切。
//
// Task 8 — 核心骨架版本：
//   - 实现 cell-diff 渲染引擎
//   - 输入框渲染（光标、CJK 宽字符感知）
//   - Spinner 行渲染
//   - scrollback 提交（append-only commit）
//   - 基本键盘输入处理
//   - 不含斜杠补全、@-mention、权限对话框等（Task 9+ 扩展）
//
// Task 11 — Token 状态栏：在分隔线末尾右对齐显示 token 用量（input/output/cache/context%）
import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'

import { useStdout } from 'ink'

import { BSU, ESU_HIDE, S_CURSOR, S_DIM, S_NONE, S_RESET, S_SPINNER } from '../chat-input/palette.js'
import { type Cell, cellsEqual, textToCells } from '../chat-input/cells.js'
import { type InputState, inputReducer } from '../chat-input/reducer.js'
import { countContentRows, wrapCellsToRows } from '../chat-input/text-helpers.js'
import { charWidth, visualWidth } from '../text-width.js'
import { writeMessageToStdout } from '../stdout-writer.js'
import type { DisplayMessage } from '../display-types.js'
import { usePromptInput } from '../hooks/use-prompt-input.js'
import type { TokenUsage } from '@mini-code-cli/core'

// ── 常量 ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
const MAX_INPUT_ROWS = 10

// ── Props ─────────────────────────────────────────────────────────────────

export interface ChatInputProps {
  /**
   * 所有 scrollback 消息。新条目通过直接写 stdout 提交到终端历史。
   * 我们持有整个底部区域 —— Ink 不得再写 scrollback，否则其
   * log-update 会与我们争夺光标位置。
   * 注意：只传已最终提交的消息，流式预览文字通过 streamingText prop 传入。
   */
  messages: readonly DisplayMessage[]
  onSubmit: (text: string) => void
  onInterrupt: () => void
  /**
   * 权限确认回调（pendingPermission 场景）。
   * 用户按 y/n 时调用，绕过 isLoading 屏蔽。
   */
  onPermissionKey?: (key: 'y' | 'n') => void
  /** 是否有权限确认等待用户输入（决定是否激活 y/n 快捷键） */
  pendingPermission?: boolean
  /** true = AI 请求/工具运行中，驱动 spinner 显示和 Esc 取消路由 */
  isLoading?: boolean
  /** 临时一行通知（如"再按 Ctrl+C 退出"），显示在输入框下方 */
  notice?: string | null
  /** 禁用键盘输入（并隐藏输入光标） */
  disabled?: boolean
  /** Spinner 文字（如"Thinking…"），null/undefined = 不显示 */
  spinnerLabel?: string | null
  /**
   * 当前流式输出的文字片段（实时预览，不写入 scrollback）。
   * 显示在 spinner 行上方，agentLoop 完成后由 use-agent 提交为正式消息。
   */
  streamingText?: string | null
  /**
   * Token 用量统计（Task 11）。
   * 显示在分隔线右侧：input/output/cache read/context%
   */
  tokenUsage?: TokenUsage | null
  /**
   * 是否处于模型选择器模式（Task 12）。
   * 为 true 时，上下键和回车键路由到 onPickerNavKey，不更新输入框。
   */
  isModelPicking?: boolean
  /**
   * 模型选择器导航键回调（Task 12）。
   * 接收 'up' | 'down' | 'enter' | 'escape'。
   */
  onPickerNavKey?: (key: 'up' | 'down' | 'enter' | 'escape') => void
}

// ── 辅助：构建输入行 cells ─────────────────────────────────────────────────

/**
 * 将输入文字和光标位置构建为 Cell 行（CJK 感知，光标 = 反色块）。
 * 文字超出 maxWidth 时，视觉上截断并在末尾显示 `…`。
 */
function buildInputCells(text: string, cursor: number, maxWidth: number): Cell[][] {
  // 将文字分解为 cells，在光标位置插入反色块
  const allCells: Cell[] = []
  let charIdx = 0
  for (const ch of text) {
    const isAtCursor = charIdx === cursor
    allCells.push({ char: ch, style: isAtCursor ? S_CURSOR : S_NONE, width: charWidth(ch) })
    charIdx += ch.length
  }
  // 光标在末尾时，追加一个反色空格
  if (cursor >= text.length) {
    allCells.push({ char: ' ', style: S_CURSOR, width: 1 })
  }

  // 折行：宽度 maxWidth，最多 MAX_INPUT_ROWS 行
  const rows = wrapCellsToRows(allCells, maxWidth, MAX_INPUT_ROWS)
  if (rows.length === 0) {
    // 空输入：仅显示光标
    return [[{ char: ' ', style: S_CURSOR, width: 1 }]]
  }
  return rows
}

// ── 辅助：构建整帧 ─────────────────────────────────────────────────────────

interface FrameState {
  text: string
  cursor: number
  spinnerFrame: number
  spinnerLabel: string | null
  streamingText: string | null
  notice: string | null
  termWidth: number
  tokenUsage: TokenUsage | null
}

// ── Token 状态栏渲染 ─────────────────────────────────────────────────────────

// Token 颜色（用于分隔线右侧的状态栏）
const S_TOKEN_IN = '\x1b[0m\x1b[38;2;147;165;255m'   // 蓝紫色（input tokens）
const S_TOKEN_OUT = '\x1b[0m\x1b[38;2;78;186;101m'   // 绿色（output tokens）
const S_TOKEN_CACHE = '\x1b[0m\x1b[38;2;209;154;102m' // 橙色（cache read tokens）
const S_TOKEN_CTX = '\x1b[0m\x1b[38;2;136;136;136m'  // 灰色（context 百分比）
const S_TOKEN_SEP = '\x1b[0m\x1b[38;2;80;80;100m'    // 暗灰（分隔符）

/**
 * 格式化 token 数量为人类可读的简短字符串。
 * < 1k → "NNN"；>= 1k → "N.Nk"；>= 100k → "NNNk"
 */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * 构建 token 状态栏字符串（含 ANSI 颜色）。
 * 格式：in:NNNk  out:NNNk  cache:NNNk  ctx:NN%
 *
 * 仅在有非零 token 时显示（agentLoop 尚未开始时不显示）。
 */
function buildTokenStatusText(usage: TokenUsage | null): string {
  if (!usage || usage.totalTokens === 0) return ''

  const parts: string[] = []

  if (usage.inputTokens > 0) {
    parts.push(`${S_TOKEN_IN}in:${formatTokenCount(usage.inputTokens)}${S_TOKEN_SEP}`)
  }
  if (usage.outputTokens > 0) {
    parts.push(`${S_TOKEN_OUT}out:${formatTokenCount(usage.outputTokens)}${S_TOKEN_SEP}`)
  }
  if ((usage.cacheReadTokens ?? 0) > 0) {
    parts.push(`${S_TOKEN_CACHE}cache:${formatTokenCount(usage.cacheReadTokens ?? 0)}${S_TOKEN_SEP}`)
  }
  if (usage.currentContextTokens != null && usage.currentContextTokens > 0) {
    // 假设模型上下文窗口为 200k（通用估算，实际应从 capabilities 获取）
    const pct = Math.min(99, Math.round((usage.currentContextTokens / 200000) * 100))
    parts.push(`${S_TOKEN_CTX}ctx:${pct}%${S_TOKEN_SEP}`)
  }

  if (parts.length === 0) return ''

  // 去掉最后一个 S_TOKEN_SEP（尾部无需分隔符）
  const joined = parts.join(`${S_TOKEN_SEP} `)
  return joined
}

/**
 * 将 token 状态文字（含 ANSI）转换为 Cell 行，右对齐填充到 termWidth。
 * 分隔线行 = 左侧灰色 ─ + 右侧 token 状态栏。
 */
function buildSeparatorWithTokens(tokenUsage: TokenUsage | null, termWidth: number): Cell[] {
  const tokenText = buildTokenStatusText(tokenUsage)

  if (!tokenText) {
    // 无 token 信息：纯分隔线
    const sep = '─'.repeat(Math.max(0, termWidth))
    return textToCells(sep, S_DIM)
  }

  // 计算 token 状态文字的可见宽度（去掉 ANSI）
  const visibleToken = tokenText.replace(/\x1b\[[0-9;]*m/g, '')
  const tokenVisWidth = visibleToken.length

  // 分隔线宽度 = termWidth - tokenVisWidth - 1（右侧留1空格）
  const sepLen = Math.max(0, termWidth - tokenVisWidth - 1)
  const sep = '─'.repeat(sepLen)

  // 拼接：[灰色分隔线][空格][token 状态栏]
  // 注意：tokenText 含有 ANSI 序列，不能直接用 textToCells，
  // 用特殊处理：把 token 状态作为单个宽度等于 tokenVisWidth 的 "cell block" 追加
  const sepCells = textToCells(sep + ' ', S_DIM)

  // 将 token 字符串拆成单字符 cells（忽略 ANSI，只处理可见字符）
  // 简化：把整个 tokenText 作为一个 style-less raw output cell
  // 由于 token 状态文字含有多个样式段，采用逐字符分配的方式
  // 这里用更简单的做法：把 tokenText 写入最后一个 "special cell"，style = tokenText 本身
  // Cell 的 style 字段是前缀，char 是字符 — 我们把可见部分拆开

  // 解析 tokenText 为 (style, char) 对
  const tokenCells: Cell[] = []
  const ansiRegex = /\x1b\[[0-9;]*m/g
  let lastStyle = S_DIM
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = ansiRegex.exec(tokenText)) !== null) {
    // 写入 match 之前的可见字符
    const visChars = tokenText.slice(lastIndex, match.index)
    for (const ch of visChars) {
      tokenCells.push({ char: ch, style: lastStyle, width: 1 })
    }
    lastStyle = match[0]!
    lastIndex = match.index + match[0]!.length
  }
  // 剩余可见字符
  const remaining = tokenText.slice(lastIndex)
  for (const ch of remaining) {
    tokenCells.push({ char: ch, style: lastStyle, width: 1 })
  }

  return [...sepCells, ...tokenCells]
}

/**
 * 构建当前帧的 Cell 网格（全部行）：
 *   行0~N: streamingText 预览行（若 streamingText 非空）
 *   行N+1: Spinner 行（若 spinnerLabel 非 null）
 *   行N+2: 分隔线（含 token 状态栏，Task 11）
 *   行N+3~K: 输入框行（光标、换行）
 *   行K+1: notice 行（若 notice 非 null）
 */
function buildFrame(state: FrameState): Cell[][] {
  const { text, cursor, spinnerFrame, spinnerLabel, streamingText, notice, termWidth, tokenUsage } = state
  const rows: Cell[][] = []

  // 流式预览行（实时输出的文字，不进 scrollback）
  // 只显示最后一行（避免帧高随内容增长导致频繁滚动）
  if (streamingText) {
    const lines = streamingText.split('\n').filter((l) => l.length > 0)
    const lastLine = lines[lines.length - 1] ?? ''
    if (lastLine) {
      rows.push(textToCells(lastLine, S_DIM))
    }
  }

  // Spinner 行
  if (spinnerLabel) {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!
    const spinnerText = `${frame} ${spinnerLabel}`
    const spinnerCells = textToCells(spinnerText, S_SPINNER)
    rows.push(spinnerCells)
  }

  // 分隔线（含 Token 状态栏，Task 11）
  rows.push(buildSeparatorWithTokens(tokenUsage, termWidth))

  // 输入框行（带前缀 "❯ "）
  const prefix = '❯ '
  const prefixWidth = visualWidth(prefix)
  const inputWidth = Math.max(1, termWidth - prefixWidth)
  const inputRows = buildInputCells(text, cursor, inputWidth)
  for (let i = 0; i < inputRows.length; i++) {
    const prefixCells = i === 0 ? textToCells(prefix, S_DIM) : textToCells('  ', S_NONE)
    rows.push([...prefixCells, ...(inputRows[i] ?? [])])
  }

  // notice 行
  if (notice) {
    rows.push(textToCells(notice, S_DIM))
  }

  return rows
}

// ── 辅助：将帧差分写入 stdout ──────────────────────────────────────────────

/**
 * 比较当前帧与上一帧，生成最小化的 ANSI 更新序列。
 * 包含在 BSU/ESU_HIDE 之间以实现原子渲染。
 *
 * 关键约束：prev 和 next 的帧高必须相同（调用方负责在高度变化时传入空 prev）。
 * 这样所有行的绝对行号保持一致，cell diff 才有意义。
 *
 * CJK 宽字符处理：
 *   - cell 数组索引（c）≠ 视觉列（visualCol）
 *   - 用 visualCol 做绝对定位，用 c 遍历 cell 数组
 *   - prevRow 同样用视觉列对齐，否则 diff 比较错位
 */
function buildDiffWrite(prev: Cell[][], next: Cell[][], termRows: number): string {
  const h = next.length
  // 帧起始行（基于新帧高度，1-indexed）
  const frameTop = Math.max(1, termRows - h + 1)

  let buf = BSU

  for (let r = 0; r < h; r++) {
    const row = r + frameTop
    const prevRow = prev[r] ?? []
    const nextRow = next[r] ?? []
    // 同时追踪 nextRow 和 prevRow 的视觉列指针
    let visualCol = 1      // nextRow 当前 cell 的视觉列（1-indexed）
    let prevVisualCol = 1  // prevRow 的对应视觉列
    let prevIdx = 0        // prevRow 的遍历索引

    for (let c = 0; c < nextRow.length; c++) {
      const newCell = nextRow[c]!

      // 推进 prevRow 到视觉列对齐位置
      while (prevIdx < prevRow.length && prevVisualCol < visualCol) {
        prevVisualCol += prevRow[prevIdx]?.width ?? 1
        prevIdx++
      }
      const oldCell = prevVisualCol === visualCol ? prevRow[prevIdx] : undefined

      if (oldCell && cellsEqual(newCell, oldCell)) {
        visualCol += newCell.width
        continue
      }

      // 需要重绘：绝对定位 + 发射样式+字符
      buf += `\x1b[${row};${visualCol}H`
      buf += newCell.style
      buf += newCell.char

      visualCol += newCell.width
    }

    // 新行比旧行窄时，擦除旧行多余部分
    // 用 cell.width 求和得到精确的视觉宽度（不依赖 visualCol 的迭代值）
    let oldVisualWidth = 0
    for (const cell of prevRow) oldVisualWidth += cell.width
    let newVisualWidth = 0
    for (const cell of nextRow) newVisualWidth += cell.width
    if (newVisualWidth < oldVisualWidth) {
      // 不受 wroteAnythingInRow 限制：即使本行所有 cell 都没变，
      // 只要行宽缩短了（如光标块从末尾移走），就必须擦除旧行尾部
      buf += `\x1b[${row};${newVisualWidth + 1}H\x1b[K`
    }
  }

  buf += S_RESET
  buf += ESU_HIDE

  return buf
}

// ── 主组件 ────────────────────────────────────────────────────────────────

export function ChatInput({
  messages,
  onSubmit,
  onInterrupt,
  onPermissionKey,
  pendingPermission = false,
  isLoading = false,
  notice,
  disabled,
  spinnerLabel,
  streamingText,
  tokenUsage,
  isModelPicking = false,
  onPickerNavKey,
}: ChatInputProps): null {
  const [{ text, cursor }, dispatch] = useReducer(inputReducer, { text: '', cursor: 0 } as InputState)
  const cursorRef = useRef(0)
  useLayoutEffect(() => {
    cursorRef.current = cursor
  })

  // Spinner 动画（每 200ms 一帧）
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    if (!spinnerLabel) return
    const timer = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 200)
    return () => clearInterval(timer)
  }, [spinnerLabel])

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 80
  const termRows = stdout?.rows ?? 25

  // 帧状态 ref
  const prevFrameRef = useRef<Cell[][]>([])
  const lastFrameHRef = useRef(0)
  const writtenMessageCountRef = useRef(0)

  // 隐藏真实终端光标（用反色块代替）
  useEffect(() => {
    try {
      process.stdout.write('\x1b[?25l')
    } catch {
      /* tty closed */
    }
    return () => {
      try {
        process.stdout.write('\x1b[?25h')
      } catch {
        /* tty closed */
      }
    }
  }, [])

  // 终端 resize 时强制重绘
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!stdout) return
    const onResize = () => {
      prevFrameRef.current = []
      forceRender()
    }
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  // ── 主渲染 effect：提交新消息 + 绘制帧 ─────────────────────────────────

  useEffect(() => {
    // 1. 将新消息提交到 scrollback（append-only）
    let scrollbackContent = ''
    const captureWrite = (s: string) => {
      scrollbackContent += s
    }
    while (writtenMessageCountRef.current < messages.length) {
      const msg = messages[writtenMessageCountRef.current]!
      writeMessageToStdout(captureWrite, msg)
      writtenMessageCountRef.current++
    }

    // 2. 构建新帧
    const nextFrame = buildFrame({
      text,
      cursor,
      spinnerFrame,
      spinnerLabel: spinnerLabel ?? null,
      streamingText: streamingText ?? null,
      notice: notice ?? null,
      termWidth,
      tokenUsage: tokenUsage ?? null,
    })
    const nextH = nextFrame.length

    // 3. 帧高变化或有新 scrollback 内容时，强制全帧重绘
    //    帧高变化时所有行的绝对行号都改变，cell diff 失效，必须清空。
    const prevH = lastFrameHRef.current
    if (nextH !== prevH || scrollbackContent) {
      prevFrameRef.current = []
    }

    // 4-6. 统一处理滚动、scrollback 写入与帧渲染
    //
    // 设计原则：所有需要终端向上滚动的操作（帧高增加 + scrollback 内容写入）
    // 在同一次 `\x1b[${termRows};1H` + `\n` 中完成，避免双重滚动。
    //
    // 步骤：
    //   (A) 计算总滚动行数 = extraFrameRows（帧高增加）+ scrollbackRows（新消息行数）
    //   (B) 在终端末行发 totalScroll 个 \n → 一次性滚动
    //   (C) 若帧高缩小：清除旧帧多余行（帧缩小不需要额外滚动）
    //   (D) 若有 scrollback 内容：用绝对定位写入腾出的行
    //   (E) buildDiffWrite 全量/差分重绘帧到终端底部

    const scrollbackRows = scrollbackContent
      ? countContentRows(scrollbackContent, termWidth)
      : 0
    const extraFrameRows = nextH > prevH ? nextH - prevH : 0
    const totalScroll = extraFrameRows + scrollbackRows

    let setupBuf = ''

    if (totalScroll > 0) {
      // (B) 一次性在终端末行触发所有需要的滚动
      setupBuf += `\x1b[${termRows};1H` + '\n'.repeat(totalScroll)
    }

    if (nextH < prevH) {
      // (C) 帧缩小：清除旧帧多余行（滚动后位置）。
      // 滚动了 totalScroll 行后，旧帧多余行在
      //   termRows-prevH+1-totalScroll ~ termRows-nextH-totalScroll
      //   （即 scrollbackContent + 新帧的覆盖范围上方）
      // 必须手动清除，否则旧帧内容（如 spinner）残留可见。
      const clearFrom = Math.max(1, termRows - prevH + 1 - totalScroll)
      const clearTo = Math.max(0, termRows - nextH - totalScroll)
      for (let r = clearFrom; r <= clearTo; r++) {
        setupBuf += `\x1b[${r};1H\x1b[2K`
      }
    }

    if (scrollbackContent && scrollbackRows > 0) {
      // (D) 用绝对定位将 scrollbackContent 写入腾出的行
      // 滚动后，帧的目标是 termRows-nextH+1 ~ termRows（由 buildDiffWrite 绘制）
      // scrollback 内容紧贴帧上方，占用 termRows-nextH-scrollbackRows+1 ~ termRows-nextH 行
      const contentStart = Math.max(1, termRows - nextH - scrollbackRows + 1)
      setupBuf += `\x1b[${contentStart};1H`
      setupBuf += scrollbackContent
    }

    // (E) 生成帧差分写入序列（prevFrameRef=[] 时全量重绘）
    const diffWrite = buildDiffWrite(prevFrameRef.current, nextFrame, termRows)

    if (setupBuf || diffWrite !== BSU + S_RESET + ESU_HIDE) {
      try {
        process.stdout.write(setupBuf + diffWrite)
      } catch {
        /* tty closed */
      }
    }

    prevFrameRef.current = nextFrame
    lastFrameHRef.current = nextH
  })

  // ── 键盘输入处理 ──────────────────────────────────────────────────────

  usePromptInput({
    enabled: !disabled,
    onInterrupt,
    onText: (chunk) => {
      // 权限确认模式：优先处理 y/n，不受 isLoading 屏蔽
      if (pendingPermission && onPermissionKey) {
        const lower = chunk.toLowerCase()
        if (lower === 'y') {
          onPermissionKey('y')
          return
        }
        if (lower === 'n') {
          onPermissionKey('n')
          return
        }
      }
      if (isLoading) return // 加载时屏蔽输入（但 Ctrl+C 仍可用）
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
    },
    onPaste: (content) => {
      if (isLoading) return
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk: content })
    },
    onKey: (key) => {
      // ── 模型选择器模式：上下键/回车/Esc 路由到 picker，其他键忽略 ──────────
      if (isModelPicking && onPickerNavKey) {
        if (key === 'up' || key === 'down' || key === 'return' || key === 'escape') {
          const pickerKey = key === 'return' ? 'enter' : key as 'up' | 'down' | 'escape'
          onPickerNavKey(pickerKey)
          return
        }
        // 其他键在 picker 模式下忽略（避免误操作）
        return
      }

      switch (key) {
        case 'return': {
          if (isLoading) return
          const raw = text
          if (!raw.trim()) return
          onSubmit(raw)
          dispatch({ type: 'RESET' })
          break
        }
        case 'newline': {
          // Alt+Enter：插入换行符
          if (isLoading) return
          dispatch({ type: 'INSERT', pos: cursorRef.current, chunk: '\n' })
          break
        }
        case 'backspace': {
          if (isLoading) return
          dispatch({ type: 'BACKSPACE_REF', pos: cursorRef.current, deleteCount: 1 })
          break
        }
        case 'delete': {
          if (isLoading) return
          dispatch({ type: 'DELETE', pos: cursorRef.current })
          break
        }
        case 'left': {
          if (isLoading) return
          if (cursorRef.current > 0) {
            dispatch({ type: 'SET_CURSOR', cursor: cursorRef.current - 1 })
          }
          break
        }
        case 'right': {
          if (isLoading) return
          if (cursorRef.current < text.length) {
            dispatch({ type: 'SET_CURSOR', cursor: cursorRef.current + 1 })
          }
          break
        }
        case 'home': {
          if (isLoading) return
          dispatch({ type: 'SET_CURSOR', cursor: 0 })
          break
        }
        case 'end': {
          if (isLoading) return
          dispatch({ type: 'SET_CURSOR', cursor: text.length })
          break
        }
        case 'escape': {
          // 清空输入框
          if (isLoading) return
          dispatch({ type: 'RESET' })
          break
        }
      }
    },
  })

  // 向 Ink 返回 null：Ink 的动态区域永远为空，我们持有全部底部渲染
  return null
}

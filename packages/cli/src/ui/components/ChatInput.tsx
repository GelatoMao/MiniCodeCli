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

// ── 常量 ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
const MAX_INPUT_ROWS = 10

// ── Props ─────────────────────────────────────────────────────────────────

export interface ChatInputProps {
  /**
   * 所有 scrollback 消息。新条目通过直接写 stdout 提交到终端历史。
   * 我们持有整个底部区域 —— Ink 不得再写 scrollback，否则其
   * log-update 会与我们争夺光标位置。
   */
  messages: readonly DisplayMessage[]
  onSubmit: (text: string) => void
  onInterrupt: () => void
  /** true = AI 请求/工具运行中，驱动 spinner 显示和 Esc 取消路由 */
  isLoading?: boolean
  /** 临时一行通知（如"再按 Ctrl+C 退出"），显示在输入框下方 */
  notice?: string | null
  /** 禁用键盘输入（并隐藏输入光标） */
  disabled?: boolean
  /** Spinner 文字（如"Thinking…"），null/undefined = 不显示 */
  spinnerLabel?: string | null
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
  notice: string | null
  termWidth: number
}

/**
 * 构建当前帧的 Cell 网格（全部行）：
 *   行0~N: 分隔线（可选）
 *   行N+1~M: Spinner 行（若 spinnerLabel 非 null）
 *   行M+1~K: 输入框行（光标、换行）
 *   行K+1: notice 行（若 notice 非 null）
 */
function buildFrame(state: FrameState): Cell[][] {
  const { text, cursor, spinnerFrame, spinnerLabel, notice, termWidth } = state
  const rows: Cell[][] = []

  // Spinner 行
  if (spinnerLabel) {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!
    const spinnerText = `${frame} ${spinnerLabel}`
    const spinnerCells = textToCells(spinnerText, S_SPINNER)
    rows.push(spinnerCells)
  }

  // 分隔线（细灰色）
  const sep = '─'.repeat(Math.max(0, termWidth))
  rows.push(textToCells(sep, S_DIM))

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
  isLoading = false,
  notice,
  disabled,
  spinnerLabel,
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
      notice: notice ?? null,
      termWidth,
    })
    const nextH = nextFrame.length

    // 3. 帧高变化或有新 scrollback 内容时，强制全帧重绘
    //    帧高变化时所有行的绝对行号都改变，cell diff 失效，必须清空。
    const prevH = lastFrameHRef.current
    if (nextH !== prevH || scrollbackContent) {
      prevFrameRef.current = []
    }

    // 4. 若有新 scrollback 内容，预先滚动为其腾出行
    let preBuf = ''
    if (scrollbackContent) {
      const rows = countContentRows(scrollbackContent, termWidth)
      if (rows > 0) {
        preBuf += `\x1b[${termRows};1H` + '\n'.repeat(rows)
      }
      preBuf += scrollbackContent
    }

    // 5. 生成帧差分写入序列
    const diffWrite = buildDiffWrite(prevFrameRef.current, nextFrame, termRows)

    // 6. 原子写入
    let setupBuf = ''
    if (nextH > prevH) {
      // 帧高增加（如 spinner 出现）：
      // 先滚动腾出新增的行，再清空整个新帧区域（避免旧终端内容透出）。
      const extraRows = nextH - prevH
      // 滚动：把光标停在终端最后一行并发 \n，使内容上移腾出空间
      setupBuf = `\x1b[${termRows};1H` + '\n'.repeat(extraRows)
      // 清空整个新帧区域（termRows - nextH + 1 到 termRows）
      const newFrameTop = Math.max(1, termRows - nextH + 1)
      for (let r = 0; r < nextH; r++) {
        setupBuf += `\x1b[${newFrameTop + r};1H\x1b[2K`
      }
    } else if (nextH < prevH) {
      // 帧高缩小（如 spinner 消失）：
      // 先清除整个旧帧区域（所有 prevH 行），再全量重绘新帧。
      // 旧帧起始行 = termRows - prevH + 1
      const oldFrameTop = Math.max(1, termRows - prevH + 1)
      for (let r = 0; r < prevH; r++) {
        setupBuf += `\x1b[${oldFrameTop + r};1H\x1b[2K`
      }
    }

    if (setupBuf || preBuf || diffWrite !== BSU + S_RESET + ESU_HIDE) {
      try {
        process.stdout.write(setupBuf + preBuf + diffWrite)
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
      if (isLoading) return // 加载时屏蔽输入（但 Ctrl+C 仍可用）
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk })
    },
    onPaste: (content) => {
      if (isLoading) return
      dispatch({ type: 'INSERT', pos: cursorRef.current, chunk: content })
    },
    onKey: (key) => {
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

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
 */
function buildDiffWrite(prev: Cell[][], next: Cell[][], termRows: number): string {
  const h = next.length
  // 帧起始行（基于 termRows，1-indexed）
  const frameTop = Math.max(1, termRows - h + 1)

  let buf = BSU

  for (let r = 0; r < h; r++) {
    const row = r + frameTop
    const prevRow = prev[r] ?? []
    const nextRow = next[r] ?? []
    const maxCols = Math.max(prevRow.length, nextRow.length)
    let wroteAnythingInRow = false

    for (let c = 0; c < nextRow.length; c++) {
      const newCell = nextRow[c]!
      const oldCell = prevRow[c]

      if (oldCell && cellsEqual(newCell, oldCell)) {
        // CJK 宽字符：跳过第二个"半格"（宽度为 2 时由前一格覆盖）
        if (newCell.width === 2) c++
        continue
      }

      // 需要重绘此格：移动光标并发射样式+字符
      // 计算列位置（1-indexed）
      let visualCol = 1
      for (let ci = 0; ci < c; ci++) visualCol += nextRow[ci]?.width ?? 1

      buf += `\x1b[${row};${visualCol}H` // CUP（绝对定位）
      buf += newCell.style
      buf += newCell.char
      wroteAnythingInRow = true

      if (newCell.width === 2) c++ // 跳过宽字符的第二半格
    }

    // 若新行比旧行短，擦除旧行多余的部分
    if (nextRow.length < prevRow.length && wroteAnythingInRow) {
      let newVisualWidth = 0
      for (const c of nextRow) newVisualWidth += c.width
      buf += `\x1b[${row};${newVisualWidth + 1}H\x1b[K` // 擦除到行尾
    }
    void maxCols // 防止 lint 未使用警告
  }

  // 将光标停在输入框最后一行末尾（DEC 2026 ESU 前的停泊位置）
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

    // 3. 当帧高度变化或有新 scrollback 内容时，需要重新定位
    const prevH = lastFrameHRef.current
    if (nextH !== prevH || scrollbackContent) {
      prevFrameRef.current = [] // 强制全帧重绘
    }

    // 4. 若有新 scrollback 内容，预先滚动为其腾出行
    let preBuf = ''
    if (scrollbackContent) {
      const rows = countContentRows(scrollbackContent, termWidth)
      if (rows > 0) {
        // 跳到终端最后一行并发射 LF，把内容区域向上推
        preBuf += `\x1b[${termRows};1H` + '\n'.repeat(rows)
      }
      // 然后写入 scrollback 内容
      preBuf += scrollbackContent
    }

    // 5. 生成帧差分写入序列
    const diffWrite = buildDiffWrite(prevFrameRef.current, nextFrame, termRows)

    // 6. 原子写入（滚动/内容 + 帧更新）
    if (preBuf || diffWrite !== BSU + S_RESET + ESU_HIDE) {
      // 确保帧区域已存在（首次绘制需要腾出 nextH 行）
      let setupBuf = ''
      if (prevH === 0 && nextH > 0) {
        setupBuf = `\x1b[${termRows};1H` + '\n'.repeat(nextH - 1)
      }
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

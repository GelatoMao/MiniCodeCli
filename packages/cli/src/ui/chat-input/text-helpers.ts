// @mini-code-cli/cli — ChatInput cell-diff 渲染器的宽度/路径/ANSI 辅助函数
//
// `isWide` / `charWidth` / `visualWidth` / `sliceByWidth` 位于
// `../../text-width.ts` — 作为 chat-input frame、scrollback diff、
// markdown 表格布局的唯一真相来源。本模块在这些原语之上构建。
//
// Task 8 — 直接采用 x-code-cli 原实现。
import { charWidth, visualWidth } from '../text-width.js'
import type { Cell } from './cells.js'

const GLYPH_ELLIPSIS = '…'

// ── Cell 行截断与自动换行 ─────────────────────────────────────────────────

/**
 * 截断 Cell 行，使其视觉宽度不超过 maxWidth。
 * 当最后一个 cell 被截断时，用 `…` 替代。
 */
export function truncateCellRow(cells: Cell[], maxWidth: number): Cell[] {
  let w = 0
  for (let i = 0; i < cells.length; i++) {
    if (w + cells[i]!.width > maxWidth) {
      const truncated = cells.slice(0, i)
      if (w + 1 <= maxWidth) {
        truncated.push({ char: GLYPH_ELLIPSIS, style: cells[i]!.style, width: 1 })
      }
      return truncated
    }
    w += cells[i]!.width
  }
  return cells
}

/**
 * 将 cells 硬换行为最多 maxRows 行，每行宽度不超过 maxWidth。
 * 内容超出行数预算时，截断最后一行并附加省略号。
 * 按字符换行（无词边界）——与 `truncateCellRow` 相同的模型，只是多行。
 */
export function wrapCellsToRows(cells: Cell[], maxWidth: number, maxRows: number): Cell[][] {
  if (maxRows <= 0 || maxWidth <= 0) return []
  const rows: Cell[][] = []
  let current: Cell[] = []
  let currentWidth = 0
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!
    if (currentWidth + c.width > maxWidth) {
      rows.push(current)
      if (rows.length >= maxRows) {
        const last = rows[rows.length - 1]!
        let lastW = currentWidth
        const ellipsisStyle = last.length > 0 ? last[last.length - 1]!.style : c.style
        while (last.length > 0 && lastW + 1 > maxWidth) {
          lastW -= last.pop()!.width
        }
        last.push({ char: GLYPH_ELLIPSIS, style: ellipsisStyle, width: 1 })
        return rows
      }
      current = []
      currentWidth = 0
    }
    current.push(c)
    currentWidth += c.width
  }
  if (current.length > 0) rows.push(current)
  return rows
}

// ── 字符串导航 ────────────────────────────────────────────────────────────

/**
 * 返回跳过 skipCols 视觉列后的字节偏移量（用于光标定位）。
 */
export function skipByWidth(str: string, skipCols: number): number {
  let w = 0,
    i = 0
  for (const ch of str) {
    if (w >= skipCols) break
    w += charWidth(ch)
    i += ch.length
  }
  return i
}

// ── 路径截断 ──────────────────────────────────────────────────────────────

/**
 * 从头部截断 slash 分隔的路径，使 basename 始终保留。
 * `packages/core/src/agent/very-long-name.ts` → `…/agent/very-long-name.ts`
 * 仅用于 @-补全菜单。如果 basename 本身超出则尾部截断。
 */
export function truncatePathFromStart(p: string, maxCols: number): string {
  if (visualWidth(p) <= maxCols) return p
  const segs = p.split('/')
  const basename = segs[segs.length - 1] ?? ''
  if (visualWidth(basename) >= maxCols - 1) {
    return '…' + basename.slice(basename.length - Math.max(1, maxCols - 1))
  }
  let acc = basename
  for (let i = segs.length - 2; i >= 0; i--) {
    const next = segs[i] + '/' + acc
    if (visualWidth('…/' + next) > maxCols) break
    acc = next
  }
  return '…/' + acc
}

// ── ANSI 剥离与行计数 ─────────────────────────────────────────────────────

/**
 * 剥离 ANSI CSI + OSC 转义序列，使视觉宽度计算忽略控制码。
 * 用于统计 scrollback 载荷占用的终端行数，以驱动预滚动行数计算。
 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

/**
 * 统计 content 从空白区域顶部写下时占用的显示行数。
 * 使用 CJK 感知的视觉宽度在 termWidth 处计算换行。
 * 末尾的 `\n` 不计为一行（光标仅前进到下一行，该行无内容）。
 */
export function countContentRows(content: string, termWidth: number): number {
  const clean = stripAnsi(content).replace(/\r\n/g, '\n').replace(/\r/g, '')
  const lines = clean.split('\n')
  const effective = clean.endsWith('\n') ? lines.slice(0, -1) : lines
  const w = Math.max(1, termWidth)
  let rows = 0
  for (const line of effective) {
    rows += Math.max(1, Math.ceil(visualWidth(line) / w))
  }
  return rows
}

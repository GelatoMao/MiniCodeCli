// @mini-code-cli/cli — Cell 表示 + cell 构建器
//
// 每一帧是一个 Cell 二维网格。ChatInput.tsx 的 diff 循环遍历网格，
// 仅为 (char, style) 对相比上一帧有变化的 cell 发射 SGR/文字字节。
// `width` 让 diff 循环跳过 CJK 宽字符的第二个"半格"，避免重复发射。
//
// Task 8 — 直接采用 x-code-cli 原实现。
import { charWidth } from '../text-width.js'
import { S_NONE } from './palette.js'

// ── 核心类型 ──────────────────────────────────────────────────────────────

export interface Cell {
  char: string
  style: string
  /** 终端视觉宽度：普通字符 = 1，CJK 宽字符 = 2 */
  width: number
}

/** Cell 行（一维数组） */
export type CellRow = Cell[]

/** Cell 网格（二维数组） */
export type CellGrid = CellRow[]

// ── 比较 ──────────────────────────────────────────────────────────────────

/** 判断两个 cell 是否视觉相等（char + style 均相同）。 */
export function cellsEqual(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style
}

// ── 渲染到 ANSI 字符串 ───────────────────────────────────────────────────

/**
 * 将一行 cell 渲染为单条 ANSI 带样式字符串（无光标移动，无尾部擦除）。
 * 用于 scrollback-commit 内联流式路径：frame 行可作为 `content + frame` 流的一部分发射。
 */
export function renderRowToAnsi(cells: Cell[]): string {
  let out = '\x1b[0m'
  let lastStyle = '\x1b[0m'
  for (const cell of cells) {
    if (cell.style !== lastStyle) {
      out += cell.style
      lastStyle = cell.style
    }
    out += cell.char
  }
  return out + '\x1b[0m'
}

// ── Cell 构建器 ───────────────────────────────────────────────────────────

/** 将纯文本字符串转换为 Cell 数组（所有 cell 使用相同样式）。 */
export function textToCells(text: string, style: string): Cell[] {
  const cells: Cell[] = []
  for (const ch of text) cells.push({ char: ch, style, width: charWidth(ch) })
  return cells
}

/**
 * 将已含 ANSI SGR 转义的字符串解析为 Cell 数组。
 * 用于 select-options 对话框的预览面板：
 * 由 render-diff 构建的含丰富颜色转义的预览行可直接绘入 cell buffer，
 * 每个 char 携带其正确的激活样式。
 *
 * 每个 cell 的 `style` = `\x1b[0m` + 当前激活的所有 SGR 转义拼接 ——
 * cell-diff 发射器依赖于每个 cell 的样式是"自含"的（它直接发射
 * `cell.style`，无需先重置），因此始终以重置开头以清除前一个 cell
 * 遗留的 SGR 状态。
 */
export function ansiTextToCells(text: string): Cell[] {
  const cells: Cell[] = []
  const active: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\x1b' && text[i + 1] === '[') {
      let j = i + 2
      while (j < text.length && !/[A-Za-z]/.test(text[j]!)) j++
      if (j >= text.length) {
        // 未完成的转义 —— 作为普通字符处理并退出转义模式
        i++
        continue
      }
      const escape = text.slice(i, j + 1)
      if (/^\x1b\[0?m$/.test(escape)) {
        active.length = 0 // SGR 重置
      } else if (/^\x1b\[[0-9;]*m$/.test(escape)) {
        active.push(escape) // 颜色 / 属性 SGR
      }
      // 非 SGR 的 CSI 序列直接跳过
      i = j + 1
      continue
    }
    const style = active.length === 0 ? S_NONE : '\x1b[0m' + active.join('')
    cells.push({ char: ch, style, width: charWidth(ch) })
    i++
  }
  return cells
}

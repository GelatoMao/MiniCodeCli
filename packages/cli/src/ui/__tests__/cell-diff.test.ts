// 测试 cell-diff 渲染引擎的核心行为：
//   1. CJK 宽字符不丢字（修复 `if (width===2) c++` 的错误跳跃）
//   2. 视觉列对齐（CJK + ASCII 混合行的 diff 定位正确）
//   3. 行尾擦除（新行比旧行窄时正确发 \x1b[K）
//   4. 全量重绘（prevRow 为空时每个 cell 都被发射）

import { describe, it, expect } from 'vitest'
import type { Cell } from '../chat-input/cells.js'
import { cellsEqual } from '../chat-input/cells.js'
import { BSU, ESU_HIDE, S_NONE, S_RESET, S_CURSOR } from '../chat-input/palette.js'

// ── 内联 buildDiffWrite，与 ChatInput.tsx 完全一致 ─────────────────────────
// 避免 import ChatInput.tsx（它依赖 Ink/process.stdout 等环境）。
// 若 ChatInput.tsx 的实现有变更，这里也需要同步更新。

function buildDiffWrite(prev: Cell[][], next: Cell[][], termRows: number): string {
  const h = next.length
  const frameTop = Math.max(1, termRows - h + 1)
  let buf = BSU
  for (let r = 0; r < h; r++) {
    const row = r + frameTop
    const prevRow = prev[r] ?? []
    const nextRow = next[r] ?? []
    let visualCol = 1
    let prevVisualCol = 1
    let prevIdx = 0
    for (let c = 0; c < nextRow.length; c++) {
      const newCell = nextRow[c]!
      while (prevIdx < prevRow.length && prevVisualCol < visualCol) {
        prevVisualCol += prevRow[prevIdx]?.width ?? 1
        prevIdx++
      }
      const oldCell = prevVisualCol === visualCol ? prevRow[prevIdx] : undefined
      if (oldCell && cellsEqual(newCell, oldCell)) {
        visualCol += newCell.width
        continue
      }
      buf += `\x1b[${row};${visualCol}H`
      buf += newCell.style
      buf += newCell.char
      visualCol += newCell.width
    }
    let oldVisualWidth = 0
    for (const cell of prevRow) oldVisualWidth += cell.width
    let newVisualWidth = 0
    for (const cell of nextRow) newVisualWidth += cell.width
    if (newVisualWidth < oldVisualWidth) {
      buf += `\x1b[${row};${newVisualWidth + 1}H\x1b[K`
    }
  }
  buf += S_RESET
  buf += ESU_HIDE
  return buf
}

// ── 辅助 ──────────────────────────────────────────────────────────────────

/** 从 ANSI 序列中提取所有 CUP 定位坐标（row, col）和对应发射的字符 */
function extractPlacements(seq: string): Array<{ row: number; col: number; char: string }> {
  const result: Array<{ row: number; col: number; char: string }> = []
  // 匹配 \x1b[R;CH 后紧跟的样式转义和字符
  const re = /\x1b\[(\d+);(\d+)H((?:\x1b\[[^A-Za-z]*[A-Za-z])*)(.)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(seq)) !== null) {
    result.push({ row: Number(m[1]), col: Number(m[2]), char: m[4]! })
  }
  return result
}

/** 提取 ANSI 序列中所有 \x1b[R;CH\x1b[K 的擦除列 */
function extractErases(seq: string): Array<{ row: number; col: number }> {
  const result: Array<{ row: number; col: number }> = []
  const re = /\x1b\[(\d+);(\d+)H\x1b\[K/g
  let m: RegExpExecArray | null
  while ((m = re.exec(seq)) !== null) {
    result.push({ row: Number(m[1]), col: Number(m[2]) })
  }
  return result
}

function makeCell(char: string, style = S_NONE): Cell {
  const width = char.codePointAt(0)! >= 0x4e00 && char.codePointAt(0)! <= 0x9fff ? 2 : 1
  return { char, style, width }
}

// ── 测试 ──────────────────────────────────────────────────────────────────

describe('buildDiffWrite — CJK 宽字符不丢字', () => {
  it('纯 CJK 行全量重绘时，每个汉字都被发射，且列位置正确', () => {
    const row: Cell[] = ['你', '好', '世', '界'].map((c) => makeCell(c))
    const seq = buildDiffWrite([], [row], 24)
    const placements = extractPlacements(seq)

    // 4 个汉字都应出现
    expect(placements.map((p) => p.char)).toEqual(['你', '好', '世', '界'])
    // 视觉列：你@1，好@3，世@5，界@7
    expect(placements.map((p) => p.col)).toEqual([1, 3, 5, 7])
  })

  it('CJK + ASCII 混合行全量重绘，列位置正确', () => {
    // "你a好b" → 你(2)+a(1)+好(2)+b(1) = 列 1,3,4,6
    const row: Cell[] = [
      makeCell('你'), makeCell('a'), makeCell('好'), makeCell('b'),
    ]
    const seq = buildDiffWrite([], [row], 24)
    const placements = extractPlacements(seq)

    expect(placements.map((p) => p.char)).toEqual(['你', 'a', '好', 'b'])
    expect(placements.map((p) => p.col)).toEqual([1, 3, 4, 6])
  })

  it('光标块（宽 1）在 CJK 字符中间时列位置正确', () => {
    // "你▋好" — 光标在'好'前面
    const row: Cell[] = [
      makeCell('你'),
      { char: ' ', style: S_CURSOR, width: 1 }, // 光标块
      makeCell('好'),
    ]
    const seq = buildDiffWrite([], [row], 24)
    const placements = extractPlacements(seq)

    expect(placements.map((p) => p.char)).toEqual(['你', ' ', '好'])
    expect(placements.map((p) => p.col)).toEqual([1, 3, 4])
  })
})

describe('buildDiffWrite — diff 跳过未变更 cell', () => {
  it('相同内容的行不发射任何 CUP 序列', () => {
    const row: Cell[] = ['a', 'b', 'c'].map((c) => makeCell(c))
    const seq = buildDiffWrite([row], [row], 24)
    const placements = extractPlacements(seq)
    expect(placements).toHaveLength(0)
  })

  it('CJK 行，只有一个字符变化时只发射那一个', () => {
    const prev: Cell[] = ['你', '好', '世'].map((c) => makeCell(c))
    const next: Cell[] = ['你', '坏', '世'].map((c) => makeCell(c))
    const seq = buildDiffWrite([prev], [next], 24)
    const placements = extractPlacements(seq)

    // 只有'坏'需要重绘，列 = 3（你占 2 列，坏从第 3 列开始）
    expect(placements).toHaveLength(1)
    expect(placements[0]).toEqual({ row: 24, col: 3, char: '坏' })
  })

  it('CJK+ASCII 混合行，只有 ASCII 部分变化时正确定位', () => {
    // "你aX" → "你aY"，只有 Y 列位置 = 1+2+1 = 4
    const prev: Cell[] = [makeCell('你'), makeCell('a'), makeCell('X')]
    const next: Cell[] = [makeCell('你'), makeCell('a'), makeCell('Y')]
    const seq = buildDiffWrite([prev], [next], 24)
    const placements = extractPlacements(seq)

    expect(placements).toHaveLength(1)
    expect(placements[0]).toEqual({ row: 24, col: 4, char: 'Y' })
  })
})

describe('buildDiffWrite — 行尾擦除', () => {
  it('新行比旧行窄时，在正确位置发射 \\x1b[K', () => {
    // prev: "abc"（3列），next: "a"（1列）
    const prev: Cell[] = ['a', 'b', 'c'].map((c) => makeCell(c))
    const next: Cell[] = [makeCell('a')]
    const seq = buildDiffWrite([prev], [next], 24)
    const erases = extractErases(seq)

    expect(erases).toHaveLength(1)
    expect(erases[0]).toEqual({ row: 24, col: 2 }) // 新宽度 1，从第 2 列擦除
  })

  it('CJK 行缩短时，擦除列按视觉宽度计算', () => {
    // prev: "你好"（4列），next: "你"（2列）
    const prev: Cell[] = ['你', '好'].map((c) => makeCell(c))
    const next: Cell[] = [makeCell('你')]
    const seq = buildDiffWrite([prev], [next], 24)
    const erases = extractErases(seq)

    expect(erases).toHaveLength(1)
    expect(erases[0]).toEqual({ row: 24, col: 3 }) // 新宽度 2，从第 3 列擦除
  })

  it('新行比旧行宽时，不发射 \\x1b[K', () => {
    const prev: Cell[] = [makeCell('a')]
    const next: Cell[] = ['a', 'b', 'c'].map((c) => makeCell(c))
    const seq = buildDiffWrite([prev], [next], 24)
    const erases = extractErases(seq)
    expect(erases).toHaveLength(0)
  })

  it('光标块移走后（行宽缩短），即使 cell 内容未变也发射擦除', () => {
    // prev: "ab▋"（光标在末尾，宽 3）
    // next: "ab" + 无光标（宽 2，光标移走了）
    const prev: Cell[] = [makeCell('a'), makeCell('b'), { char: ' ', style: S_CURSOR, width: 1 }]
    const next: Cell[] = [makeCell('a'), makeCell('b')]
    const seq = buildDiffWrite([prev], [next], 24)
    const erases = extractErases(seq)

    expect(erases).toHaveLength(1)
    expect(erases[0]).toEqual({ row: 24, col: 3 })
  })
})

describe('buildDiffWrite — 多行 frameTop 计算', () => {
  it('2 行帧在 termRows=10 时，第一行在第 9 行', () => {
    const rowA: Cell[] = ['a'].map((c) => makeCell(c))
    const rowB: Cell[] = ['b'].map((c) => makeCell(c))
    const seq = buildDiffWrite([], [rowA, rowB], 10)
    const placements = extractPlacements(seq)

    // frameTop = 10 - 2 + 1 = 9
    expect(placements[0]).toMatchObject({ row: 9, char: 'a' })
    expect(placements[1]).toMatchObject({ row: 10, char: 'b' })
  })
})

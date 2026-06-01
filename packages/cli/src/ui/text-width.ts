// @mini-code-cli/cli — CJK 双宽字符宽度计算
//
// JavaScript 的 string.length 统计 UTF-16 编码单元数，
// 但终端将东亚宽字符（CJK）渲染为两个单元格宽度。
// 不正确处理会导致光标偏移和行对齐错误。
//
// 覆盖范围参考 Unicode East_Asian_Width = Wide / Fullwidth 标准。
// 单一来源——chat-input frame、scrollback diff、markdown 表格对齐均用此模块。
//
// Task 8 — 直接采用 x-code-cli 原实现（无改动）。

export function isWide(cp: number): boolean {
  return (
    // CJK Unified Ideographs + Extension A + Compatibility Ideographs
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Hangul: Jamo + Syllables
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // Halfwidth and Fullwidth Forms
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK Extensions B-F
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    // CJK Radicals Supplement + Kangxi Radicals + Ideographic Description
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    // CJK Symbols + Hiragana + Katakana + Bopomofo + Enclosed CJK + Compatibility
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    // Yi Syllables + Yi Radicals
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // CJK Compatibility Forms
    (cp >= 0xfe30 && cp <= 0xfe4f)
  )
}

/** 返回字符 ch 的终端显示宽度（1 或 2） */
export function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}

/** 返回字符串的终端视觉宽度（CJK 感知） */
export function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

/**
 * 取 str 的最长前缀，使其视觉宽度不超过 maxCols。
 * 遇到宽字符恰好跨越边界时，在该字符之前截断——绝不拆分宽字符。
 */
export function sliceByWidth(str: string, maxCols: number): string {
  let w = 0
  let i = 0
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}

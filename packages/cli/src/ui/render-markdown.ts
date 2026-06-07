// @mini-code-cli/cli — 终端 Markdown 渲染器
//
// Task 11：将 AI 回复中的 Markdown 转换为带 ANSI 颜色的终端文字。
//
// 设计决策：
//   - 使用 marked 将 Markdown 解析为 Token 序列（Lexer 级别，不需要完整 HTML 渲染）
//   - 使用 chalk 的 ANSI 转义序列输出彩色文字
//   - 代码块委托给 syntax-highlight.ts 处理
//   - 折行宽度由 process.stdout.columns 决定（默认 80）
//
// 渲染规则：
//   - # 标题：chalk.bold + 对应颜色（h1=cyan, h2=blue, h3=white）
//   - 列表：• 符号（无序）/ 1. 2. 3.（有序）
//   - 引用：灰色竖线 + 斜体
//   - 代码块：语法高亮（syntax-highlight.ts）
//   - 行内代码：chalk.cyan 背景
//   - 粗体/斜体：chalk.bold / chalk.italic
//   - 水平线：─ 字符串
//   - 链接：文字保留，URL 用灰色括号标注
//   - 段落间距：段落之间保留空行
//
// 重要约束：
//   - 终端宽度感知折行（宽字符/CJK 保持正确）
//   - 输出字符串末尾不带多余换行（由调用方控制间距）

import { marked, type Token, type Tokens } from 'marked'
import chalk from 'chalk'

import { highlightCode } from './syntax-highlight.js'

// ── 宽度常量 ─────────────────────────────────────────────────────────────────

/** 终端宽度（折行宽度），每次调用时读取，以跟踪 resize */
function termWidth(): number {
  return process.stdout.columns ?? 80
}

// ── ANSI 颜色常量（与 palette.ts / stdout-writer.ts 保持一致）────────────────

const C_RESET = '\x1b[0m'
const C_BOLD = '\x1b[1m'
const C_DIM = '\x1b[2m'
const C_ITALIC = '\x1b[3m'
const C_GRAY = '\x1b[38;2;136;136;136m'
const C_GRAY_90 = '\x1b[90m'
const C_CYAN = '\x1b[38;2;80;210;210m'     // h1 标题
const C_BLUE = '\x1b[38;2;147;165;255m'    // h2 标题
const C_WHITE = '\x1b[38;2;220;220;220m'   // h3 标题
const C_INLINE_CODE_BG = '\x1b[48;2;45;45;55m'  // 行内代码背景

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

/**
 * 在终端折行宽度内对文字进行软折行。
 * 对于已含 ANSI 转义的文字，按可见字符宽度（近似）计算列数。
 * 不处理 CJK 宽字符（这些内容在 stdout-writer 写入时已固定宽度）。
 *
 * 注意：这是粗略折行，主要用于纯文字段落，代码块不经过此函数。
 */
function wrapText(text: string, maxWidth: number, indent = ''): string {
  if (maxWidth <= 10) return text
  const indentWidth = indent.length
  const effectiveWidth = maxWidth - indentWidth

  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  let currentLen = 0

  for (const word of words) {
    // 去掉 ANSI 转义来估算可见长度
    const visibleWord = word.replace(/\x1b\[[0-9;]*m/g, '')
    const wLen = visibleWord.length

    if (currentLen > 0 && currentLen + 1 + wLen > effectiveWidth) {
      lines.push(indent + current)
      current = word
      currentLen = wLen
    } else {
      if (currentLen > 0) {
        current += ' ' + word
        currentLen += 1 + wLen
      } else {
        current = word
        currentLen = wLen
      }
    }
  }
  if (current) {
    lines.push(indent + current)
  }

  return lines.join('\n')
}

/**
 * 渲染行内元素（粗体、斜体、行内代码、链接等）。
 * 递归处理 marked 的 inline token 数组。
 */
function renderInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''

  return tokens
    .map((tok) => {
      switch (tok.type) {
        case 'text': {
          const t = tok as Tokens.Text
          // text token 可能还有子 token（如 escape）
          if (t.tokens && t.tokens.length > 0) {
            return renderInline(t.tokens as Token[])
          }
          return tok.raw ?? ''
        }
        case 'strong': {
          const t = tok as Tokens.Strong
          return `${C_BOLD}${renderInline(t.tokens as Token[])}${C_RESET}`
        }
        case 'em': {
          const t = tok as Tokens.Em
          return `${C_ITALIC}${renderInline(t.tokens as Token[])}${C_RESET}`
        }
        case 'codespan': {
          const t = tok as Tokens.Codespan
          return `${C_INLINE_CODE_BG}${C_CYAN} ${t.text} ${C_RESET}`
        }
        case 'link': {
          const t = tok as Tokens.Link
          const text = renderInline(t.tokens as Token[])
          if (t.href && t.href !== text) {
            return `${text}${C_GRAY}(${t.href})${C_RESET}`
          }
          return text
        }
        case 'image': {
          const t = tok as Tokens.Image
          return `${C_GRAY}[图片: ${t.title ?? t.text ?? t.href}]${C_RESET}`
        }
        case 'del': {
          const t = tok as Tokens.Del
          return `${C_DIM}~~${renderInline(t.tokens as Token[])}~~${C_RESET}`
        }
        case 'br': {
          return '\n'
        }
        case 'escape': {
          const t = tok as Tokens.Escape
          return t.text ?? ''
        }
        case 'html': {
          // 忽略行内 HTML
          return ''
        }
        default:
          return tok.raw ?? ''
      }
    })
    .join('')
}

/**
 * 渲染列表（有序 / 无序，支持嵌套）。
 */
function renderList(token: Tokens.List, indentLevel = 0): string {
  const indent = '  '.repeat(indentLevel)
  const lines: string[] = []
  // token.start 可能是 false（无序列表）或 number（有序列表起始值）
  let itemIndex: number = typeof token.start === 'number' ? token.start : 1

  for (const item of token.items) {
    // 确定项目符号
    const bullet = token.ordered
      ? `${C_GRAY}${itemIndex}.${C_RESET} `
      : `${C_GRAY}•${C_RESET} `
    itemIndex++

    const itemIndent = indent + (token.ordered ? '  ' : ' ')

    // 渲染 item 内的 tokens
    const itemParts: string[] = []
    for (const subTok of (item.tokens ?? []) as Token[]) {
      if (subTok.type === 'text') {
        const t = subTok as Tokens.Text
        const text = t.tokens ? renderInline(t.tokens as Token[]) : (t.text ?? '')
        itemParts.push(text)
      } else if (subTok.type === 'list') {
        // 嵌套列表：递归渲染，加一级缩进
        itemParts.push('\n' + renderList(subTok as Tokens.List, indentLevel + 1))
      } else if (subTok.type === 'paragraph') {
        const t = subTok as Tokens.Paragraph
        const text = renderInline(t.tokens as Token[])
        itemParts.push(text)
      } else {
        itemParts.push(subTok.raw ?? '')
      }
    }

    const firstLine = itemParts[0] ?? ''
    const rest = itemParts.slice(1).join('\n')

    lines.push(`${indent}${bullet}${firstLine}`)
    if (rest) {
      lines.push(rest)
    }
  }

  return lines.join('\n')
}

/**
 * 渲染单个块级 Token 为终端字符串。
 * 返回的字符串不含结尾换行（调用方负责添加换行和间距）。
 */
function renderToken(token: Token): string | null {
  switch (token.type) {
    // ── 标题 ────────────────────────────────────────────────────────────────
    case 'heading': {
      const t = token as Tokens.Heading
      const text = renderInline(t.tokens as Token[])
      const width = termWidth()

      switch (t.depth) {
        case 1: {
          // H1：全大写 + 粗体青色 + 下划线行
          const underline = '━'.repeat(Math.min(visualLength(text), width))
          return `${C_CYAN}${C_BOLD}${text}${C_RESET}\n${C_CYAN}${underline}${C_RESET}`
        }
        case 2: {
          // H2：粗体蓝色 + 虚线
          const underline = '─'.repeat(Math.min(visualLength(text), width))
          return `${C_BLUE}${C_BOLD}${text}${C_RESET}\n${C_GRAY}${underline}${C_RESET}`
        }
        case 3: {
          // H3：粗体白色
          return `${C_WHITE}${C_BOLD}### ${text}${C_RESET}`
        }
        default: {
          // H4+：灰色粗体
          return `${C_GRAY}${C_BOLD}${'#'.repeat(t.depth)} ${text}${C_RESET}`
        }
      }
    }

    // ── 段落 ────────────────────────────────────────────────────────────────
    case 'paragraph': {
      const t = token as Tokens.Paragraph
      const text = renderInline(t.tokens as Token[])
      return wrapText(text, termWidth())
    }

    // ── 代码块 ──────────────────────────────────────────────────────────────
    case 'code': {
      const t = token as Tokens.Code
      return highlightCode(t.text, t.lang ?? '')
    }

    // ── 引用 ────────────────────────────────────────────────────────────────
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      const inner = renderTokens(t.tokens as Token[])
      // 每行添加灰色竖线前缀
      return inner
        .split('\n')
        .map((line) => `${C_GRAY}│${C_RESET}${C_DIM} ${line}${C_RESET}`)
        .join('\n')
    }

    // ── 列表 ────────────────────────────────────────────────────────────────
    case 'list': {
      return renderList(token as Tokens.List, 0)
    }

    // ── 水平线 ──────────────────────────────────────────────────────────────
    case 'hr': {
      const width = termWidth()
      return `${C_GRAY}${'─'.repeat(width)}${C_RESET}`
    }

    // ── HTML 块（忽略）──────────────────────────────────────────────────────
    case 'html': {
      return null
    }

    // ── 表格 ────────────────────────────────────────────────────────────────
    case 'table': {
      const t = token as Tokens.Table
      return renderTable(t)
    }

    // ── 空白 ────────────────────────────────────────────────────────────────
    case 'space': {
      return null
    }

    default:
      // 其他 token 原样输出（去掉多余空白）
      return token.raw?.trim() ?? null
  }
}

/**
 * 渲染表格为等宽列格式。
 */
function renderTable(t: Tokens.Table): string {
  // 收集所有行
  const headerCells = t.header.map((cell) => renderInline(cell.tokens as Token[]))
  const rows = t.rows.map((row) => row.map((cell) => renderInline(cell.tokens as Token[])))

  // 计算列宽（去掉 ANSI 估算可见长度）
  const colWidths: number[] = headerCells.map((h) => Math.max(3, visualLength(h)))
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const w = visualLength(row[c] ?? '')
      if (w > (colWidths[c] ?? 0)) {
        colWidths[c] = w
      }
    }
  }

  // 构建行字符串
  const pad = (s: string, width: number) => {
    const vis = visualLength(s)
    const padding = Math.max(0, width - vis)
    return s + ' '.repeat(padding)
  }

  const sep = `${C_GRAY}├${colWidths.map((w) => '─'.repeat(w + 2)).join('┼')}┤${C_RESET}`
  const top = `${C_GRAY}┌${colWidths.map((w) => '─'.repeat(w + 2)).join('┬')}┐${C_RESET}`
  const bot = `${C_GRAY}└${colWidths.map((w) => '─'.repeat(w + 2)).join('┴')}┘${C_RESET}`

  const renderRow = (cells: string[], isHeader = false) => {
    const padded = cells.map((c, i) => {
      const w = colWidths[i] ?? 0
      const s = pad(c, w)
      return isHeader ? `${C_BOLD}${s}${C_RESET}` : s
    })
    return `${C_GRAY}│${C_RESET} ${padded.join(` ${C_GRAY}│${C_RESET} `)} ${C_GRAY}│${C_RESET}`
  }

  const lines: string[] = [
    top,
    renderRow(headerCells, true),
    sep,
    ...rows.map((row) => renderRow(row, false)),
    bot,
  ]

  return lines.join('\n')
}

/**
 * 估算字符串的可见（终端列）宽度（去掉 ANSI 转义序列）。
 * CJK 字符按 2 计，其余按 1 计。
 */
function visualLength(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '')
  let len = 0
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字等双宽字符范围
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals / Kangxi
      (cp >= 0x3040 && cp <= 0x33ff) ||   // Hiragana, Katakana, CJK Compatibility
      (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
      (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
      (cp >= 0xa000 && cp <= 0xa4cf) ||   // Yi
      (cp >= 0xac00 && cp <= 0xd7af) ||   // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe1f) ||   // Vertical Forms
      (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth / Halfwidth
      (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth Signs
      (cp >= 0x1f300 && cp <= 0x1f9ff)    // Misc Symbols / Emoji
    ) {
      len += 2
    } else {
      len += 1
    }
  }
  return len
}

/**
 * 批量渲染 Token 数组，段落之间插入空行。
 */
function renderTokens(tokens: Token[]): string {
  const parts: string[] = []

  for (const tok of tokens) {
    const rendered = renderToken(tok)
    if (rendered !== null && rendered.length > 0) {
      parts.push(rendered)
    }
  }

  // 块级元素之间用 \n\n 分隔（段落间距）
  return parts.join('\n\n')
}

// ── 主导出 ───────────────────────────────────────────────────────────────────

/**
 * 将 Markdown 字符串渲染为带 ANSI 颜色的终端字符串。
 *
 * @param markdown 原始 Markdown 文字
 * @returns 可直接写入终端的 ANSI 字符串（末尾不含 \n）
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown || !markdown.trim()) return markdown

  try {
    // marked.lexer 返回 Token[]（块级 tokens），不渲染 HTML
    const tokens = marked.lexer(markdown)
    const result = renderTokens(tokens as Token[])
    return result
  } catch {
    // marked 解析失败时原样返回
    return markdown
  }
}

// ── 检测是否应该渲染 Markdown ─────────────────────────────────────────────────

/**
 * 检测字符串是否包含值得渲染的 Markdown 语法。
 * 对于纯文字（无任何 Markdown 标记），返回 false，直接输出原始文字。
 * 这样可以避免把不含 Markdown 的对话内容过度渲染。
 */
export function hasMarkdownSyntax(text: string): boolean {
  return /^#{1,6}\s|^\*\s|^-\s|^\d+\.\s|```|`[^`]|^\s*>|\*\*|__|\[.+\]\(|^---$|^\|.+\|/m.test(text)
}

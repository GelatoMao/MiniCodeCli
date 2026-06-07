// @mini-code-cli/cli — 终端代码语法高亮
//
// Task 11：为代码块提供基于正则的轻量级语法高亮。
//
// 设计决策：
//   - 不引入 prism/shiki 等重量级依赖（esbuild 打包后体积+启动时间不理想）
//   - 基于简单正则规则，覆盖 TypeScript/JavaScript/Python/Shell/JSON/Bash 等常用语言
//   - 代码块用灰色背景 + 语言标签渲染，使其视觉上与正文区分
//
// 高亮策略（按优先级从高到低）：
//   1. 字符串字面量（绿色）
//   2. 注释（灰色斜体）
//   3. 关键字（蓝色）
//   4. 数字字面量（黄色）
//   5. 函数调用（青色）
//   6. 操作符/标点（灰色）
//
// 已知限制：
//   - 正则匹配无法精确处理多行字符串 / 模板字面量嵌套
//   - 对语言检测依赖 marked 的 lang 属性（即 ``` 后面的标识符）
//   - 不支持的语言降级为无高亮（仅显示背景框）

// ── ANSI 颜色 ─────────────────────────────────────────────────────────────────

const C_RESET = '\x1b[0m'
const C_DIM = '\x1b[2m'
const C_ITALIC = '\x1b[3m'
const C_BOLD = '\x1b[1m'

// 代码区域专用颜色
const C_CODE_BG = '\x1b[48;2;30;30;40m'       // 深蓝灰背景
const C_STRING = '\x1b[38;2;152;195;121m'      // 绿色（字符串）
const C_COMMENT = '\x1b[38;2;98;114;164m'      // 蓝灰色（注释）
const C_KEYWORD = '\x1b[38;2;198;120;221m'     // 紫色（关键字）
const C_NUMBER = '\x1b[38;2;209;154;102m'      // 橙色（数字）
const C_FUNCTION = '\x1b[38;2;97;175;239m'     // 蓝色（函数名）
const C_TYPE = '\x1b[38;2;229;192;123m'        // 黄色（类型名）
const C_OPERATOR = '\x1b[38;2;86;182;194m'     // 青色（操作符）
const C_BRACKET = '\x1b[38;2;198;155;64m'      // 金色（括号）
const C_LANG_LABEL = '\x1b[38;2;100;100;120m'  // 语言标签（暗色）
const C_BORDER = '\x1b[38;2;60;60;80m'         // 代码块边框色

// ── 关键字定义 ────────────────────────────────────────────────────────────────

const TS_JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum',
  'import', 'export', 'from', 'default', 'as', 'new', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'throw', 'try',
  'catch', 'finally', 'async', 'await', 'yield', 'typeof', 'instanceof',
  'in', 'of', 'delete', 'void', 'null', 'undefined', 'true', 'false',
  'this', 'super', 'extends', 'implements', 'abstract', 'static', 'public',
  'private', 'protected', 'readonly', 'override', 'declare', 'namespace',
  'module', 'require', 'keyof', 'infer', 'never', 'any', 'unknown',
])

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'do', 'return',
  'import', 'from', 'as', 'in', 'not', 'and', 'or', 'is', 'with', 'pass',
  'break', 'continue', 'yield', 'raise', 'try', 'except', 'finally',
  'lambda', 'None', 'True', 'False', 'self', 'cls', 'del', 'global',
  'nonlocal', 'assert', 'async', 'await',
])

const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'type',
  'use', 'mod', 'pub', 'priv', 'crate', 'super', 'self', 'Self',
  'where', 'if', 'else', 'for', 'while', 'loop', 'match', 'return',
  'break', 'continue', 'move', 'ref', 'box', 'unsafe', 'extern',
  'true', 'false', 'None', 'Some', 'Ok', 'Err', 'async', 'await',
])

const GO_KEYWORDS = new Set([
  'func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan',
  'import', 'package', 'go', 'defer', 'select', 'case', 'default',
  'if', 'else', 'for', 'range', 'switch', 'break', 'continue', 'goto',
  'return', 'fallthrough', 'nil', 'true', 'false', 'make', 'new',
  'len', 'cap', 'append', 'copy', 'delete', 'close', 'panic', 'recover',
])

// 语言名 → 关键字集合
const LANG_KEYWORDS: Record<string, Set<string>> = {
  ts: TS_JS_KEYWORDS,
  tsx: TS_JS_KEYWORDS,
  typescript: TS_JS_KEYWORDS,
  js: TS_JS_KEYWORDS,
  jsx: TS_JS_KEYWORDS,
  javascript: TS_JS_KEYWORDS,
  py: PYTHON_KEYWORDS,
  python: PYTHON_KEYWORDS,
  rs: RUST_KEYWORDS,
  rust: RUST_KEYWORDS,
  go: GO_KEYWORDS,
  golang: GO_KEYWORDS,
}

// ── 通用 Token 化 + 着色 ─────────────────────────────────────────────────────

/** 着色后的代码片段 */
interface Segment {
  text: string
  color: string
}

/**
 * 对一行代码进行简单 token 化并着色。
 * 返回着色后的完整行字符串。
 */
function highlightLine(line: string, lang: string, keywords: Set<string>): string {
  if (!line.trim()) return line

  const isShell = lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh'
  const isJson = lang === 'json' || lang === 'jsonc'

  const segments: Segment[] = []
  let i = 0

  while (i < line.length) {
    // Shell 注释：#
    if (isShell && line[i] === '#') {
      segments.push({ text: line.slice(i), color: C_COMMENT + C_ITALIC })
      break
    }

    // 单行注释：// (JS/TS/Go/Rust/C)
    if (!isJson && i + 1 < line.length && line[i] === '/' && line[i + 1] === '/') {
      segments.push({ text: line.slice(i), color: C_COMMENT + C_ITALIC })
      break
    }

    // Python 注释：#
    if ((lang === 'py' || lang === 'python') && line[i] === '#') {
      segments.push({ text: line.slice(i), color: C_COMMENT + C_ITALIC })
      break
    }

    // 字符串：单引号、双引号、模板字符串（简化处理，不支持嵌套）
    const quote = line[i]
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2
          continue
        }
        if (line[j] === quote) {
          j++
          break
        }
        j++
      }
      segments.push({ text: line.slice(i, j), color: C_STRING })
      i = j
      continue
    }

    // 数字
    if (/[0-9]/.test(line[i] ?? '')) {
      let j = i
      while (j < line.length && /[0-9._xXa-fA-FbBoO]/.test(line[j] ?? '')) {
        j++
      }
      // 确保不是标识符的一部分
      if (j === line.length || !/[a-zA-Z_$]/.test(line[j] ?? '')) {
        segments.push({ text: line.slice(i, j), color: C_NUMBER })
        i = j
        continue
      }
    }

    // 标识符（关键字 / 函数调用 / 普通词）
    if (/[a-zA-Z_$]/.test(line[i] ?? '')) {
      let j = i
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j] ?? '')) {
        j++
      }
      const word = line.slice(i, j)

      // 关键字
      if (keywords.has(word)) {
        segments.push({ text: word, color: C_KEYWORD })
        i = j
        continue
      }

      // 函数调用（后接 '('）
      if (j < line.length && line[j] === '(') {
        segments.push({ text: word, color: C_FUNCTION })
        i = j
        continue
      }

      // 类型名（PascalCase 或全大写）
      if (/^[A-Z][a-zA-Z0-9_]*$/.test(word) || /^[A-Z_][A-Z0-9_]+$/.test(word)) {
        segments.push({ text: word, color: C_TYPE })
        i = j
        continue
      }

      // 普通标识符
      segments.push({ text: word, color: '' })
      i = j
      continue
    }

    // 括号：() [] {} <> 特殊着色
    if ('()[]{}'.includes(line[i] ?? '')) {
      segments.push({ text: line[i]!, color: C_BRACKET })
      i++
      continue
    }

    // 操作符（+= -= && || => === !== 等）
    if (/[+\-*/%=!<>&|^~]/.test(line[i] ?? '')) {
      let j = i
      while (j < line.length && /[+\-*/%=!<>&|^~]/.test(line[j] ?? '')) {
        j++
      }
      segments.push({ text: line.slice(i, j), color: C_OPERATOR })
      i = j
      continue
    }

    // 其余字符：原样输出
    segments.push({ text: line[i]!, color: '' })
    i++
  }

  // 合并 segments 为带颜色的字符串
  return segments
    .map((seg) => (seg.color ? `${seg.color}${seg.text}${C_RESET}` : seg.text))
    .join('')
}

// ── 代码块框架渲染 ────────────────────────────────────────────────────────────

/**
 * 将代码文本渲染为带背景框的终端代码块。
 *
 * 格式：
 *   ┌─────────────────────── typescript ───┐
 *   │ <highlighted code line>              │
 *   │ ...                                  │
 *   └──────────────────────────────────────┘
 *
 * @param code 原始代码（不含 ``` 包裹）
 * @param lang 语言标识符（可为空字符串）
 */
export function highlightCode(code: string, lang: string): string {
  const normalizedLang = lang.trim().toLowerCase()
  const keywords = LANG_KEYWORDS[normalizedLang] ?? new Set<string>()
  const termCols = process.stdout.columns ?? 80

  // 代码块内容宽度（去掉左右边框 + 各1空格 padding）
  // 格式: │ <content> │  →  2（左）+ 1（空格）+ content + 1（空格）+ 2（右）
  const borderWidth = termCols - 4  // │ + space + content + space + │

  // 对每行代码做高亮
  const lines = code.split('\n')
  // 去掉末尾空行（marked 会在代码块末尾留一个空行）
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop()
  }

  const highlightedLines = lines.map((line) => {
    // 对已含 Tab 的行先展开 Tab（4 空格）
    const expanded = line.replace(/\t/g, '    ')
    const highlighted = highlightLine(expanded, normalizedLang, keywords)
    return highlighted
  })

  // 构建标题行（含语言标签）
  const langLabel = normalizedLang
    ? `${C_LANG_LABEL} ${normalizedLang} ${C_RESET}${C_BORDER}`
    : ''

  // 计算顶部横线填充（考虑语言标签长度）
  const langVisibleLen = normalizedLang ? normalizedLang.length + 2 : 0  // " lang "
  const topLineLen = Math.max(0, borderWidth - langVisibleLen)
  const topLine = '─'.repeat(topLineLen)
  const botLine = '─'.repeat(borderWidth)

  const topBorder = `${C_BORDER}╭${topLine}${langLabel}╮${C_RESET}`
  const botBorder = `${C_BORDER}╰${botLine}╯${C_RESET}`

  // 每行内容（带左右边框 + 背景）
  const contentLines = highlightedLines.map((hl, i) => {
    // 计算该行可见宽度，用于右对齐填充
    const rawLine = lines[i] ?? ''
    const expanded = rawLine.replace(/\t/g, '    ')
    const visLen = Math.min(expanded.length, borderWidth - 1)
    const padding = ' '.repeat(Math.max(0, borderWidth - 1 - visLen))
    return `${C_BORDER}│${C_RESET}${C_CODE_BG} ${hl}${padding}${C_RESET}${C_BORDER}│${C_RESET}`
  })

  return [topBorder, ...contentLines, botBorder].join('\n')
}

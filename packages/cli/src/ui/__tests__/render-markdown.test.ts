// Task 11 — render-markdown / syntax-highlight / render-diff 单元测试
//
// 测试策略：
//   - 纯函数输出：去掉 ANSI 后检查可见文字内容
//   - 不依赖终端环境（无 process.stdout.columns 真实值，mock 为 80）
//   - 测试 hasMarkdownSyntax 的检测精度
//   - 测试 renderMarkdown 各块级元素的基本输出
//   - 测试 computeDiff / renderEditDiff 的正确性

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { renderMarkdown, hasMarkdownSyntax } from '../render-markdown.js'
import { highlightCode } from '../syntax-highlight.js'
import { renderEditDiff, renderNewFileDiff } from '../render-diff.js'

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

/** 去掉所有 ANSI 转义序列，只保留可见字符 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// mock process.stdout.columns = 80（避免 CI 环境无 tty 时返回 undefined）
const origColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
beforeAll(() => {
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
})
afterAll(() => {
  if (origColumns) {
    Object.defineProperty(process.stdout, 'columns', origColumns)
  }
})

// ── hasMarkdownSyntax ─────────────────────────────────────────────────────────

describe('hasMarkdownSyntax', () => {
  it('纯文字无 Markdown 标记 → false', () => {
    expect(hasMarkdownSyntax('好的，我来帮你解决这个问题。')).toBe(false)
    expect(hasMarkdownSyntax('Hello world')).toBe(false)
    expect(hasMarkdownSyntax('')).toBe(false)
  })

  it('ATX 标题 → true', () => {
    expect(hasMarkdownSyntax('# Hello')).toBe(true)
    expect(hasMarkdownSyntax('## Section')).toBe(true)
  })

  it('无序列表 → true', () => {
    expect(hasMarkdownSyntax('- item')).toBe(true)
    expect(hasMarkdownSyntax('* item')).toBe(true)
  })

  it('有序列表 → true', () => {
    expect(hasMarkdownSyntax('1. First')).toBe(true)
  })

  it('代码块 → true', () => {
    expect(hasMarkdownSyntax('```typescript\nconst x = 1\n```')).toBe(true)
  })

  it('行内代码 → true', () => {
    expect(hasMarkdownSyntax('使用 `const` 声明')).toBe(true)
  })

  it('粗体 → true', () => {
    expect(hasMarkdownSyntax('**重要提示**')).toBe(true)
  })

  it('链接 → true', () => {
    expect(hasMarkdownSyntax('[点击这里](https://example.com)')).toBe(true)
  })

  it('表格 → true', () => {
    expect(hasMarkdownSyntax('| Name | Value |')).toBe(true)
  })

  it('引用块 → true', () => {
    expect(hasMarkdownSyntax('> 引用文字')).toBe(true)
  })
})

// ── renderMarkdown ────────────────────────────────────────────────────────────

describe('renderMarkdown — 空输入', () => {
  it('空字符串原样返回', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('纯空白原样返回', () => {
    expect(renderMarkdown('   ')).toBe('   ')
  })
})

describe('renderMarkdown — 标题', () => {
  it('H1 输出包含标题文字', () => {
    const out = stripAnsi(renderMarkdown('# Hello World'))
    expect(out).toContain('Hello World')
  })

  it('H2 输出包含标题文字', () => {
    const out = stripAnsi(renderMarkdown('## Section'))
    expect(out).toContain('Section')
  })

  it('H3 输出包含 ### 前缀', () => {
    const out = stripAnsi(renderMarkdown('### SubSection'))
    expect(out).toContain('### SubSection')
  })

  it('H1 有下划线行（━）', () => {
    const out = renderMarkdown('# Title')
    // 检查是否有下划线字符（H1 用 ━）
    expect(out).toMatch(/━+/)
  })

  it('H2 有分隔线（─）', () => {
    const out = renderMarkdown('## Section')
    expect(out).toMatch(/─+/)
  })
})

describe('renderMarkdown — 段落', () => {
  it('段落文字原样保留（去掉 ANSI）', () => {
    const out = stripAnsi(renderMarkdown('这是一段普通文字。'))
    expect(out).toContain('这是一段普通文字。')
  })

  it('粗体文字包含在输出中', () => {
    const out = stripAnsi(renderMarkdown('**粗体**文字'))
    expect(out).toContain('粗体')
    expect(out).toContain('文字')
  })

  it('斜体文字包含在输出中', () => {
    const out = stripAnsi(renderMarkdown('*斜体*内容'))
    expect(out).toContain('斜体')
  })

  it('行内代码包含在输出中', () => {
    const out = stripAnsi(renderMarkdown('使用 `const` 关键字'))
    expect(out).toContain('const')
  })

  it('链接文字保留，URL 附加', () => {
    const out = stripAnsi(renderMarkdown('[GitHub](https://github.com)'))
    expect(out).toContain('GitHub')
    expect(out).toContain('https://github.com')
  })
})

describe('renderMarkdown — 列表', () => {
  it('无序列表保留所有列表项文字', () => {
    const md = '- 苹果\n- 香蕉\n- 橘子'
    const out = stripAnsi(renderMarkdown(md))
    expect(out).toContain('苹果')
    expect(out).toContain('香蕉')
    expect(out).toContain('橘子')
  })

  it('无序列表使用 • 符号', () => {
    const out = stripAnsi(renderMarkdown('- item'))
    expect(out).toContain('•')
  })

  it('有序列表保留编号', () => {
    const md = '1. First\n2. Second\n3. Third'
    const out = stripAnsi(renderMarkdown(md))
    expect(out).toContain('1.')
    expect(out).toContain('2.')
    expect(out).toContain('First')
    expect(out).toContain('Third')
  })
})

describe('renderMarkdown — 代码块', () => {
  it('代码内容保留在输出中', () => {
    const md = '```typescript\nconst x = 1\n```'
    const out = stripAnsi(renderMarkdown(md))
    expect(out).toContain('const x = 1')
  })

  it('代码块有语言标签', () => {
    const md = '```python\ndef hello():\n    pass\n```'
    const out = stripAnsi(renderMarkdown(md))
    // 语言标签应出现
    expect(out).toContain('python')
    expect(out).toContain('def hello')
  })

  it('无语言标识的代码块也能正常渲染', () => {
    const md = '```\nhello world\n```'
    const out = stripAnsi(renderMarkdown(md))
    expect(out).toContain('hello world')
  })
})

describe('renderMarkdown — 引用块', () => {
  it('引用内容保留', () => {
    const out = stripAnsi(renderMarkdown('> 这是引用'))
    expect(out).toContain('这是引用')
  })

  it('引用带竖线分隔符', () => {
    const out = stripAnsi(renderMarkdown('> 引用内容'))
    expect(out).toContain('│')
  })
})

describe('renderMarkdown — 水平线', () => {
  it('水平线输出 ─ 字符', () => {
    const out = stripAnsi(renderMarkdown('---'))
    expect(out).toMatch(/─{3,}/)
  })
})

describe('renderMarkdown — 表格', () => {
  it('表格标题行内容保留', () => {
    const md = '| Name | Value |\n|------|-------|\n| foo | bar |'
    const out = stripAnsi(renderMarkdown(md))
    expect(out).toContain('Name')
    expect(out).toContain('Value')
    expect(out).toContain('foo')
    expect(out).toContain('bar')
  })
})

// ── highlightCode ─────────────────────────────────────────────────────────────

describe('highlightCode', () => {
  it('代码内容保留（去掉 ANSI）', () => {
    const out = stripAnsi(highlightCode('const x = 1', 'typescript'))
    expect(out).toContain('const')
    expect(out).toContain('x')
  })

  it('有边框字符（╭ ╮ ╰ ╯）', () => {
    const out = stripAnsi(highlightCode('x = 1', 'python'))
    expect(out).toContain('╭')
    expect(out).toContain('╰')
  })

  it('语言标签出现在边框行', () => {
    const out = stripAnsi(highlightCode('print("hello")', 'python'))
    expect(out).toContain('python')
  })

  it('空语言标识不崩溃', () => {
    expect(() => highlightCode('hello world', '')).not.toThrow()
  })

  it('空代码不崩溃', () => {
    expect(() => highlightCode('', 'typescript')).not.toThrow()
  })

  it('多行代码每行都保留', () => {
    const code = 'const a = 1\nconst b = 2\nconst c = 3'
    const out = stripAnsi(highlightCode(code, 'typescript'))
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
    expect(out).toContain('const c = 3')
  })
})

// ── renderEditDiff ────────────────────────────────────────────────────────────

describe('renderEditDiff', () => {
  it('文件路径出现在输出中', () => {
    const out = stripAnsi(renderEditDiff('src/foo.ts', 'old', 'new'))
    expect(out).toContain('src/foo.ts')
  })

  it('无变化时输出"无变化"', () => {
    const out = stripAnsi(renderEditDiff('file.ts', 'same', 'same'))
    expect(out).toContain('无变化')
  })

  it('新增行用 + 前缀', () => {
    const out = stripAnsi(renderEditDiff('file.ts', '', 'new line'))
    expect(out).toContain('+ new line')
  })

  it('删除行用 - 前缀', () => {
    const out = stripAnsi(renderEditDiff('file.ts', 'old line', ''))
    expect(out).toContain('- old line')
  })

  it('@@ 行出现', () => {
    const out = renderEditDiff('file.ts', 'a\nb\nc', 'a\nX\nc')
    expect(stripAnsi(out)).toContain('@@')
  })

  it('多行修改：统计行数正确', () => {
    const old = 'line1\nline2\nline3'
    const nw = 'line1\nLINE2\nLINE3'
    const out = stripAnsi(renderEditDiff('file.ts', old, nw))
    // 应包含 +2（两行新增）
    expect(out).toContain('+2')
  })

  it('相同内容的行显示为上下文（2 个空格前缀）', () => {
    const old = 'ctx\nchange\nctx2'
    const nw = 'ctx\nCHANGED\nctx2'
    const out = stripAnsi(renderEditDiff('file.ts', old, nw))
    // 上下文行有两个空格前缀
    expect(out).toContain('  ctx')
  })
})

describe('renderNewFileDiff', () => {
  it('文件路径 + (new file) 标记', () => {
    const out = stripAnsi(renderNewFileDiff('new.ts', 'const x = 1'))
    expect(out).toContain('new.ts')
    expect(out).toContain('new file')
  })

  it('所有内容行都有 + 前缀', () => {
    const out = stripAnsi(renderNewFileDiff('f.ts', 'line1\nline2'))
    expect(out).toContain('+ line1')
    expect(out).toContain('+ line2')
  })
})

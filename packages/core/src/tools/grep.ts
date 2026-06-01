// @mini-code-cli/core — grep tool (content search via ripgrep)
//
// 基于 ripgrep 的代码内容搜索工具。支持完整的正则语法，
// 可按文件 glob 过滤，输出格式为 `<文件路径>:<行号>:<内容>`。
//
// 【为什么不让模型直接调用 shell grep / rg？】
// 直接运行 shell 命令存在以下问题：
//   1. 需要经过权限检查（shell 工具是受限工具），多一次交互延迟
//   2. 不同平台的 grep 参数不兼容（GNU grep vs BSD grep vs ripgrep）
//   3. 输出格式不稳定，模型容易解析出错
// 这个工具封装了最优参数组合，输出格式固定，模型可以稳定消费。
//
// 【输出截断】
// 匹配行数通过 headLimit 参数控制（默认 250 行），
// 超出时截断并提示如何缩小搜索范围。
// 长行通过 --max-columns 限制在 500 字符以内，防止 minified 文件整行塞入结果。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

/** 默认输出行数上限。超出时截断并提示使用更精确的搜索条件。 */
const DEFAULT_HEAD_LIMIT = 250

/** 单行字符数上限。超出部分会被 ripgrep 截断并标注 "[...]"，
 *  防止 minified JS 等单行超长内容把结果撑爆。 */
const MAX_COLUMNS = 500

/** execFile 的 stdout 缓冲区上限（20 MB）。 */
const RG_MAX_BUFFER = 20 * 1024 * 1024

export const grep = tool({
  description: `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use this grep tool for content search tasks. NEVER invoke grep or rg as a shell command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+").
- Filter files with glob parameter (e.g., "*.ts", "*.{ts,tsx}").
- Pattern syntax: Uses ripgrep — literal braces need escaping (use interface\\{\\} to find interface{} in Go code).
- Results are capped at headLimit lines (default ${DEFAULT_HEAD_LIMIT}). Long lines are truncated at ${MAX_COLUMNS} chars.`,
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")'),
    headLimit: z.number().optional().describe(`Max number of output lines (default: ${DEFAULT_HEAD_LIMIT})`),
  }),
  execute: async ({ pattern, path: searchPath, glob: globPattern, headLimit }, { toolCallId }) => {
    try {
      const rgPath = getRipgrepPath()
      const limit = headLimit ?? DEFAULT_HEAD_LIMIT

      // 构建 ripgrep 参数列表：
      //   --no-heading          每行输出都带文件名前缀（不分组），方便模型解析
      //   --line-number         输出中包含行号（格式：file:line:content）
      //   --color never         禁用 ANSI 颜色码，避免污染结果
      //   --max-columns N       单行超过 N 字符时截断（防止 minified 文件整行塞入）
      //   --max-columns-preview 截断时保留可读前缀而非直接省略整行
      const args = [
        '--no-heading',
        '--line-number',
        '--color',
        'never',
        '--max-columns',
        String(MAX_COLUMNS),
        '--max-columns-preview',
      ]

      // glob 过滤：只搜索匹配 glob 模式的文件（例如只搜 *.ts）
      if (globPattern) {
        args.push('--glob', globPattern)
      }

      // 最后两个位置参数：搜索模式 + 搜索路径（ripgrep 的 CLI 约定）
      args.push(pattern)
      args.push(searchPath ?? process.cwd())

      reportProgress(toolCallId, `Searching for /${pattern}/`)
      const { stdout } = await execFileAsync(rgPath, args, {
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })

      const out = stdout.trim()
      if (!out) return 'No matches found.'

      // 超出行数限制时截断，并告知模型剩余数量
      const lines = out.split('\n')
      if (lines.length <= limit) return out
      const truncated = lines.slice(0, limit).join('\n')
      return `${truncated}\n\n... [${lines.length - limit} more lines not shown — at least ${lines.length} total matches, capped at ${limit}. Narrow your pattern or use glob to reduce results.]`
    } catch (err) {
      // ripgrep 退出码：0 = 有匹配，1 = 无匹配，2 = 错误
      // code=1 是正常的"无结果"情况，不应视为工具失败
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No matches found.'
      }
      return formatToolError('searching', err)
    }
  },
})

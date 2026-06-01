// @mini-code-cli/core — glob tool (file search by pattern, via ripgrep)
//
// 【为什么用 ripgrep 而不是 Node glob 库？】
//   1. @vscode/ripgrep 已经是 grep 工具的依赖，复用无额外成本
//   2. ripgrep 用 Rust 实现并行目录遍历，在大型代码库（万级文件）上速度碾压 JS 实现
//   3. ripgrep 默认遵守 .gitignore，自动跳过 node_modules / dist / .git 等噪声
//   4. --sortr=modified 提供按修改时间排序，截断时最相关（最近修改）的文件优先保留
//
// 【catch-all 模式的特殊处理】
// ripgrep 的 --glob 是"白名单"语义：指定了 --glob "**/*" 等于显式允许所有文件，
// 这会覆盖 .gitignore 的过滤规则，导致 node_modules 等目录的数万文件全部涌现。
// 解决方案：识别 catch-all 模式后不传 --glob 参数，让 ripgrep 的默认过滤规则生效。
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

/** 单次 glob 返回的最大文件数。超出时截断并告知模型。 */
const MAX_GLOB_RESULTS = 200

/** execFile 的 stdout 缓冲区上限（20 MB），防止超大型仓库的输出撑爆内存。 */
const RG_MAX_BUFFER = 20 * 1024 * 1024

export const glob = tool({
  description:
    `Find files matching a glob pattern. Returns absolute file paths sorted by modification time, most recent first. ` +
    `Results are capped at ${MAX_GLOB_RESULTS} files — use a more specific pattern if truncated.`,
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
  }),
  execute: async ({ pattern, cwd }, { toolCallId }) => {
    try {
      const searchDir = cwd ?? process.cwd()
      reportProgress(toolCallId, `Matching ${pattern}`)

      // 构建 ripgrep 参数列表：
      //   --files          仅列出文件，不搜索内容
      //   --sortr=modified 按修改时间倒序排列（最近的在前）
      //   --hidden         包含以 "." 开头的隐藏文件（如 .eslintrc、.prettierrc）
      //   --glob !.git     显式排除 .git 目录（.gitignore 通常不包含 .git 自身）
      const args = ['--files', '--sortr=modified', '--hidden', '--glob', '!.git']

      // catch-all 检测：**/*.* → 所有文件，** → 同上，* → 当前目录所有文件
      // 这类模式用 --glob 传入会覆盖 .gitignore，产生大量噪声，因此直接省略
      const isCatchAll = /^(\*\*\/?\*?|\*)$/.test(pattern.trim())
      if (!isCatchAll) {
        args.push('--glob', pattern)
      }

      const { stdout } = await execFileAsync(getRipgrepPath(), args, {
        cwd: searchDir,
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000, // 30 秒超时，防止超大仓库无限等待
      })

      const out = stdout.trim()
      if (!out) return 'No files found matching the pattern.'

      // ripgrep 输出的是相对路径（相对于 cwd），转换为绝对路径方便模型直接使用
      const relatives = out.split('\n')
      const absolutes = relatives.map((p) => (path.isAbsolute(p) ? p : path.join(searchDir, p)))

      // 超出上限时截断，并告知模型剩余数量
      const truncated = absolutes.length > MAX_GLOB_RESULTS
      const result = absolutes.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${absolutes.length - MAX_GLOB_RESULTS} more files not shown — ${absolutes.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      // ripgrep 退出码语义：
      //   0 = 有匹配
      //   1 = 无匹配（正常情况，不是错误）
      //   2 = 程序错误（参数错误、权限问题等）
      // 将 code=1 视为"无结果"而非工具失败，避免模型认为调用出错而无限重试
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No files found matching the pattern.'
      }
      return formatToolError('searching files', err)
    }
  },
})

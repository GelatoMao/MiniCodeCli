// @mini-code-cli/core — readFile tool
//
// 【输出格式】
// 文件内容以"带行号字符串"返回，格式为 `<行号>\t<内容>`，例如：
//   1\timport fs from 'node:fs'
//   2\t
//   3\texport function foo() { ... }
//
// 模型（Claude、GPT 等）经过大量代码训练，能够准确理解这种格式，
// 在引用特定行时也能给出精确的行号，方便配合 edit 工具定位修改位置。
//
// 【截断策略】
// 两层保护防止上下文超限：
//   1. 行数截断（LARGE_FILE_LINE_THRESHOLD = 2000 行）：
//      超过阈值时只返回前 N 行，同时告知总行数和如何读取剩余部分。
//   2. 字节截断（MAX_READ_BYTES = 256 KB）：
//      即使用户指定了 limit，也不返回超过 256 KB 的内容，
//      防止模型用超大 limit 值把多 MB 文件塞满 context。
//
// 两种截断都会附加人类可读的提示，告诉模型下一步该怎么做（自恢复）。
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

/**
 * 不指定 offset/limit 时，自动截断的行数阈值。
 * 超过此值只返回前 N 行并附带提示。
 * 2000 行是"完整阅读整个模块"的经验上限；更大的文件应先用 grep 定位再局部读取。
 */
const LARGE_FILE_LINE_THRESHOLD = 2000

/**
 * 单次工具结果的字节上限（UTF-8）。
 * 作用：防止模型用 limit: 99999 等极大值把多 MB 文件完整塞入 context，
 * 导致下一轮 API 请求因 context_length_exceeded 失败。
 * 256 KB 约等于 ~65000 个 ASCII 字符，对绝大多数"读整个文件"的场景足够。
 */
const MAX_READ_BYTES = 256 * 1024

/**
 * 读取文本文件并返回带行号的字符串。
 *
 * 核心逻辑：
 *   1. 确定要读取的行范围（由 offset/limit 或自动截断逻辑决定）
 *   2. 逐行构建 `<行号>\t<内容>` 格式，同时累计字节数
 *   3. 任意一个预算触顶时停止，并附加相应的提示信息
 *
 * @param filePath - 文件绝对路径
 * @param offset   - 起始行号（1-based），不传则从第 1 行开始
 * @param limit    - 最多读取的行数，不传则读到文件末尾（受阈值限制）
 * @returns 带行号的文本内容，可能附带截断提示
 */
async function readTextResult(filePath: string, offset?: number, limit?: number): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  // 用户是否指定了范围（offset 或 limit 任意一个非空就算）
  const userSpecifiedRange = offset != null || limit != null

  // 确定切片范围和截断类型
  let start: number
  let end: number
  let isHeadTruncation = false // true = 自动截断（未超出用户指定范围），用于选择不同的提示语

  if (userSpecifiedRange) {
    // 用户指定了范围：offset 是 1-based，转换为 0-based 数组索引
    start = (offset ?? 1) - 1
    end = limit ? start + limit : lines.length
  } else if (totalLines > LARGE_FILE_LINE_THRESHOLD) {
    // 文件行数超限且用户未指定范围：自动截断到前 N 行
    start = 0
    end = LARGE_FILE_LINE_THRESHOLD
    isHeadTruncation = true
  } else {
    // 正常情况：读取全部内容
    start = 0
    end = lines.length
  }

  const sliced = lines.slice(start, end)

  // 逐行拼接带行号输出，同时累计 UTF-8 字节数
  // 注意：直接用 string.length 会误计 CJK 字符（每字符 1 个 JS 代码单元但 3 字节），
  // 必须用 Buffer.byteLength 获取真实字节数。
  const formatted: string[] = []
  let bytes = 0
  for (let i = 0; i < sliced.length; i++) {
    const numbered = `${start + i + 1}\t${sliced[i]}`
    // +1 是换行符的字节数（除第一行外每行前面都有一个 \n）
    const addedBytes = Buffer.byteLength(numbered, 'utf-8') + (formatted.length > 0 ? 1 : 0)
    // 已有内容时才检查上限（保证至少返回一行）
    if (bytes + addedBytes > MAX_READ_BYTES && formatted.length > 0) break
    formatted.push(numbered)
    bytes += addedBytes
  }
  const includedLines = formatted.length
  const body = formatted.join('\n')

  // 附加截断提示：精确告知模型当前看到了哪些行、如何读取剩余内容
  // 这让模型可以"自恢复"（self-recover）而无需用户介入。
  if (isHeadTruncation) {
    // 自动截断：提示总行数和 offset/limit 用法
    const note = includedLines < sliced.length ? ` (further capped at ${MAX_READ_BYTES / 1024} KB)` : ''
    return (
      body +
      `\n\n[readFile: showing first ${includedLines}/${totalLines} lines${note}. ` +
      `Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols.]`
    )
  }
  if (includedLines < sliced.length) {
    // 字节上限触顶：提示下一个 offset 值
    const nextOffset = start + includedLines + 1
    return (
      body +
      `\n\n[readFile: output capped at ${MAX_READ_BYTES / 1024} KB; ` +
      `returned ${includedLines}/${sliced.length} requested lines (lines ${start + 1}-${start + includedLines}). ` +
      `Call readFile again with offset=${nextOffset} for the next chunk, or narrow the range.]`
    )
  }
  return body
}

export const readFile = tool({
  description: `Read a file from the local filesystem.

Usage:
- The filePath parameter must be an absolute path, not a relative path.
- You can optionally specify offset and limit (especially handy for long files), but it's recommended to read the whole file first.
- Results are returned with line numbers starting at 1.
- This tool can only read files, not directories. To list a directory, use listDir.
- If a file path is provided by the user, assume it is valid.`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    offset: z.number().optional().describe('Start line (1-based)'),
    limit: z.number().optional().describe('Max lines to read'),
  }),
  execute: async ({ filePath, offset, limit }, { toolCallId }) => {
    try {
      // 注册进度消息，让 UI 在读取期间显示 "Reading /path/to/file"
      reportProgress(toolCallId, `Reading ${filePath}`)
      return await readTextResult(filePath, offset, limit)
    } catch (err) {
      // 常见错误：ENOENT（文件不存在）、EACCES（无读取权限）
      return formatToolError('reading file', err)
    }
  },
})

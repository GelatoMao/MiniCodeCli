// @mini-code-cli/core — listDir tool
//
// 列出目录下的直接子条目（不递归）。
// 目录名后附加 "/" 后缀，方便模型区分文件与子目录，
// 并决定是否需要进一步递归查看。
//
// 对于需要递归查找特定文件的场景，应优先使用 glob 工具
// （ripgrep 实现，速度更快，自动遵守 .gitignore）。
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

export const listDir = tool({
  description: 'List the contents of a directory. Returns names with type indicators (/ for directories).',
  inputSchema: z.object({
    dirPath: z.string().describe('Absolute path to the directory'),
  }),
  execute: async ({ dirPath }, { toolCallId }) => {
    try {
      reportProgress(toolCallId, `Listing ${dirPath}`)
      // withFileTypes: true 让 readdir 直接返回 Dirent 对象，
      // 可通过 .isDirectory() 判断类型，避免对每个条目额外调用 stat。
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const lines = entries.map((e) => {
        // 目录名添加 "/" 后缀，与 ls / tree 等工具的惯例保持一致
        const suffix = e.isDirectory() ? '/' : ''
        return `${e.name}${suffix}`
      })
      // 空目录返回提示字符串而非空字符串，让模型理解"已读取但目录为空"
      return lines.join('\n') || '(empty directory)'
    } catch (err) {
      // 常见错误：ENOENT（路径不存在）、ENOTDIR（路径是文件而非目录）、EACCES（无权限）
      return formatToolError('listing directory', err)
    }
  },
})

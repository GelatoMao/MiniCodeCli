// @mini-code-cli/core — writeFile tool
//
// 【为什么没有 execute？】
// writeFile 是写操作，需要进入权限检查流程后才能执行。
// AI SDK 的 tool() 分两类：
//   - 有 execute：AI SDK 在 streamText 过程中自动执行（适合只读的安全操作）
//   - 无 execute：AI SDK 产出 tool-call 事件，由 agent loop 手动处理
//
// writeFile 走第二条路径：agent loop 的 processToolCalls 函数收到调用后，
// 先经过 checkPermission（可能弹出交互式确认对话框），通过后再执行写入。
// 这是保证用户对文件修改拥有完整控制权的关键机制。
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description: `Write a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the readFile tool first to read the file's contents.
- Prefer the edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the user.`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    content: z.string().describe('The full content to write'),
  }),
  // 无 execute — 由 agent loop 中的 tool-execution.ts 手动分发，
  // 经过权限检查（checkPermission）后才真正写入磁盘
})

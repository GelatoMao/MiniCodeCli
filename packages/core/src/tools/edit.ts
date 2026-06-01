// @mini-code-cli/core — edit tool
//
// 精确字符串替换工具：在文件中查找 oldString，用 newString 替换。
//
// 【为什么用字符串替换而不是 diff/patch？】
// diff/patch 格式对模型来说有额外的认知负担（行号、上下文行、+/-符号），
// 而"找到这段文字，换成那段文字"的语义更直观，生成的 prompt 也更短。
// 唯一约束是 oldString 必须在文件中唯一，模型通常会主动包含足够的上下文来保证这一点。
//
// 【为什么没有 execute？】
// edit 和 writeFile 一样是写操作，需要经过权限检查（checkPermission）。
// agent loop 在收到 tool-call 后手动处理：
//   1. 读取文件内容
//   2. 验证 oldString 唯一性（唯一 = 1 处，非唯一则返回错误提示模型提供更多上下文）
//   3. 执行替换（replaceAll 模式下替换全部出现）
//   4. 写回文件
//   5. 通过 onFileEdit 回调向 UI 推送 diff 预览
import { tool } from 'ai'

import { z } from 'zod'

export const edit = tool({
  description: `Perform exact string replacements in files.

Usage:
- You must use readFile at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from readFile output, ensure you preserve the exact indentation (tabs/spaces) as it appears in the file content. Never include line number prefixes in oldString or newString.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if oldString is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replaceAll to change every instance.
- Use replaceAll for replacing and renaming strings across the file (e.g. renaming a variable).`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    oldString: z.string().describe('The exact text to find and replace (must be unique in the file)'),
    newString: z.string().describe('The replacement text'),
    replaceAll: z.boolean().optional().describe('Replace all occurrences (default: false)'),
  }),
  // 无 execute — 由 agent loop 中的 executeWriteTool 手动分发：
  //   1. 检查 oldString 唯一性（replaceAll=false 时必须恰好出现一次）
  //   2. 经过 checkPermission 权限检查
  //   3. 执行 String.replace / String.replaceAll 并写回磁盘
  //   4. 通过 onFileEdit 回调向 UI 推送彩色 diff 预览
})

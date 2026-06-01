// @mini-code-cli/core — Tool registry (unified export)
//
// 【工具分类】
// 本模块汇总所有工具的导出，并组装 toolRegistry 供 agent loop 使用。
//
// 工具按执行方式分为两类：
//
//   auto-execute（有 execute 函数，传入 streamText 后 AI SDK 自动执行）：
//     readFile, listDir, glob, grep
//     这些是只读、无副作用的安全操作，模型调用时无需人工确认。
//
//   手动分发（无 execute 函数，agent loop 收到 tool-call 后自行处理）：
//     writeFile, edit
//     这些是写操作，需要经过 checkPermission 权限检查，
//     可能弹出交互式确认对话框等待用户决策。
//
// 两类工具都被放入 toolRegistry，传给 streamText({ tools: toolRegistry }) 时：
//   - auto-execute 工具由 AI SDK 在 fullStream 内部自动执行
//   - 手动分发工具产出 tool-call chunk，由 agent loop 在 finishReason='tool-calls'
//     时调用 processToolCalls 手动处理
import { edit } from './edit.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { listDir } from './list-dir.js'
import { readFile } from './read-file.js'
import { writeFile } from './write-file.js'

/**
 * 传给 streamText({ tools }) 的工具对象。
 * key 是工具名称（模型在 tool-call 中使用该名称），value 是 tool() 返回的工具定义。
 *
 * 注意：task 工具（sub-agent）在 agent/loop.ts 的 buildTools() 中动态注入，
 * 不在这里静态声明，因为它需要访问 SubAgentRegistry 实例。
 */
export const toolRegistry = {
  readFile,
  writeFile,
  edit,
  glob,
  grep,
  listDir,
}

// 单独导出各工具，方便按需引用（如 tool-execution.ts 中判断 tool 类型时使用）
export {
  readFile,
  writeFile,
  edit,
  glob,
  grep,
  listDir,
}

// 导出截断工具和相关常量，agent loop 在处理工具结果时使用
export { MAX_TOOL_RESULT_LINES, MAX_TOOL_RESULT_BYTES, truncateToolResult } from './truncate.js'
export type { TruncateOptions } from './truncate.js'

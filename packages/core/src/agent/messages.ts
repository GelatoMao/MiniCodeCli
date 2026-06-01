// @mini-code-cli/core — Message construction helpers
//
// 提供构建 ModelMessage 的工厂函数，以及工具错误字符串的标准化格式。
//
// 为什么要单独提取这些函数而不直接内联？
//   1. 工具结果消息的结构（tool-result part 的嵌套格式）在 AI SDK v4~v6 间有变化，
//      集中在一处方便以后统一迁移。
//   2. "Error: " 前缀是跨模块的契约：
//      - tool-execution 的 executeWriteTool 在失败时返回它
//      - tool-execution 的 handleToolCall 检查它来翻转 UI 错误色
//      - 模型自己也学会把它当作"工具失败"标记
//      统一在此定义，避免各处散落字符串字面量导致拼写不一致。
import type { ModelMessage } from 'ai'

// ── userMessage ──────────────────────────────────────────────────────────────

/** 创建一条 user 角色消息（字符串内容）。*/
export function userMessage(content: string): ModelMessage {
  return { role: 'user', content }
}

// ── toolResultMessage ─────────────────────────────────────────────────────────

/** 创建一条 tool 角色消息，包含单个 tool-result part。
 *
 *  AI SDK 要求 tool 消息格式为：
 *  ```json
 *  {
 *    "role": "tool",
 *    "content": [{
 *      "type": "tool-result",
 *      "toolCallId": "...",
 *      "toolName": "...",
 *      "output": { "type": "text", "value": "..." }
 *    }]
 *  }
 *  ```
 *  将其封装为工厂函数，便于统一迁移 SDK 格式变化。*/
export function toolResultMessage(toolCallId: string, toolName: string, result: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: result },
      },
    ],
  }
}

// ── 工具错误字符串 ─────────────────────────────────────────────────────────────

/** 标准工具错误字符串。
 *
 *  "Error: " 前缀是负载性的协议：
 *    - handleToolCall 通过 isToolErrorString 检测它来翻转 UI 的错误颜色
 *    - 模型本身也会把这个前缀识别为"工具失败"并调整策略
 *  所以不要轻易改变这个前缀。*/
export function toolErrorString(message: string): string {
  return `Error: ${message}`
}

/** 把一个 unknown 抛出值转换成标准工具错误字符串。
 *  catch 块中直接调用：`toolErrorFromUnknown(err)`。*/
export function toolErrorFromUnknown(err: unknown): string {
  return toolErrorString(err instanceof Error ? err.message : String(err))
}

/** 判断一个字符串是否是 toolErrorString 产生的错误。
 *
 *  用途：在 handleToolCall 里判断 writeFile/edit 的返回值是否是
 *  in-band 失败（区别于正常结果），从而把 UI 工具行显示为红色。*/
export function isToolErrorString(value: string): boolean {
  return value.startsWith('Error:')
}

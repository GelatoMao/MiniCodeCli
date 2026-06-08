// @mini-code-cli/core — MCP 工具桥接
//
// 将 MCP 工具定义（McpToolDef）转换为 AI SDK 兼容的 tool() 格式，
// 使 agentLoop 可以把 MCP 工具与内置工具一起传给 streamText。
//
// 核心挑战：
//   MCP 工具使用 JSON Schema 描述参数，AI SDK 期望 zod schema。
//   这里不做 JSON Schema → zod 的完整转换（过于复杂），
//   而是使用 z.record(z.unknown()) 作为通用类型：
//     - 类型足够宽松，不会拒绝任何有效 MCP 工具调用
//     - 工具描述字符串中仍然包含完整的参数信息（模型从描述推断类型）
//
// 设计决策：MCP 工具为"手动分发"而非"auto-execute"
//   - MCP 工具不提供 execute 函数（AI SDK 的 auto-execute 路径）
//   - 取而代之，MCP 工具产出 tool-call chunk，由 agentLoop 手动路由到
//     tool-execution.ts 的 handleMcpToolCall
//   - 原因：MCP 工具需要经过权限检查（always-allow 列表），
//     auto-execute 路径绕过了 handleToolCall 的权限逻辑
import { tool } from 'ai'
import { z } from 'zod'

import { mangleName } from './name-mangling.js'
import type { McpEntry, McpRegistry, McpToolDef } from './types.js'

// ── buildToolDescription ──────────────────────────────────────────────────────

/** 构建工具的 AI SDK description 字符串。
 *
 *  包含：服务器来源 + 原始描述 + 参数描述（从 JSON Schema 提取）
 *
 *  为什么在 description 里包含参数信息？
 *    z.record(z.unknown()) 丢失了类型信息，模型只能从描述字符串推断参数。
 *    把 JSON Schema 的 properties 展示出来，弥补类型信息的缺失。*/
function buildToolDescription(serverName: string, toolDef: McpToolDef): string {
  const parts: string[] = []

  if (toolDef.description) {
    parts.push(toolDef.description)
  }

  parts.push(`[MCP server: ${serverName}]`)

  // 追加参数信息（从 JSON Schema 提取）
  const props = toolDef.inputSchema?.properties
  if (props && typeof props === 'object') {
    const required = new Set<string>(toolDef.inputSchema.required ?? [])
    const paramLines = Object.entries(props).map(([key, schema]) => {
      const s = schema as Record<string, unknown>
      const typeStr = typeof s.type === 'string' ? s.type : 'any'
      const descStr = typeof s.description === 'string' ? s.description : ''
      const reqStr = required.has(key) ? '' : ' (optional)'
      return `  - ${key} (${typeStr}${reqStr}): ${descStr}`
    })
    if (paramLines.length > 0) {
      parts.push('Parameters:\n' + paramLines.join('\n'))
    }
  }

  return parts.join('\n')
}

// ── bridgeMcpTool ─────────────────────────────────────────────────────────────

/** 将单个 MCP 工具定义转换为 AI SDK tool() 格式（无 execute，手动分发）。
 *
 *  返回的工具对象没有 execute 函数，因此 AI SDK 不会自动执行它，
 *  而是产出 tool-call chunk，由 processToolCalls → handleMcpToolCall 处理。
 *
 *  @param serverName  服务器名称（用于描述和名称前缀）
 *  @param toolDef     MCP 工具定义（来自 entry.tools）
 *  @returns           AI SDK tool() 返回值（无 execute）
 */
export function bridgeMcpTool(serverName: string, toolDef: McpToolDef) {
  return tool({
    description: buildToolDescription(serverName, toolDef),
    // 使用宽松的 record 类型，让模型可以自由传递任何参数
    inputSchema: z.record(z.unknown()),
  })
}

// ── bridgeAllMcpTools ─────────────────────────────────────────────────────────

/** 将 McpRegistry 中所有服务器的所有工具转换为 AI SDK tool Record。
 *
 *  返回对象的 key 是命名空间化工具名（"serverName__toolName"），
 *  可以直接合并到 toolRegistry 后传给 streamText。
 *
 *  @param registry  McpRegistry（含所有已连接服务器）
 *  @returns         命名空间化工具名 → AI SDK tool 的映射
 */
export function bridgeAllMcpTools(
  registry: McpRegistry,
): Record<string, ReturnType<typeof bridgeMcpTool>> {
  const result: Record<string, ReturnType<typeof bridgeMcpTool>> = {}

  for (const entry of registry.list()) {
    for (const toolDef of entry.tools) {
      const mangledName = mangleName(entry.serverName, toolDef.name)
      result[mangledName] = bridgeMcpTool(entry.serverName, toolDef)
    }
  }

  return result
}

// ── toSystemPromptEntries ──────────────────────────────────────────────────────

/** 生成用于系统提示的 MCP 工具描述块。
 *
 *  在系统提示中告知模型有哪些 MCP 工具可用，格式化为人类可读的列表。
 *  这是除 tools 对象本身之外的补充信息，帮助模型更好地理解工具用途。
 *
 *  @param registry  McpRegistry
 *  @returns         系统提示片段（为空则不追加）
 */
export function toSystemPromptEntries(registry: McpRegistry): string {
  const entries = registry.list()
  if (entries.length === 0) return ''

  const lines: string[] = [
    '## MCP Tools',
    '',
    'The following MCP (Model Context Protocol) tools are available from external servers:',
    '',
  ]

  for (const entry of entries) {
    if (entry.tools.length === 0) continue
    lines.push(`### Server: ${entry.serverName}`)
    lines.push('')
    for (const toolDef of entry.tools) {
      const mangledName = mangleName(entry.serverName, toolDef.name)
      lines.push(`- **${mangledName}**: ${toolDef.description || '(no description)'}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

// ── getMcpToolDef ─────────────────────────────────────────────────────────────

/** 从 McpRegistry 按命名空间化工具名查找工具定义。
 *
 *  用于 handleMcpToolCall 中验证工具是否存在。
 *
 *  @param registry     McpRegistry
 *  @param mangledName  命名空间化工具名（如 "filesystem__readFile"）
 *  @returns            { entry, toolDef } 或 null（找不到时）
 */
export function getMcpToolDef(
  registry: McpRegistry,
  mangledName: string,
): { entry: McpEntry; toolDef: McpToolDef } | null {
  for (const entry of registry.list()) {
    for (const toolDef of entry.tools) {
      if (mangleName(entry.serverName, toolDef.name) === mangledName) {
        return { entry, toolDef }
      }
    }
  }
  return null
}

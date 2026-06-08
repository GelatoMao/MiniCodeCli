// @mini-code-cli/core — MCP Client
//
// 封装 @modelcontextprotocol/sdk 的 Client，提供统一的连接/调用接口。
//
// 设计：
//   - connectMcpServer() 是唯一公开工厂函数，返回 McpEntry
//   - stdio transport：通过 StdioClientTransport 启动子进程
//   - http transport：通过 StreamableHTTPClientTransport 连接远程服务器
//   - callTool 将 MCP tools/call 的结果统一序列化为字符串返回
//
// MCP 工具调用结果格式：
//   MCP content 是 ContentBlock[]（TextContent | ImageContent | BlobResourceContent 等）
//   我们只关心 TextContent，其他类型序列化为 [BinaryContent]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { McpEntry, McpServerConfig, McpToolDef } from './types.js'

// ── serializeCallResult ──────────────────────────────────────────────────────

/** 将 MCP tools/call 的内容块数组序列化为字符串。
 *
 *  MCP content block 类型：
 *    - text：直接返回 text 字段
 *    - image：返回 [Image: <mimeType>] 占位
 *    - resource：返回 [Resource: <uri>] 占位
 *    - 其他：JSON 序列化
 *
 *  多个 block 用换行拼接。*/
function serializeCallResult(content: unknown[]): string {
  if (!Array.isArray(content) || content.length === 0) return ''

  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return String(block)
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'image') return `[Image: ${b.mimeType ?? 'unknown'}]`
      if (b.type === 'resource') {
        const uri = (b.resource as Record<string, unknown>)?.uri ?? '(unknown)'
        return `[Resource: ${uri}]`
      }
      return JSON.stringify(block)
    })
    .join('\n')
}

// ── connectMcpServer ──────────────────────────────────────────────────────────

/** 连接单个 MCP 服务器，返回 McpEntry。
 *
 *  流程：
 *    1. 根据 transport 类型创建对应的 Transport
 *    2. 用 Client.connect() 建立连接并完成 MCP 握手
 *    3. 调用 client.listTools() 获取工具列表（缓存在 McpEntry.tools）
 *    4. 返回 McpEntry（含 callTool / shutdown 方法）
 *
 *  错误处理：
 *    - 连接失败或 listTools 失败时 throw，由调用方（loader.ts）捕获并记录警告
 *
 *  @param config  服务器配置（来自 mcp.json）
 *  @returns       成功连接并初始化的 McpEntry
 */
export async function connectMcpServer(config: McpServerConfig): Promise<McpEntry> {
  const client = new Client(
    { name: 'mini-code-cli', version: '0.1.0' },
    { capabilities: {} },
  )

  // 根据 transport 类型创建不同的 Transport 实现
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`MCP server "${config.name}": stdio transport requires "command" field`)
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // 合并当前环境变量 + 用户配置的额外变量
      env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined,
      // MCP 服务器的 stderr 静默——避免污染 mini-code-cli 的 stderr 输出
      stderr: 'pipe',
    })
    await client.connect(transport)
  } else if (config.transport === 'http') {
    if (!config.url) {
      throw new Error(`MCP server "${config.name}": http transport requires "url" field`)
    }
    const headers: Record<string, string> = config.headers ?? {}
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    })
    await client.connect(transport)
  } else {
    throw new Error(`MCP server "${config.name}": unsupported transport "${(config as McpServerConfig).transport}"`)
  }

  // 查询工具列表（连接后立即执行，缓存在 entry.tools）
  let tools: McpToolDef[] = []
  try {
    const result = await client.listTools()
    tools = result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as McpToolDef['inputSchema'],
    }))
  } catch (err) {
    // listTools 失败时记录警告，但不阻断（部分服务器可能不支持 tools/list）
    console.warn(`[MCP] Failed to list tools from "${config.name}":`, err)
  }

  // 构造并返回 McpEntry
  const entry: McpEntry = {
    serverName: config.name,
    tools,

    async callTool(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
      try {
        const result = await client.callTool(
          { name: toolName, arguments: input },
          undefined,
          // MCP SDK RequestOptions：传递 AbortSignal
          signal ? { signal: signal as globalThis.AbortSignal } : undefined,
        )
        // result.content 是 ContentBlock[]
        const content = Array.isArray(result.content) ? result.content : []
        const isError = result.isError === true
        const text = serializeCallResult(content)
        if (isError) return `Error: ${text}`
        return text || '(empty result)'
      } catch (err) {
        if (err instanceof Error) return `Error: ${err.message}`
        return `Error: ${String(err)}`
      }
    },

    async shutdown(): Promise<void> {
      try {
        await client.close()
      } catch {
        // 忽略关闭时的错误（进程可能已经退出）
      }
    },
  }

  return entry
}

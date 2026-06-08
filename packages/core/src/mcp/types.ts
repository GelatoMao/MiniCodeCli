// @mini-code-cli/core — MCP 类型定义
//
// 定义 MCP 协议集成所需的核心接口：
//   McpServerConfig  — 用户/项目配置中的单个 MCP 服务器描述
//   McpToolDef       — 从 MCP 服务器查询到的工具定义
//   McpEntry         — 运行时已连接的 MCP 服务器条目（含工具列表）
//   McpRegistry      — 管理所有 MCP 连接的注册表接口

// ── McpServerConfig ──────────────────────────────────────────────────────────

/** 用户或项目 MCP 配置文件中的单条服务器配置。
 *
 *  支持两种传输方式：
 *    - stdio：在本地启动子进程，通过标准输入输出通信（最常见）
 *    - http：连接远程 HTTP/SSE 端点（Streamable HTTP transport）
 *
 *  配置文件位置：
 *    - 用户级：~/.mini-code/mcp.json
 *    - 项目级：<cwd>/.mini-code/mcp.json  （需要 trust 确认）
 */
export interface McpServerConfig {
  /** 服务器显示名称（同时作为工具前缀，如 "filesystem__readFile"）*/
  name: string
  /** 传输方式：stdio（本地子进程）或 http（远程 HTTP）*/
  transport: 'stdio' | 'http'
  // stdio 专用字段
  /** 要执行的命令（stdio 模式必填，如 "npx", "python"）*/
  command?: string
  /** 命令参数列表（stdio 模式）*/
  args?: string[]
  /** 额外环境变量（合并到 process.env，stdio 模式）*/
  env?: Record<string, string>
  // http 专用字段
  /** HTTP 端点 URL（http 模式必填）*/
  url?: string
  /** HTTP 请求头（如 Authorization）*/
  headers?: Record<string, string>
}

// ── McpToolDef ───────────────────────────────────────────────────────────────

/** MCP 服务器上报的单个工具定义（从 tools/list RPC 获取）。*/
export interface McpToolDef {
  /** 工具名称（server-local，不含前缀）*/
  name: string
  /** 工具功能描述（给 LLM 看）*/
  description: string
  /** JSON Schema 形式的输入参数描述*/
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

// ── McpEntry ─────────────────────────────────────────────────────────────────

/** 运行时已成功连接并初始化的 MCP 服务器条目。
 *
 *  McpEntry 由 McpClient 创建，McpRegistry 持有所有 entry 的列表。
 *  entry.tools 是该服务器所有工具的定义列表，在连接时一次性查询并缓存。*/
export interface McpEntry {
  /** 服务器名称（来自 McpServerConfig.name）*/
  serverName: string
  /** 工具定义列表（连接时从服务器查询，运行期不变）*/
  tools: McpToolDef[]
  /** 调用工具（发送 tools/call RPC）
   *
   *  @param toolName   server-local 工具名（不含前缀）
   *  @param input      工具输入参数
   *  @param signal     取消信号（Esc / Ctrl+C）
   *  @returns          工具执行结果（字符串化）
   */
  callTool(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string>
  /** 关闭连接（停止子进程 / 断开 HTTP）*/
  shutdown(): Promise<void>
}

// ── McpRegistry ──────────────────────────────────────────────────────────────

/** 管理所有已连接 MCP 服务器的注册表。
 *
 *  由 loadMcpFromDisk() 创建并返回，agentLoop 持有单例。*/
export interface McpRegistry {
  /** 列出所有已连接服务器的 entry*/
  list(): McpEntry[]
  /** 按服务器名称查找 entry（找不到返回 undefined）*/
  get(serverName: string): McpEntry | undefined
  /** 调用指定服务器的工具
   *
   *  @param serverName  服务器名称
   *  @param toolName    server-local 工具名（不含前缀）
   *  @param input       工具输入
   *  @param signal      取消信号
   */
  callTool(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>
  /** 关闭所有 MCP 连接（进程退出前调用）*/
  shutdown(): Promise<void>
}

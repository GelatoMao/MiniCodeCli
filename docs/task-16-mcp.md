# Task 16：MCP 协议集成

## 概述

本任务实现了 Model Context Protocol (MCP) 的集成，使 mini-code-cli 能够加载外部 MCP 服务器提供的工具。MCP 是一个开放协议，允许 AI 工具链通过标准化接口调用外部能力（文件系统、数据库、API 等）。

## 核心设计决策

### 1. 模块分层

```
packages/core/src/mcp/
  types.ts        — 接口定义（McpServerConfig / McpEntry / McpRegistry）
  client.ts       — 连接单个服务器（StdioClientTransport / StreamableHTTPClientTransport）
  name-mangling.ts — 命名空间化工具名（"server__tool"）
  loader.ts       — 从磁盘加载配置、建立连接
  trust.ts        — 项目级配置的 trust 对话框
  permissions.ts  — MCP 工具专用 always-allow 持久化
  tool-bridge.ts  — 将 McpToolDef 转换为 AI SDK tool() 格式
  registry.ts     — McpRegistry 实现（容器 + 路由）
```

### 2. 名称命名空间（Name Mangling）

MCP 工具名由 `<serverName>__<toolName>` 组成，双下划线分隔。

**为什么需要这个？**
- AI SDK 的 `tools` 对象是扁平 `Record<string, tool>`
- 不同服务器可能有同名工具（两个服务器都有 `readFile`）
- 命名空间前缀完全避免冲突
- `demangleName("filesystem__readFile")` → `{ serverName: "filesystem", toolName: "readFile" }`

### 3. 手动分发 vs Auto-Execute

MCP 工具被设计为**手动分发**（无 `execute` 函数），而非 AI SDK 的 auto-execute 模式。

原因：
- MCP 工具需要经过权限检查（always-allow 列表）
- auto-execute 路径绕过了 `handleToolCall` 的权限逻辑
- 保持权限检查的统一性：所有外部工具都经过同一条权限路径

工具调用链：
```
streamText → tool-call chunk
  → processToolCalls
    → handleToolCall
      → applyLoopGuard（循环守卫）
      → isMangledName()？
          → handleMcpToolCall（权限检查 + registry.callTool）
```

### 4. 权限模型

MCP 工具有专属权限存储（`mcp-permissions.json`），独立于内置工具（`permissions.json`）。

两级 always-allow：
- **工具级**：`"filesystem__readFile": true` — 允许该工具
- **服务器级**：`"filesystem__*": true` — 允许整个服务器的所有工具

权限决策流程：
```
trustMode=true → 直接通过
already in always-allow → 直接通过
否则 → onAskPermission 对话框
  yes → 本次通过
  always → 持久化到 mcp-permissions.json + 通过
  no → 拒绝
```

### 5. 配置层叠

配置文件从低优先级到高优先级：
1. `~/.mini-code/mcp.json`（用户级，自动加载，无需 trust）
2. `.mini-code/mcp.json`（项目级，需要 trust 确认，可覆盖同名用户服务器）

配置格式示例：
```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "custom-api",
      "transport": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer token" }
    }
  ]
}
```

### 6. JSON Schema → AI SDK 工具转换

MCP 工具使用 JSON Schema 描述参数，AI SDK 期望 Zod schema。

解决方案：
- 不做 JSON Schema → Zod 完整转换（过于复杂，边界情况多）
- 使用 `z.record(z.unknown())` 作为通用类型（足够宽松）
- 在工具 `description` 字符串中包含完整参数信息，让模型从自然语言推断

```typescript
tool({
  description: `${toolDef.description}\n[MCP server: ${serverName}]\nParameters:\n  - path (string): ...`,
  inputSchema: z.record(z.unknown()),
  // 无 execute → 手动分发
})
```

## 关键代码解析

### connectMcpServer（client.ts）

```typescript
const client = new Client({ name: 'mini-code-cli', version: '0.1.0' }, { capabilities: {} })

// stdio：启动子进程，通过 stdin/stdout 通信
const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' })
await client.connect(transport)

// 查询工具列表，缓存在 entry.tools
const result = await client.listTools()
```

### handleMcpToolCall（tool-execution.ts）

```typescript
async function handleMcpToolCall(ctx: HandlerCtx): Promise<void> {
  const { serverName, toolName: localToolName } = demangleName(toolName)!
  
  // 权限检查（MCP 专属）
  const alreadyAllowed = options.trustMode || isMcpToolAlwaysAllowed(toolName, cwd)
  if (!alreadyAllowed) {
    const decision = await callbacks.onAskPermission({ toolCallId, toolName, input })
    if (decision === 'always') allowMcpTool(toolName, cwd)  // 持久化
    if (decision === 'no') return  // 拒绝
  }
  
  // 调用 MCP 服务器
  const output = await mcpRegistry.callTool(serverName, localToolName, input, signal)
  pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(output), isError)
}
```

### buildTools（loop.ts）中的 MCP 注入

```typescript
// MCP 工具合并到工具集（命名空间化，不与内置工具冲突）
const mcpTools = options.mcpRegistry ? bridgeAllMcpTools(options.mcpRegistry) : {}

return {
  ...toolRegistry,    // readFile/writeFile/edit/glob/grep/listDir/shell
  task: taskTool,     // sub-agent 工具
  ...mcpTools,        // filesystem__readFile / git__status / ...
}
```

## 与原项目的差异对比

| 方面 | 原 x-code-cli | mini-code-cli |
|------|-------------|---------------|
| transport | stdio + streamable-http + SSE | stdio + streamable-http（简化） |
| 权限持久化 | 复杂规则引擎 | 简单工具/服务器两级 |
| trust 对话框 | 完整 UI 对话框 | 通过 onAskUser 回调 |
| JSON Schema 转换 | 部分转换 | z.record(z.unknown()) 全宽松 |
| sub-agent 工具过滤 | MCP 工具也可配置 | sub-agent 不含 MCP 工具 |

## 踩过的坑

### 1. `AbortSignal` 导入位置

```typescript
// ❌ 错误：node:events 没有导出 AbortSignal
import type { AbortSignal } from 'node:events'

// ✅ 正确：AbortSignal 是全局类型，直接使用
// 不需要任何 import
```

Node.js 18+ 中 `AbortSignal` 是全局类型，不需要从 `node:events` 导入。

### 2. MCP 工具为手动分发

初始想法是用 AI SDK 的 `execute` 函数让 MCP 工具自动执行，但这会绕过权限检查。
最终选择手动分发（无 execute），与内置的 writeFile/shell 保持一致的权限模型。

### 3. sub-agent 不注入 MCP 工具

`buildTools` 在 `toolsOverride != null`（sub-agent 场景）时直接返回，不注入 MCP 工具。
这是合理的：sub-agent 的工具白名单由 `built-in.ts` 固定，不应该随意扩展。
如果需要在 sub-agent 中使用 MCP 工具，需要在白名单中明确列出。

## 如何验证

```bash
# 创建用户级 MCP 配置
mkdir -p ~/.mini-code
cat > ~/.mini-code/mcp.json << 'EOF'
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  ]
}
EOF

# 启动 mini-code-cli（需要 ANTHROPIC_API_KEY）
node packages/cli/dist/cli.js

# 在对话中要求模型使用 MCP 工具
# 模型应该能调用 filesystem__readFile 等工具
```

## 扩展方向

1. **更多 transport 支持**：WebSocket transport（`client/websocket.js`）
2. **MCP 工具发现提示**：在系统提示中追加 `toSystemPromptEntries()` 内容
3. **sub-agent MCP 白名单**：允许特定 sub-agent 访问特定 MCP 服务器
4. **热重载**：运行时重新加载 MCP 配置（`/mcp reload` 命令）

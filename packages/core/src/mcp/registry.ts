// @mini-code-cli/core — McpRegistry 实现
//
// McpRegistry 是运行时管理所有已连接 MCP 服务器的容器。
//
// 职责：
//   - 持有所有 McpEntry 的有序列表
//   - 提供按名查找（get）和调用工具（callTool）的统一接口
//   - 在进程退出时 shutdown() 关闭所有连接
//
// 设计：
//   - 不可变性：McpRegistry 创建后列表不变（加载时一次性连接所有服务器）
//   - 轻量：只是对 McpEntry[] 的简单包装，核心逻辑在 entry.callTool
import type { McpEntry, McpRegistry } from './types.js'

// ── createMcpRegistry ─────────────────────────────────────────────────────────

/** 用已连接的 McpEntry 列表创建 McpRegistry 实例。
 *
 *  由 loadMcpFromDisk() 调用，在所有服务器连接完成后组装。
 *
 *  @param entries  已成功连接并初始化的 McpEntry 列表
 *  @returns        McpRegistry 实例
 */
export function createMcpRegistry(entries: McpEntry[]): McpRegistry {
  // 复制一份，避免外部修改 entries 数组影响注册表
  const list = [...entries]

  return {
    list() {
      return list
    },

    get(serverName: string) {
      return list.find((e) => e.serverName === serverName)
    },

    async callTool(
      serverName: string,
      toolName: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<string> {
      const entry = list.find((e) => e.serverName === serverName)
      if (!entry) {
        return `Error: MCP server "${serverName}" not found. Available: ${list.map((e) => e.serverName).join(', ') || '(none)'}`
      }
      return entry.callTool(toolName, input, signal)
    },

    async shutdown(): Promise<void> {
      // 并行关闭所有连接，忽略单个关闭错误
      await Promise.allSettled(list.map((e) => e.shutdown()))
    },
  }
}

// ── emptyMcpRegistry ──────────────────────────────────────────────────────────

/** 空 McpRegistry（无任何服务器连接）。
 *
 *  agentLoop 在 MCP 未启用或加载失败时使用此实例，
 *  确保代码路径统一（不需要判断 registry 是否为 null）。
 */
export const emptyMcpRegistry: McpRegistry = {
  list: () => [],
  get: () => undefined,
  callTool: async (serverName: string) =>
    `Error: No MCP servers loaded (tried to call "${serverName}").`,
  shutdown: async () => {},
}

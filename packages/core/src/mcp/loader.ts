// @mini-code-cli/core — MCP 配置加载器
//
// 从磁盘加载 MCP 配置，依次连接服务器，组装 McpRegistry。
//
// 配置文件查找顺序（层叠加载，后者覆盖同名服务器）：
//   1. 用户级：~/.mini-code/mcp.json
//   2. 项目级：<cwd>/.mini-code/mcp.json（需要 trust 确认，可选）
//
// 配置文件格式：
//   {
//     "servers": [
//       { "name": "filesystem", "transport": "stdio", "command": "npx", "args": ["@modelcontextprotocol/server-filesystem", "/tmp"] },
//       { "name": "custom-api", "transport": "http", "url": "http://localhost:3000/mcp" }
//     ]
//   }
//
// 设计决策：
//   - loadMcpFromDisk() 是异步工厂，agentLoop 在 buildTools 时调用
//   - 连接失败的服务器仅打印警告，不阻断启动
//   - 项目级配置需要 trust 对话框（通过 onAskUser 回调）；--trust 模式自动跳过对话
//   - 返回 McpRegistry 实例，agentLoop 把它存在 LoopState 或直接传给 buildTools
import fs from 'node:fs/promises'
import path from 'node:path'

import { MINI_CODE_DIR, USER_MINI_CODE_DIR } from '../utils.js'
import { connectMcpServer } from './client.js'
import { createMcpRegistry } from './registry.js'
import type { McpEntry, McpRegistry, McpServerConfig } from './types.js'
import { askProjectMcpTrust, isProjectMcpTrusted } from './trust.js'

// ── config file ───────────────────────────────────────────────────────────────

interface McpConfigFile {
  servers?: McpServerConfig[]
}

async function readConfigFile(filePath: string): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const data = JSON.parse(raw) as McpConfigFile
    if (!Array.isArray(data.servers)) return []
    return data.servers.filter(
      (s): s is McpServerConfig =>
        typeof s === 'object' && s !== null && typeof s.name === 'string' && typeof s.transport === 'string',
    )
  } catch {
    return []
  }
}

// ── loadMcpFromDisk ────────────────────────────────────────────────────────────

/** 加载所有 MCP 服务器配置，建立连接，返回 McpRegistry。
 *
 *  @param cwd          当前工作目录（用于查找项目级配置）
 *  @param trustMode    true = --trust 模式，自动信任项目 MCP 配置（不弹对话框）
 *  @param onAskUser    用于项目级 trust 确认的交互回调（trustMode=true 时不调用）
 *  @returns            初始化好的 McpRegistry（含所有已连接服务器）
 */
export async function loadMcpFromDisk(
  cwd: string,
  trustMode: boolean,
  onAskUser?: (question: string, options: { label: string; description: string }[]) => Promise<string>,
): Promise<McpRegistry> {
  const entries: McpEntry[] = []
  const connectedNames = new Set<string>()

  // ── 1. 用户级配置（~/.mini-code/mcp.json）────────────────────────────────
  const userConfigPath = path.join(USER_MINI_CODE_DIR, 'mcp.json')
  const userServers = await readConfigFile(userConfigPath)

  for (const serverConfig of userServers) {
    if (connectedNames.has(serverConfig.name)) {
      console.warn(`[MCP] Duplicate server name "${serverConfig.name}" in user config, skipping`)
      continue
    }
    try {
      const entry = await connectMcpServer(serverConfig)
      entries.push(entry)
      connectedNames.add(serverConfig.name)
    } catch (err) {
      console.warn(
        `[MCP] Failed to connect to "${serverConfig.name}" (user config):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── 2. 项目级配置（<cwd>/.mini-code/mcp.json）───────────────────────────
  const projectConfigPath = path.join(cwd, MINI_CODE_DIR, 'mcp.json')
  const projectServers = await readConfigFile(projectConfigPath)

  if (projectServers.length > 0) {
    // 检查是否已信任该项目
    let trusted = trustMode || isProjectMcpTrusted(cwd, cwd)

    if (!trusted && onAskUser) {
      // 弹 trust 对话框
      trusted = await askProjectMcpTrust(
        projectConfigPath,
        projectServers.map((s) => s.name),
        onAskUser,
        cwd,
      )
    } else if (!trusted && !onAskUser) {
      // 无法询问用户，静默跳过项目级配置
      console.warn(`[MCP] Skipping project MCP config (not trusted): ${projectConfigPath}`)
    }

    if (trusted) {
      for (const serverConfig of projectServers) {
        if (connectedNames.has(serverConfig.name)) {
          // 项目级配置覆盖用户级：先关闭旧连接
          const existing = entries.find((e) => e.serverName === serverConfig.name)
          if (existing) {
            await existing.shutdown().catch(() => {})
            const idx = entries.indexOf(existing)
            if (idx !== -1) entries.splice(idx, 1)
          }
        }
        try {
          const entry = await connectMcpServer(serverConfig)
          entries.push(entry)
          connectedNames.add(serverConfig.name)
        } catch (err) {
          console.warn(
            `[MCP] Failed to connect to "${serverConfig.name}" (project config):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
  }

  return createMcpRegistry(entries)
}

// @mini-code-cli/core — MCP 工具专用权限存储
//
// MCP 工具与普通内置工具的权限存储独立，原因：
//   1. MCP 工具名含 "__" 前缀（如 "filesystem__readFile"），
//      与内置工具（readFile/shell 等）的权限规则存储在不同 key 空间
//   2. MCP 工具的 always-allow 以服务器粒度记录（整个服务器的工具都允许），
//      或以工具粒度记录（具体工具名）
//   3. 持久化到 .mini-code/local/mcp-permissions.json
//
// 数据模型（JSON 文件）：
//   {
//     "alwaysAllow": {
//       "filesystem__readFile": true,    // 单个工具级别
//       "filesystem__*": true,           // 整个服务器级别（通配符）
//     }
//   }
import * as fs from 'node:fs'
import * as path from 'node:path'

import { MINI_CODE_DIR } from '../utils.js'

// ── file path ─────────────────────────────────────────────────────────────────

function getMcpPermissionsPath(cwd: string): string {
  return path.join(cwd, MINI_CODE_DIR, 'local', 'mcp-permissions.json')
}

// ── load / save ───────────────────────────────────────────────────────────────

function loadAlwaysAllow(cwd: string): Record<string, boolean> {
  const filePath = getMcpPermissionsPath(cwd)
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as { alwaysAllow?: Record<string, boolean> }
    return typeof data.alwaysAllow === 'object' && data.alwaysAllow !== null ? data.alwaysAllow : {}
  } catch {
    return {}
  }
}

function saveAlwaysAllow(cwd: string, alwaysAllow: Record<string, boolean>): void {
  const filePath = getMcpPermissionsPath(cwd)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  // 保证 local/ 目录有 .gitignore，防止用户权限偏好进入版本控制
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify({ alwaysAllow }, null, 2) + '\n', 'utf-8')
}

// ── public API ────────────────────────────────────────────────────────────────

/** 检查指定 MCP 工具是否在 always-allow 列表中。
 *
 *  匹配优先级：
 *    1. 精确工具名匹配（"filesystem__readFile"）
 *    2. 服务器通配符匹配（"filesystem__*"）
 *
 *  @param mangledName  命名空间化工具名（如 "filesystem__readFile"）
 *  @param cwd          工作目录（用于定位权限文件）
 */
export function isMcpToolAlwaysAllowed(mangledName: string, cwd: string): boolean {
  const alwaysAllow = loadAlwaysAllow(cwd)
  // 精确匹配
  if (alwaysAllow[mangledName]) return true
  // 服务器级通配符：取 "__" 前的服务器名 + "__*"
  const sepIdx = mangledName.indexOf('__')
  if (sepIdx !== -1) {
    const serverWildcard = `${mangledName.slice(0, sepIdx)}__*`
    if (alwaysAllow[serverWildcard]) return true
  }
  return false
}

/** 将单个 MCP 工具设为 always-allow（工具级别）。
 *
 *  @param mangledName  命名空间化工具名（如 "filesystem__readFile"）
 *  @param cwd          工作目录
 */
export function allowMcpTool(mangledName: string, cwd: string): void {
  const alwaysAllow = loadAlwaysAllow(cwd)
  alwaysAllow[mangledName] = true
  saveAlwaysAllow(cwd, alwaysAllow)
}

/** 将整个 MCP 服务器的所有工具设为 always-allow（服务器级别通配符）。
 *
 *  @param serverName  服务器名称（如 "filesystem"）
 *  @param cwd         工作目录
 */
export function allowMcpServer(serverName: string, cwd: string): void {
  const alwaysAllow = loadAlwaysAllow(cwd)
  alwaysAllow[`${serverName}__*`] = true
  saveAlwaysAllow(cwd, alwaysAllow)
}

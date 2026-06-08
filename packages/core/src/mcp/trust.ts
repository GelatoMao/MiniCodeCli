// @mini-code-cli/core — MCP 项目级配置 Trust 对话框
//
// 问题：
//   项目 .mini-code/mcp.json 可能包含恶意服务器（执行任意代码）。
//   在自动加载之前，需要用户明确表示信任该项目的 MCP 配置。
//
// 设计：
//   - 信任决策持久化到 .mini-code/local/mcp-trust.json
//   - 已信任的项目路径直接加载，不重复弹对话框
//   - 用户拒绝时跳过项目级配置（不阻断启动，只是不加载项目 MCP 服务器）
//
// 使用场景：
//   loadMcpFromDisk() 在加载项目级配置前调用 ensureProjectMcpTrusted()
import * as fs from 'node:fs'
import * as path from 'node:path'

import { MINI_CODE_DIR } from '../utils.js'

// ── trust record ─────────────────────────────────────────────────────────────

function getTrustFilePath(cwd: string): string {
  return path.join(cwd, MINI_CODE_DIR, 'local', 'mcp-trust.json')
}

function loadTrustedProjects(cwd: string): string[] {
  const filePath = getTrustFilePath(cwd)
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as { trustedPaths?: string[] }
    return Array.isArray(data.trustedPaths) ? data.trustedPaths : []
  } catch {
    return []
  }
}

function saveTrustedProject(cwd: string, projectPath: string): void {
  const filePath = getTrustFilePath(cwd)
  const trusted = loadTrustedProjects(cwd)
  if (trusted.includes(projectPath)) return
  trusted.push(projectPath)

  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify({ trustedPaths: trusted }, null, 2) + '\n', 'utf-8')
}

// ── public API ────────────────────────────────────────────────────────────────

/** 检查指定项目目录的 MCP 配置是否已被信任。*/
export function isProjectMcpTrusted(projectPath: string, cwd: string): boolean {
  return loadTrustedProjects(cwd).includes(projectPath)
}

/** 记录用户已信任该项目的 MCP 配置。*/
export function trustProjectMcp(projectPath: string, cwd: string): void {
  saveTrustedProject(cwd, projectPath)
}

/** 询问用户是否信任项目 MCP 配置（通过 onAskUser 回调）。
 *
 *  @param projectConfigPath   项目 mcp.json 文件路径（显示给用户）
 *  @param serverNames         待加载的服务器名称列表（显示给用户）
 *  @param onAskUser           来自 AgentCallbacks 的交互回调
 *  @param cwd                 工作目录（用于定位信任记录文件）
 *  @returns                   true=用户同意; false=用户拒绝
 */
export async function askProjectMcpTrust(
  projectConfigPath: string,
  serverNames: string[],
  onAskUser: (question: string, options: { label: string; description: string }[]) => Promise<string>,
  cwd: string,
): Promise<boolean> {
  const names = serverNames.length > 0 ? serverNames.join(', ') : '(none)'
  const question =
    `This project has a MCP configuration file:\n  ${projectConfigPath}\n\n` +
    `Servers to load: ${names}\n\n` +
    `Loading project MCP servers will execute code on your machine. ` +
    `Trust this project's MCP configuration?`

  const answer = await onAskUser(question, [
    { label: 'Yes, trust this project', description: 'Load project MCP servers and remember this decision.' },
    { label: 'No', description: 'Skip project MCP servers this session.' },
  ])

  if (answer.toLowerCase().startsWith('yes') || answer.toLowerCase().startsWith('y')) {
    trustProjectMcp(cwd, cwd)
    return true
  }
  return false
}

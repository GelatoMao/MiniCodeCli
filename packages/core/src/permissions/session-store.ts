// @mini-code-cli/core — 权限记忆，支持磁盘持久化。
//
// 当用户对某个工具调用选择"以后不再询问"时，
// 决策以 AllowRule 的形式同时存储在内存和磁盘中
// （位于 `.mini-code/local/permissions.json`）。
// 下次启动时加载持久化规则，批准决策可以跨会话保留。
//
// 精简版本相对于原始 x-code-cli 的简化：
// - 移除了复杂的 extractCommandPrefix / extractCompoundRules 等函数
//   （这些在任务6的 agent loop 接入时再补充）
// - 保留了核心的 AllowRule、SessionPermissionStore 和磁盘 I/O
// - buildAllowRule 采用简化策略：shell 用精确匹配，其他工具用 tool 级别
import * as fs from 'node:fs'
import * as path from 'node:path'

import { MINI_CODE_DIR } from '../utils.js'

// ─── AllowRule 类型 ───

export interface AllowRule {
  tool: string
  /** 匹配模式：精确命令字符串 / 命令前缀 / '*'（匹配整个工具） */
  pattern: string
  /** 匹配类型：
   * - 'exact'：精确匹配完整命令
   * - 'prefix'：前缀匹配（命令以此开头即可）
   * - 'tool'：匹配该工具的任何调用
   */
  type: 'exact' | 'prefix' | 'tool'
}

// ─── 序列化/反序列化 ───

function ruleToString(rule: AllowRule): string {
  if (rule.type === 'tool') return `${rule.tool}:*`
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`
  return `${rule.tool}:=${rule.pattern}`
}

function parseRuleString(s: string): AllowRule | null {
  // tool:*  → 工具级别
  const toolWide = s.match(/^([^:]+):\*$/)
  if (toolWide) return { tool: toolWide[1]!, pattern: '*', type: 'tool' }
  // tool:prefix:*  → 前缀匹配
  const prefix = s.match(/^([^:]+):(.+):\*$/)
  if (prefix) return { tool: prefix[1]!, pattern: prefix[2]!, type: 'prefix' }
  // tool:=exact  → 精确匹配
  const exact = s.match(/^([^:]+):=(.+)$/)
  if (exact) return { tool: exact[1]!, pattern: exact[2]!, type: 'exact' }
  return null
}

function getPermissionsPath(cwd: string): string {
  return path.join(cwd, MINI_CODE_DIR, 'local', 'permissions.json')
}

// ─── 内存存储 ───

/**
 * 会话级权限存储。
 *
 * 对于 shell 工具，支持三种匹配规则（tool / prefix / exact）；
 * 对于其他工具，只支持 tool 级别的规则。
 */
class SessionPermissionStore {
  private rules: AllowRule[] = []

  addRule(rule: AllowRule): void {
    const exists = this.rules.some(
      (r) => r.tool === rule.tool && r.pattern === rule.pattern && r.type === rule.type,
    )
    if (!exists) this.rules.push(rule)
  }

  matches(toolName: string, input: Record<string, unknown>): boolean {
    if (toolName !== 'shell') {
      // 非 shell 工具：目前只有 tool 级别的规则
      for (const rule of this.rules) {
        if (rule.tool !== toolName) continue
        if (rule.type === 'tool') return true
      }
      return false
    }

    const cmd = (input.command as string) ?? ''

    // 工具级别规则
    for (const rule of this.rules) {
      if (rule.tool !== toolName) continue
      if (rule.type === 'tool') return true
      if (rule.type === 'exact' && cmd === rule.pattern) return true
      if (rule.type === 'prefix' && cmd.startsWith(rule.pattern)) return true
    }
    return false
  }

  clear(): void {
    this.rules = []
  }

  get size(): number {
    return this.rules.length
  }
}

const store = new SessionPermissionStore()

export function addSessionAllowRule(rule: AllowRule): void {
  store.addRule(rule)
}

export function sessionRulesMatch(toolName: string, input: Record<string, unknown>): boolean {
  return store.matches(toolName, input)
}

export function clearSessionRules(): void {
  store.clear()
}

// ─── 磁盘持久化 ───

/**
 * 从 `.mini-code/local/permissions.json` 加载持久化规则到内存存储。
 * 可以多次调用（内部去重）。文件不存在或格式错误时静默忽略。
 */
export function loadPersistedRules(cwd: string): void {
  const filePath = getPermissionsPath(cwd)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return
  }
  let data: { allow?: string[] }
  try {
    data = JSON.parse(raw) as { allow?: string[] }
  } catch {
    return
  }
  if (!Array.isArray(data.allow)) return
  for (const entry of data.allow) {
    if (typeof entry !== 'string') continue
    const rule = parseRuleString(entry)
    if (rule) store.addRule(rule)
  }
}

/**
 * 将新规则持久化到 `.mini-code/local/permissions.json`。
 * 文件不存在时创建。不重复追加。
 * 同时在 local/ 目录创建 `.gitignore` 防止权限文件进入 git。
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const ruleStr = ruleToString(rule)

  const data: { allow: string[] } = { allow: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { allow?: string[] }
    if (Array.isArray(parsed.allow)) {
      data.allow = parsed.allow.filter((s): s is string => typeof s === 'string')
    }
  } catch {
    // 文件不存在或格式错误 — 从空数组开始
  }

  if (data.allow.includes(ruleStr)) return

  data.allow.push(ruleStr)

  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  // 在 local/ 目录首次写入时放置 .gitignore，防止用户的权限偏好泄漏到 git
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

// ─── buildAllowRule（简化版） ───

/**
 * 为"以后不再询问"批准构建 AllowRule。
 *
 * 简化策略：
 * - shell：使用精确匹配（任务6再补全前缀提取逻辑）
 * - writeFile / edit：工具级别，仅会话（不持久化）
 * - 其他工具：工具级别，持久化
 */
export function buildAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): { rules: AllowRule[]; persist: boolean } | null {
  if (toolName === 'shell') {
    const cmd = (input.command as string) ?? ''
    if (!cmd) return null
    return { rules: [{ tool: toolName, pattern: cmd, type: 'exact' }], persist: true }
  }
  return { rules: [{ tool: toolName, pattern: '*', type: 'tool' }], persist: false }
}

/**
 * 生成"以后不再询问"选项的显示标签。
 * shell 工具显示 "this exact command"，其他工具显示 "all edits this session"。
 */
export function suggestRuleLabel(toolName: string, _input: Record<string, unknown>): string | null {
  if (toolName === 'shell') return 'this exact command'
  if (toolName === 'writeFile' || toolName === 'edit') return 'all edits this session'
  return null
}

// @mini-code-cli/core — 权限系统（3 级决策模型）
//
// 权限分为 3 个级别：
//   always-allow — 静默自动允许（只读工具）
//   ask          — 弹出交互式确认对话框
//   deny         — 静默拒绝（破坏性命令）
//
// 决策流程：
//   1. getPermissionLevel() — 根据工具名和输入确定基础级别
//   2. trustMode — 全局覆盖，beats 除 deny 之外的一切
//   3. acceptEdits 模式 — 对项目内非敏感路径的写工具自动允许
//   4. sessionRulesMatch() — 检查用户是否已批准过"以后不再询问"
//   5. onAskPermission() — 弹出交互式对话框等待用户决策
import path from 'node:path'

import { isDestructive, isReadOnly, splitShellCommands } from '../tools/shell-utils.js'
import type { PermissionLevel, PermissionMode } from '../types/index.js'
import { addSessionAllowRule, buildAllowRule, persistRule, sessionRulesMatch } from './session-store.js'

type PermissionInput = Record<string, unknown>

// ─── Shell 权限缓存（LRU-cap） ───

/**
 * 进程生命周期内的 shell 权限级别缓存，以精确命令字符串为键。
 * 破坏性/只读模式匹配是静态的，缓存是安全的——不需要 TTL。
 * 上限 256 条防止长时间运行的 agent 无限积累唯一命令。
 */
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()

function evaluateShellPermission(command: string): PermissionLevel {
  const subCommands = splitShellCommands(command)
  // 任何子命令破坏性 → 拒绝整个命令
  if (subCommands.some(isDestructive)) return 'deny'
  // 所有子命令都只读 → 自动允许
  if (subCommands.every(isReadOnly)) return 'always-allow'
  // 否则 → 询问
  return 'ask'
}

function resolveShellPermission(input: PermissionInput): PermissionLevel {
  const cmd = (input.command as string) ?? ''
  const cached = shellPermissionCache.get(cmd)
  if (cached) return cached

  const level = evaluateShellPermission(cmd)

  if (shellPermissionCache.size >= SHELL_PERMISSION_CACHE_MAX) {
    // 驱逐最旧的条目（Map 保持插入顺序）
    const oldest = shellPermissionCache.keys().next().value
    if (oldest !== undefined) shellPermissionCache.delete(oldest)
  }
  shellPermissionCache.set(cmd, level)
  return level
}

// ─── 工具权限规则表 ───

/** 每个工具的权限规则 */
const rules: Record<string, (input: PermissionInput) => PermissionLevel> = {
  readFile: () => 'always-allow',
  glob: () => 'always-allow',
  grep: () => 'always-allow',
  listDir: () => 'always-allow',
  edit: () => 'ask',
  writeFile: () => 'ask',
  shell: resolveShellPermission,
}

/** 获取工具调用的权限级别 */
export function getPermissionLevel(toolName: string, input: PermissionInput): PermissionLevel {
  const rule = rules[toolName]
  if (!rule) return 'ask' // 未知工具默认询问
  return rule(input)
}

// ─── 敏感路径保护 ───

// 永远不应被自动批准的敏感 dotfile/配置路径。
// 匹配 Claude Code 的 isDangerousFilePathToAutoEdit 判断。
const SENSITIVE_PATH_PATTERNS = [
  /[\\/]\.bashrc$/,
  /[\\/]\.bash_profile$/,
  /[\\/]\.profile$/,
  /[\\/]\.zshrc$/,
  /[\\/]\.zprofile$/,
  /[\\/]\.gitconfig$/,
  /[\\/]\.ssh[\\/]/,
  /[\\/]\.env$/,
  /[\\/]\.git[\\/]/,
  /[\\/]\.vscode[\\/]/,
  /[\\/]\.idea[\\/]/,
]

/**
 * 判断 `filePath` 是否在 `projectDir` 内（包括等于）。
 * 两者都规范化为前斜杠小写，避免 Windows 盘符差异和末尾斜杠问题。
 */
export function isPathWithinProject(filePath: string, projectDir: string): boolean {
  const normalize = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase()
  const file = normalize(filePath)
  const dir = normalize(projectDir)
  return file === dir || file.startsWith(dir + '/')
}

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))
}

// ─── checkPermission 主函数 ───

/**
 * 含 trustMode + permissionMode 支持的完整权限检查。
 *
 * `permissionMode` 语义：
 *   - 'default'：正常行为 — ask 级别的工具弹出确认框。
 *   - 'acceptEdits'：自动允许 `writeFile` 和 `edit`，
 *     **仅当目标路径在项目目录内**且不是敏感 dotfile 时。
 *     项目外路径或敏感路径回退到 ask，用户必须显式同意。
 *     Shell 仍经过正常分类，破坏性命令仍然被拦截。
 *   - 'plan'：纯提示词执行，权限层不变（镜像 Claude Code）—
 *     系统提示 overlay 告知模型不要写文件；如果模型无视，
 *     常规的 ask 提示仍然触发。
 *
 * trustMode 是全局覆盖，优先级高于一切，除了明确的 deny。
 */
export async function checkPermission(
  toolCall: { toolCallId: string; toolName: string; input: PermissionInput },
  trustMode: boolean,
  onAskPermission: (toolCall: {
    toolCallId: string
    toolName: string
    input: PermissionInput
  }) => Promise<'yes' | 'always' | 'no'>,
  permissionMode: PermissionMode = 'default',
  cwd?: string,
): Promise<boolean> {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)

  // deny 级别：无论 trustMode 如何都拒绝
  if (level === 'deny') return false

  // always-allow 或 trustMode：直接放行
  if (level === 'always-allow' || trustMode) return true

  // acceptEdits 模式：对安全的项目内写操作自动允许
  if (permissionMode === 'acceptEdits' && (toolCall.toolName === 'writeFile' || toolCall.toolName === 'edit')) {
    const filePath = (toolCall.input.filePath as string) ?? ''
    const projectDir = cwd ?? process.cwd()
    if (filePath && isPathWithinProject(filePath, projectDir) && !isSensitivePath(filePath)) {
      return true
    }
    // 项目外路径或敏感文件 — 回退到 ask
  }

  // 会话规则：已批准过"以后不再询问"的直接放行
  if (sessionRulesMatch(toolCall.toolName, toolCall.input)) return true

  // 弹出交互式确认对话框
  const decision = await onAskPermission(toolCall)

  if (decision === 'always') {
    const result = buildAllowRule(toolCall.toolName, toolCall.input)
    if (result) {
      // buildAllowRule 可能为复合 shell 命令返回多条规则
      for (const rule of result.rules) {
        addSessionAllowRule(rule)
        if (result.persist && cwd) persistRule(cwd, rule)
      }
    }
    return true
  }
  return decision === 'yes'
}

// 重新导出 session-store 的公共 API，方便上层直接从 permissions 包导入
export { addSessionAllowRule, clearSessionRules, buildAllowRule, suggestRuleLabel } from './session-store.js'
export { loadPersistedRules, persistRule } from './session-store.js'

// @mini-code-cli/core — 自定义 Sub-Agent 加载器
//
// 从磁盘上的 Markdown 文件加载用户自定义 sub-agent 定义。
//
// 搜索路径（优先级由低到高，同名 agent 后者覆盖前者）：
//   1. ~/.x-code/agents/*.md           全局自定义 agent（跨项目共享）
//   2. <cwd>/.x-code/agents/*.md       项目级自定义 agent（项目私有）
//
// Markdown 格式约定：
//   ---
//   name: my-agent
//   description: 这个 agent 的能力描述
//   allowedTools: readFile, glob, grep, listDir
//   ---
//
//   这里是系统提示正文（YAML frontmatter 之后的所有内容）。
//
// 字段说明：
//   name          必填。唯一标识符（小写字母、数字、连字符）。
//   description   必填。向父 AI 展示的能力描述。
//   allowedTools  可选。逗号分隔的工具名列表；省略则继承所有工具（空数组）。
//   （正文）      作为 systemPrompt。
//
// 加载失败（文件不存在、解析错误）时静默忽略，不影响已加载的其他 agent。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SubAgentDef } from './types.js'

// ── YAML frontmatter 解析 ─────────────────────────────────────────────────────

interface Frontmatter {
  name?: string
  description?: string
  allowedTools?: string
}

/**
 * 解析简单的 YAML frontmatter（仅支持 key: value 格式）。
 * 不依赖外部 YAML 库，避免增加依赖。
 *
 * 输入示例：
 *   name: my-agent
 *   description: Explore codebase
 *   allowedTools: readFile, glob
 */
function parseFrontmatter(raw: string): Frontmatter {
  const result: Frontmatter = {}
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\w+)\s*:\s*(.+)$/)
    if (!match) continue
    const key = match[1]!.trim()
    const value = match[2]!.trim()
    if (key === 'name') result.name = value
    else if (key === 'description') result.description = value
    else if (key === 'allowedTools') result.allowedTools = value
  }
  return result
}

// ── parseAgentFile ─────────────────────────────────────────────────────────────

/**
 * 解析单个 Markdown 文件，返回 SubAgentDef 或 null（解析失败时）。
 *
 * 解析规则：
 *   - 文件必须以 `---\n` 开头（YAML frontmatter 开始标记）
 *   - frontmatter 到下一个 `---` 结束
 *   - frontmatter 之后的内容作为 systemPrompt
 *   - name 和 description 是必填字段
 *   - allowedTools 是可选字段，省略时为空数组（继承所有工具）
 */
function parseAgentFile(content: string, filePath: string): SubAgentDef | null {
  if (!content.startsWith('---')) {
    return null
  }

  // 找到第二个 '---' 结束标记
  const fmEnd = content.indexOf('\n---', 3)
  if (fmEnd === -1) {
    return null
  }

  const fmRaw = content.slice(3, fmEnd).trim()
  const systemPrompt = content.slice(fmEnd + 4).trim() // 跳过 '\n---'

  const fm = parseFrontmatter(fmRaw)

  if (!fm.name || !fm.description) {
    // 缺少必填字段，静默跳过
    return null
  }

  // 验证 name 格式（只允许小写字母、数字、连字符）
  if (!/^[a-z0-9-]+$/.test(fm.name)) {
    return null
  }

  // 解析 allowedTools：逗号分隔，去除空白
  let allowedTools: string[] = []
  if (fm.allowedTools) {
    allowedTools = fm.allowedTools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  return {
    name: fm.name,
    description: fm.description,
    systemPrompt: systemPrompt || `You are the "${fm.name}" assistant.`,
    allowedTools,
  }
}

// ── loadAgentsFromDir ─────────────────────────────────────────────────────────

/**
 * 从指定目录加载所有 *.md 文件并解析为 SubAgentDef。
 * 目录不存在时返回空数组（不报错）。
 */
async function loadAgentsFromDir(dir: string): Promise<SubAgentDef[]> {
  const agents: SubAgentDef[] = []

  let entries: string[]
  try {
    const dirEntries = await fs.readdir(dir)
    entries = dirEntries.filter((f) => f.endsWith('.md'))
  } catch {
    // 目录不存在或没有读取权限，静默忽略
    return agents
  }

  for (const filename of entries) {
    const filePath = path.join(dir, filename)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const def = parseAgentFile(content, filePath)
      if (def) agents.push(def)
    } catch {
      // 单个文件读取/解析失败，静默跳过
    }
  }

  return agents
}

// ── loadCustomAgents ──────────────────────────────────────────────────────────

/**
 * 从全局配置目录和项目配置目录加载自定义 sub-agent 定义。
 *
 * 合并策略：同名 agent 以项目级优先（项目级覆盖全局级）。
 *
 * @param cwd 当前工作目录（默认 process.cwd()），用于定位项目级 agents 目录。
 */
export async function loadCustomAgents(cwd?: string): Promise<SubAgentDef[]> {
  const workDir = cwd ?? process.cwd()

  // 全局 agents 目录：~/.x-code/agents/
  const globalAgentsDir = path.join(os.homedir(), '.x-code', 'agents')
  // 项目级 agents 目录：<cwd>/.x-code/agents/
  const projectAgentsDir = path.join(workDir, '.x-code', 'agents')

  // 并行加载两个目录
  const [globalAgents, projectAgents] = await Promise.all([
    loadAgentsFromDir(globalAgentsDir),
    loadAgentsFromDir(projectAgentsDir),
  ])

  // 合并：项目级同名 agent 覆盖全局级
  const merged = new Map<string, SubAgentDef>()
  for (const def of globalAgents) merged.set(def.name, def)
  for (const def of projectAgents) merged.set(def.name, def)

  return Array.from(merged.values())
}

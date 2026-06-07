// @mini-code-cli/core — Sub-Agent 注册表
//
// createSubAgentRegistry() 合并内置 agent 和自定义 agent，
// 返回一个实现 SubAgentRegistry 接口的对象。
//
// 合并策略：
//   - 自定义 agent（来自用户 ~/.x-code/agents/ 和项目 .x-code/agents/）
//     可以**覆盖**同名内置 agent
//   - 这允许用户定制 "explore"、"plan" 等内置 agent 的行为
//
// 使用方式：
//   const registry = await createSubAgentRegistry(cwd)
//   const def = registry.get('explore')
//   const allDefs = registry.list()
import { BUILT_IN_AGENTS } from './built-in.js'
import { loadCustomAgents } from './loader.js'
import type { SubAgentDef, SubAgentRegistry } from './types.js'

// ── createSubAgentRegistry ────────────────────────────────────────────────────

/**
 * 创建并返回 Sub-Agent 注册表。
 *
 * 加载顺序（后者覆盖前者）：
 *   1. 内置 agent（BUILT_IN_AGENTS）
 *   2. 全局自定义 agent（~/.x-code/agents/*.md）
 *   3. 项目自定义 agent（<cwd>/.x-code/agents/*.md）
 *
 * @param cwd 当前工作目录（默认 process.cwd()），用于加载项目级自定义 agent。
 */
export async function createSubAgentRegistry(cwd?: string): Promise<SubAgentRegistry> {
  // 加载自定义 agent（全局 + 项目级，已在 loadCustomAgents 内合并）
  const customAgents = await loadCustomAgents(cwd)

  // 合并：先内置，后自定义（同名时自定义覆盖内置）
  const merged = new Map<string, SubAgentDef>()
  for (const def of BUILT_IN_AGENTS) merged.set(def.name, def)
  for (const def of customAgents) merged.set(def.name, def)

  const agents = Array.from(merged.values())

  return {
    get(name: string): SubAgentDef | undefined {
      return merged.get(name)
    },
    list(): SubAgentDef[] {
      return agents
    },
  }
}

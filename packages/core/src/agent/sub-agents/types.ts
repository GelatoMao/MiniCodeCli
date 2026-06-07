// @mini-code-cli/core — Sub-Agent 类型定义
//
// Sub-Agent（task 工具）允许 AI 将子任务委托给一个独立运行的 agentLoop：
//   - 每个 sub-agent 有自己独立的 LoopState（隔离上下文）
//   - 工具白名单限制 sub-agent 能使用的工具集（安全边界）
//   - 禁止递归调用 task 工具（防止无限嵌套）
//   - token 用量汇聚回 parentState（方便统计总消耗）
//
// SubAgentDef：描述一个 agent 的静态定义（身份标识 + 能力边界）。
// SubAgentRegistry：运行时注册表，按名称查找和枚举 sub-agent 定义。

// ── SubAgentDef ──────────────────────────────────────────────────────────────

/**
 * Sub-Agent 定义。
 *
 * 每个 sub-agent 由以下几部分组成：
 *   - name：唯一标识符，用于在 task 工具的 `subagent` 参数中引用
 *   - description：给父 AI 看的说明（task 工具 schema 展示），
 *     决定父 AI 何时选择委托给该 sub-agent
 *   - systemPrompt：注入给 sub-agent 的专属系统提示，
 *     覆盖或补充全局系统提示
 *   - allowedTools：工具白名单（空数组表示允许所有工具）
 *     出于安全考虑，sub-agent 始终不能调用 task 工具（防止递归）
 */
export interface SubAgentDef {
  /** 唯一名称，供 task 工具的 subagent 参数引用（如 "explore"、"code-reviewer"）。*/
  name: string
  /** 向父 AI 展示的能力描述，决定何时被选择委托。*/
  description: string
  /** 注入该 sub-agent 的专属系统提示（追加到全局系统提示之后）。*/
  systemPrompt: string
  /**
   * 该 sub-agent 允许调用的工具名列表。
   * 空数组表示继承父 agent 的全部工具（task 工具除外）。
   * 非空数组时，sub-agent 只能调用列表内的工具。
   */
  allowedTools: string[]
}

// ── SubAgentRegistry ─────────────────────────────────────────────────────────

/**
 * Sub-Agent 注册表接口。
 *
 * 运行时通过此接口查找和枚举已注册的 sub-agent 定义。
 * 实现由 createSubAgentRegistry() 提供。
 */
export interface SubAgentRegistry {
  /** 按名称查找 sub-agent 定义，未找到返回 undefined。*/
  get(name: string): SubAgentDef | undefined
  /** 返回所有已注册的 sub-agent 定义列表。*/
  list(): SubAgentDef[]
}

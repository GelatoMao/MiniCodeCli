// @mini-code-cli/core — task 工具定义（Sub-Agent 委托）
//
// task 工具让父 AI 能把子任务委托给一个专用的独立 sub-agent。
// 工具 schema（inputSchema）由这里定义；
// 实际执行逻辑在 agent/tool-execution.ts 的 BYPASS_LOOP_GUARD_HANDLERS 中处理
//（task 工具绕过循环守卫和权限检查，有自己的执行路径）。
//
// 动态工具创建：
//   createTaskTool(registry) 根据注册表中的 sub-agent 列表动态生成工具 schema。
//   这样 AI 能看到当前可用的 sub-agent 名称和描述，做出准确的委托决策。
//
// 为什么不使用 auto-execute？
//   task 工具需要：
//     1. 独立管理 LoopState（runSubAgent）
//     2. 汇聚 token 用量到 parentState
//     3. 转发 UI 回调（传递给 runSubAgent）
//     4. 强制禁止递归（task 工具本身不传入 sub-agent 的工具集）
//   这些操作都需要在 agent loop 的上下文中执行，auto-execute 无法访问这些状态。
import { tool } from 'ai'
import { z } from 'zod'

import type { SubAgentRegistry } from '../agent/sub-agents/types.js'

// ── createTaskTool ────────────────────────────────────────────────────────────

/**
 * 根据 Sub-Agent 注册表创建 task 工具定义。
 *
 * 工具 schema 中的 subagent 参数是动态生成的枚举类型，
 * 每个可选值来自注册表中的 sub-agent 名称，描述来自 SubAgentDef.description。
 *
 * @param registry Sub-Agent 注册表（内置 + 自定义）
 */
export function createTaskTool(registry: SubAgentRegistry) {
  const agents = registry.list()

  // 生成枚举类型：sub-agent 名称列表
  // 当没有任何 agent 时（极端情况），使用宽松的字符串类型
  const subagentSchema =
    agents.length > 0
      ? z.enum(agents.map((a) => a.name) as [string, ...string[]]).describe(
          'The sub-agent to delegate to:\n' +
            agents.map((a) => `  - "${a.name}": ${a.description}`).join('\n'),
        )
      : z.string().describe('The sub-agent name to delegate to.')

  return tool({
    description: `Delegate a subtask to a specialized sub-agent that runs in an isolated context.

Each sub-agent has its own message history and tool access, keeping complex subtasks separate from the main conversation.

Available sub-agents:
${agents.map((a) => `  - "${a.name}": ${a.description}`).join('\n')}

When to use task tool:
- The subtask is well-defined and can be completed independently
- You want to parallelize multiple independent subtasks
- The subtask requires a different specialization (e.g., code review, exploration)
- You want to isolate the context of a complex operation

Important: The task tool cannot call itself (no recursive sub-agents).`,
    inputSchema: z.object({
      subagent: subagentSchema,
      prompt: z
        .string()
        .describe(
          'The complete task description for the sub-agent. Be specific and include all necessary context, ' +
            'file paths, and expected output format. The sub-agent has no memory of the current conversation.',
        ),
    }),
    // 无 execute — 在 tool-execution.ts 的 BYPASS_LOOP_GUARD_HANDLERS 中处理
    // 原因同 shell/writeFile：需要访问 LoopState 和 callbacks
  })
}

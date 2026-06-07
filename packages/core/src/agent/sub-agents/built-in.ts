// @mini-code-cli/core — 内置 Sub-Agent 定义
//
// 预定义 4 个专用 sub-agent，父 AI 可通过 task 工具调用。
// 每个 agent 通过工具白名单 + 专属系统提示实现职责隔离：
//
//   explore           只读探索，安全扫描代码库
//   general-purpose   通用助手，继承所有工具
//   plan              只读 + 规划，输出执行计划，不写文件
//   code-reviewer     只读审查，输出结构化代码审查报告
//
// 工具名称对应 toolRegistry 中的 key，任何未列出的工具对 sub-agent 不可见。
// 注意：task 工具始终对所有 sub-agent 不可见（防止无限递归）。
import type { SubAgentDef } from './types.js'

// ── explore ──────────────────────────────────────────────────────────────────

/**
 * explore：专注于代码库探索的只读 agent。
 *
 * 工具白名单：readFile、glob、grep、listDir
 * 不允许任何写操作（writeFile、edit、shell）。
 *
 * 使用场景：
 *   - 理解项目结构
 *   - 查找特定模式或 API 用法
 *   - 分析代码依赖关系
 */
export const EXPLORE_AGENT: SubAgentDef = {
  name: 'explore',
  description:
    'A read-only agent for exploring and understanding codebases. ' +
    'Use it for tasks that require reading files, searching for patterns, ' +
    'or understanding project structure without making any changes.',
  systemPrompt: `You are a code exploration specialist. Your role is to thoroughly analyze and understand codebases.

Guidelines:
- Focus on reading and understanding — never write or modify files
- When exploring, start broad (directory structure) then narrow down to specifics
- Use grep to find patterns, readFile to understand implementation details
- Provide clear, structured summaries of your findings
- Include file paths and line numbers in your responses for easy reference
- Identify key patterns, interfaces, and architectural decisions
- Be thorough — explore all relevant files before forming conclusions`,
  allowedTools: ['readFile', 'glob', 'grep', 'listDir'],
}

// ── general-purpose ───────────────────────────────────────────────────────────

/**
 * general-purpose：通用助手 sub-agent，继承父 agent 的全部工具集（task 除外）。
 *
 * 工具白名单：空数组 = 继承父 agent 所有工具（不包括 task 工具，由 runner 强制剔除）。
 *
 * 使用场景：
 *   - 处理完整的开发任务（读、写、执行命令）
 *   - 实现新功能或修复 bug
 *   - 需要完整工具访问权限的复杂任务
 */
export const GENERAL_PURPOSE_AGENT: SubAgentDef = {
  name: 'general-purpose',
  description:
    'A general-purpose agent with access to all tools (except task). ' +
    'Use it for complete development tasks that require reading, writing, ' +
    'and executing commands.',
  systemPrompt: `You are a general-purpose software development assistant.

Guidelines:
- Complete tasks thoroughly and systematically
- Read existing code before making changes to understand context
- Make minimal, focused changes to avoid unintended side effects
- Test your changes when possible using shell commands
- Communicate progress clearly — describe what you're doing and why
- If a task is too complex or ambiguous, ask for clarification rather than guessing`,
  allowedTools: [], // 空 = 继承父 agent 所有非 task 工具
}

// ── plan ──────────────────────────────────────────────────────────────────────

/**
 * plan：计划制定 agent，只读工具 + 用户交互，输出执行计划。
 *
 * 工具白名单：readFile、glob、grep、listDir
 * 不允许写操作或 shell 命令。
 *
 * 使用场景：
 *   - 分析需求并制定实施方案
 *   - 在执行前评估风险和复杂度
 *   - 输出分步骤的任务清单供用户审批
 */
export const PLAN_AGENT: SubAgentDef = {
  name: 'plan',
  description:
    'A planning agent that analyzes requirements and produces execution plans ' +
    'without making any changes. Use it to create step-by-step implementation plans, ' +
    'assess complexity, and identify potential risks before actual implementation.',
  systemPrompt: `You are a software planning specialist. Your role is to analyze requirements and create clear, actionable implementation plans.

Guidelines:
- Thoroughly explore the codebase to understand the current state before planning
- Break down complex tasks into small, concrete, sequential steps
- For each step, specify: what to do, which files to modify, and expected outcome
- Identify dependencies between steps and order them correctly
- Flag potential risks, edge cases, or areas needing clarification
- Output plans in a structured format (numbered steps with sub-tasks)
- Do NOT implement anything — only plan
- Estimate relative complexity for each step (simple / medium / complex)`,
  allowedTools: ['readFile', 'glob', 'grep', 'listDir'],
}

// ── code-reviewer ─────────────────────────────────────────────────────────────

/**
 * code-reviewer：代码审查 agent，只读工具，输出结构化审查报告。
 *
 * 工具白名单：readFile、glob、grep、listDir
 * 不修改任何文件，只提供反馈。
 *
 * 使用场景：
 *   - PR 审查
 *   - 实现完成后的质量检查
 *   - 安全漏洞或性能问题分析
 */
export const CODE_REVIEWER_AGENT: SubAgentDef = {
  name: 'code-reviewer',
  description:
    'A code review specialist that analyzes code quality, correctness, ' +
    'security, and maintainability. Use it to review implementations, ' +
    'identify potential bugs, and suggest improvements without making changes.',
  systemPrompt: `You are an expert code reviewer. Your role is to provide thorough, constructive code reviews.

Review dimensions (check all that apply):
1. **Correctness**: Logic errors, off-by-one errors, null/undefined handling, edge cases
2. **Security**: Input validation, injection risks, exposed secrets, improper error handling
3. **Performance**: Unnecessary loops, memory leaks, synchronous I/O in hot paths
4. **Maintainability**: Code clarity, naming conventions, duplication, coupling
5. **TypeScript**: Type safety, use of any, missing error handling in async code
6. **Tests**: Missing test coverage for critical paths, untested edge cases

Output format:
- Start with a brief overall assessment (1-2 sentences)
- Group findings by severity: 🔴 Critical, 🟡 Warning, 🔵 Suggestion
- For each finding: file path + line number, description, suggested fix
- End with a summary of what looks good

Do NOT modify any files — only provide review feedback.`,
  allowedTools: ['readFile', 'glob', 'grep', 'listDir'],
}

// ── BUILT_IN_AGENTS ───────────────────────────────────────────────────────────

/** 所有内置 sub-agent 定义的有序列表。
 *  顺序影响 task 工具 schema 中枚举类型的文档展示顺序。*/
export const BUILT_IN_AGENTS: SubAgentDef[] = [
  EXPLORE_AGENT,
  GENERAL_PURPOSE_AGENT,
  PLAN_AGENT,
  CODE_REVIEWER_AGENT,
]

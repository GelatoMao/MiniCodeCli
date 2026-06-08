// @mini-code-cli/core — System Prompt 构建
//
// 需求 7.2：THE KnowledgeSystem SHALL 保证系统提示跨 turn 字节稳定
//           （不插入时间戳等动态内容）。
//
// buildSystemPrompt() 的职责：
//   1. 构建 BASE_SYSTEM_PROMPT（固定不变，跨 session 字节稳定）
//   2. 拼接 knowledgeContext（5 层 AGENTS.md 合并结果，session 内固定）
//   3. 拼接 PLAN_MODE_OVERLAY（plan 模式时追加额外指令）
//
// 字节稳定保证：
//   - BASE_SYSTEM_PROMPT 是硬编码常量
//   - knowledgeContext 在 session 首轮计算后存入 state.knowledgeContext 并复用
//   - PLAN_MODE_OVERLAY 在 permissionMode 变化时由 tool-execution.ts 触发重建
//     （将 state.systemPromptCache 置 null）
//   - 不使用 Date.now()、new Date()、process.pid 等动态值
//
// 与 LoopState 的关系：
//   - state.systemPromptCache：首次构建后缓存，后续 turn 直接复用
//   - state.knowledgeContext：由 agentLoop 在首轮前调用 buildKnowledgeContext() 填充
//   - state.permissionMode：变化时清除缓存，下轮重建

// ── Base System Prompt ────────────────────────────────────────────────────────

/** 基础系统提示（固定不变，不含任何动态内容）。
 *
 *  包含以下核心指令：
 *  - 角色定位：终端 AI 编程助手
 *  - 工具使用原则
 *  - 代码风格指导
 *  - 安全和权限约束*/
export const BASE_SYSTEM_PROMPT = `You are mini-code, a powerful AI coding assistant that runs in the terminal. You help developers write, read, debug, and refactor code.

## Core Principles

1. **Be concise**: Prefer short, direct responses. Skip unnecessary preamble.
2. **Use tools first**: When in doubt, read the file or run the command — don't guess.
3. **Preserve intent**: When editing files, change only what's necessary. Don't reformat or restructure unrelated code.
4. **Ask when blocked**: If you need clarification that would change your approach, ask once and wait.

## Tool Usage Guidelines

- **readFile**: Use for reading source files, configs, and documentation.
- **writeFile**: Use for creating new files. Never use for modifications (use edit instead).
- **edit**: Use for modifying existing files. Always use exact strings from the current file content.
- **glob**: Use to discover files matching a pattern before reading them.
- **grep**: Use to search for specific patterns across the codebase.
- **listDir**: Use to understand directory structure.
- **shell**: Use for build commands, tests, git operations. Prefer non-interactive flags.

## Code Quality

- Match the existing code style, naming conventions, and patterns in the project.
- Prefer TypeScript strict mode. Avoid \`any\` types unless necessary.
- Write idiomatic code for the language and framework in use.
- Add meaningful comments for non-obvious logic, not for obvious code.

## Safety

- Never delete files without explicit instruction.
- Confirm before making broad, destructive changes.
- When using shell, prefer dry-run flags when available (\`--dry-run\`, \`-n\`).`

// ── Plan Mode Overlay ─────────────────────────────────────────────────────────

/** Plan 模式附加指令（当 permissionMode === 'plan' 时追加到系统提示末尾）。
 *
 *  Plan 模式下 AI 只能读取文件和分析，不能执行写操作。
 *  需要告知模型当前约束，否则它可能尝试写文件并收到权限拒绝错误。*/
export const PLAN_MODE_OVERLAY = `
## Current Mode: PLAN

You are in PLAN mode. In this mode:
- You can read files, list directories, search code, and analyze the codebase.
- You CANNOT write files, edit files, or run shell commands that modify the system.
- Your goal is to create a detailed plan for the requested changes.
- Describe exactly what files you would modify and what changes you would make.
- When the user approves your plan, they will switch to normal mode to execute it.`

// ── buildSystemPrompt ─────────────────────────────────────────────────────────

/** 构建完整的系统提示字符串。
 *
 *  组合顺序（优先级从低到高）：
 *  1. BASE_SYSTEM_PROMPT（基础指令）
 *  2. knowledgeContext（5 层 AGENTS.md 合并，可为空）
 *  3. PLAN_MODE_OVERLAY（plan 模式时追加，否则省略）
 *
 *  字节稳定保证：相同参数输入 → 相同输出字节序列。
 *  不得在此函数内使用任何动态值（时间、随机数、进程 ID 等）。
 *
 *  @param knowledgeContext  buildKnowledgeContext() 的结果（空字符串表示无用户知识）
 *  @param isPlanMode        是否处于 plan 模式（追加 PLAN_MODE_OVERLAY）
 *  @returns                 完整系统提示字符串*/
export function buildSystemPrompt(knowledgeContext: string, isPlanMode: boolean): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT]

  if (knowledgeContext.trim().length > 0) {
    parts.push(
      `## Project Knowledge\n\n${knowledgeContext.trim()}`,
    )
  }

  if (isPlanMode) {
    parts.push(PLAN_MODE_OVERLAY)
  }

  return parts.join('\n\n')
}

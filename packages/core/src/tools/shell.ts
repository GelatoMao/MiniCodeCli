// @mini-code-cli/core — shell 工具（跨平台命令执行，无 execute — 需要权限检查）
//
// 故意不提供 execute 函数。
// 当 AI SDK 在 streamText 中遇到没有 execute 的工具时，
// 会产出 tool-call chunk，交给 agent loop 在 finishReason='tool-calls' 时手动处理。
//
// 手动处理的原因：
// 1. 执行前需要调用 checkPermission，可能需要弹出交互式确认对话框
// 2. 需要跨平台 shell 选择（bash/zsh/powershell）
// 3. 需要流式 stdout/stderr 实时推送给 UI（50ms 节流）
// 4. 需要用 AbortSignal 响应用户的 Ctrl+C 取消操作
import { tool } from 'ai'

import { z } from 'zod'

export const shell = tool({
  description: `Execute a shell command and return stdout/stderr. The working directory persists between commands.

IMPORTANT: Avoid using this tool to run grep, rg, cat, head, tail, sed, or awk commands. Instead, use the appropriate dedicated tool — they provide a better user experience:
- File search: Use glob (NOT find or ls)
- Content search: Use grep tool (NOT grep/rg command)
- Read files: Use readFile (NOT cat/head/tail)
- Edit files: Use edit (NOT sed/awk)
- Write files: Use writeFile (NOT echo >/cat <<EOF)

Instructions:
- If your command will create new directories or files, first run ls to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes.
- When issuing multiple commands: if they are independent, make multiple shell tool calls in a single message for parallelism. If they depend on each other, use '&&' to chain them. Use ';' only when you need sequential execution but don't care if earlier commands fail. Do NOT use newlines to separate commands.
- For git commands: prefer creating a new commit rather than amending. Never skip hooks (--no-verify) unless the user explicitly asks. Before running destructive operations (git reset --hard, git push --force), consider safer alternatives.
- Do not sleep between commands that can run immediately.`,
  inputSchema: z.object({
    command: z.string().describe('The command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
  }),
  // 无 execute — 在 agent loop 中手动处理权限检查 + 跨平台 shell + 流式输出
})

// @mini-code-cli/cli — 根 App 组件
//
// Task 9：接入 use-agent Hook，替换 Task 8 的临时模拟逻辑。
// Task 10：完善 spinnerLabel 状态切换逻辑，利用 activeToolName + activeToolInput
//          生成精确的工具运行提示（"Reading…" / "Writing…" / "Running…"）。
//
// 主要变化：
//   - 使用 useAgent() 管理 AgentState（messages、isLoading 等）
//   - submit() 启动 agentLoop，abort() 中断当前请求
//   - 流式文字通过 streamingText 字段实时追加到 scrollback
//   - 工具调用状态通过 activeToolCalls Map 追踪
//   - activeToolName / activeToolInput 驱动精确的 spinner 标签
//   - 权限请求通过 pendingPermission 触发 UI（Task 10+ 完善对话框）
import { useApp } from 'ink'
import React, { useCallback, useEffect, useMemo } from 'react'

import type { AgentOptions, LanguageModel } from '@mini-code-cli/core'
import { useAgent } from '../hooks/use-agent.js'
import { ChatInput } from './ChatInput.js'

export interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
}

// ── Spinner 标签生成 ───────────────────────────────────────────────────────────

/**
 * 根据工具名和输入参数生成人类可读的 spinner 标签。
 *
 * 设计原则：
 *   1. 优先显示操作动词（Reading/Writing/Running/Using）
 *   2. 附带操作目标的简短摘要（文件路径/命令前几个词）
 *   3. 过长时截断并加 "…"
 *
 * @example
 *   buildToolSpinnerLabel('readFile', { path: 'src/index.ts' }) → "Reading src/index.ts…"
 *   buildToolSpinnerLabel('shell', { command: 'npm install' }) → "Running npm install…"
 */
function buildToolSpinnerLabel(
  toolName: string,
  input: Record<string, unknown> | null,
): string {
  if (!input) return `Using ${toolName}…`

  switch (toolName) {
    case 'readFile':
    case 'read_file': {
      const path = input['path'] ?? input['file_path']
      if (path) {
        const p = String(path)
        // 只显示文件名（最后一个路径段），避免过长
        const basename = p.split('/').pop() ?? p
        return `Reading ${basename}…`
      }
      return 'Reading file…'
    }

    case 'writeFile':
    case 'write_file': {
      const path = input['path'] ?? input['file_path']
      if (path) {
        const basename = String(path).split('/').pop() ?? String(path)
        return `Writing ${basename}…`
      }
      return 'Writing file…'
    }

    case 'edit': {
      const path = input['path'] ?? input['file_path']
      if (path) {
        const basename = String(path).split('/').pop() ?? String(path)
        return `Editing ${basename}…`
      }
      return 'Editing file…'
    }

    case 'listDir':
    case 'list_dir': {
      const path = input['path'] ?? input['directory']
      if (path) {
        const p = String(path)
        const trimmed = p.length > 40 ? '…' + p.slice(-37) : p
        return `Listing ${trimmed}…`
      }
      return 'Listing directory…'
    }

    case 'glob': {
      const pattern = input['pattern']
      return pattern ? `Globbing ${String(pattern)}…` : 'Searching files…'
    }

    case 'grep': {
      const pattern = input['pattern']
      return pattern ? `Grepping ${String(pattern)}…` : 'Searching content…'
    }

    case 'shell': {
      const cmd = input['command']
      if (cmd) {
        // 只取命令的前两个词（去掉参数）
        const words = String(cmd).trim().split(/\s+/)
        const preview = words.slice(0, 2).join(' ')
        const suffix = preview.length < String(cmd).trim().length ? '…' : ''
        return `Running ${preview}${suffix}`
      }
      return 'Running command…'
    }

    default: {
      // 通用格式：首字母大写工具名
      const displayName = toolName
        .replace(/([A-Z])/g, ' $1')  // camelCase → words
        .replace(/^./, (c) => c.toUpperCase())
        .trim()
      return `Using ${displayName}…`
    }
  }
}

// ── App ──────────────────────────────────────────────────────────────────────

export function App({ model, options, initialPrompt }: AppProps): React.ReactElement {
  const { exit } = useApp()

  const { state, submit, abort, resolvePermission, resolveQuestion } = useAgent(model, options)

  // ── 初始 prompt 自动提交 ──────────────────────────────────────────────────────
  // 若启动时携带 initialPrompt（--print 模式或命令行直接传 prompt），
  // 等组件挂载后自动提交一次。
  const didSubmitInitialRef = React.useRef(false)
  useEffect(() => {
    if (initialPrompt && !didSubmitInitialRef.current) {
      didSubmitInitialRef.current = true
      submit(initialPrompt)
    }
  }, [initialPrompt, submit])

  // ── messages 展示列表 ─────────────────────────────────────────────────────────
  // 只传已最终提交的消息到 scrollback 路径。
  // 流式预览文字（streamingText）通过独立 prop 传给 ChatInput，
  // 在动态帧区域显示，不走 scrollback 写入路径。
  const displayMessages = state.messages

  // ── spinnerLabel：精确状态切换（Task 10 新增）────────────────────────────────
  //
  // 优先级从高到低：
  // 1. 等待权限确认 → "Allow <toolName>? (y/n)"（或 trustMode 时的执行提示）
  // 2. 等待用户回答问题 → "Waiting for input…"
  // 3. 工具正在运行 → buildToolSpinnerLabel(activeToolName, activeToolInput)
  // 4. AI 正在思考（agentLoop 运行中，无工具）→ "Thinking…"
  // 5. 不显示 spinner → null
  const spinnerLabel = useMemo(() => {
    if (state.pendingPermission) {
      const { toolName } = state.pendingPermission
      if (options.trustMode) {
        return buildToolSpinnerLabel(toolName, state.pendingPermission.input)
      }
      return `Allow ${toolName}? (y/n)`
    }
    if (state.pendingQuestion) {
      return 'Waiting for input…'
    }
    if (state.isLoading) {
      if (state.activeToolName) {
        // 工具正在运行：显示精确的工具操作标签
        return buildToolSpinnerLabel(state.activeToolName, state.activeToolInput)
      }
      // AI 正在思考（流式文字中）
      return 'Thinking…'
    }
    return null
  }, [
    state.pendingPermission,
    state.pendingQuestion,
    state.isLoading,
    state.activeToolName,
    state.activeToolInput,
    options.trustMode,
  ])

  // ── 自动处理权限（trustMode）────────────────────────────────────────────────────
  // trustMode 下自动 resolve 所有权限请求。
  // 非 trustMode 的完整交互式权限对话框在 Task 10+ 实现。
  useEffect(() => {
    if (state.pendingPermission && options.trustMode) {
      resolvePermission('yes')
    }
  }, [state.pendingPermission, options.trustMode, resolvePermission])

  // ── 键盘处理（权限 / 问题 pending 时的简化处理）──────────────────────────────
  // Task 10 对 pendingQuestion 自动选第一个选项。
  // 完整交互式对话框在后续任务中实现。
  useEffect(() => {
    if (state.pendingQuestion && state.pendingQuestion.options.length > 0) {
      const firstOption = state.pendingQuestion.options[0]
      if (firstOption) {
        resolveQuestion(firstOption.label)
      }
    }
  }, [state.pendingQuestion, resolveQuestion])

  // ── 权限确认键处理（y/n）────────────────────────────────────────────────────
  const handlePermissionKey = useCallback((key: 'y' | 'n') => {
    if (key === 'y') {
      resolvePermission('yes')
    } else {
      resolvePermission('no')
    }
  }, [resolvePermission])

  // ── 中断处理 ──────────────────────────────────────────────────────────────────
  const handleInterrupt = useCallback(() => {
    if (state.isLoading) {
      // 有正在运行的请求 → 中断
      abort()
    } else {
      // 没有运行中的请求 → 退出应用
      exit()
    }
  }, [state.isLoading, abort, exit])

  return (
    <>
      <ChatInput
        messages={displayMessages}
        onSubmit={submit}
        onInterrupt={handleInterrupt}
        onPermissionKey={handlePermissionKey}
        pendingPermission={state.pendingPermission != null}
        isLoading={state.isLoading}
        spinnerLabel={spinnerLabel}
        streamingText={state.streamingText || null}
        disabled={state.isLoading && options.printMode}
        tokenUsage={state.tokenUsage.totalTokens > 0 ? state.tokenUsage : null}
      />
    </>
  )
}

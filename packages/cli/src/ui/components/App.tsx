// @mini-code-cli/cli — 根 App 组件
//
// Task 9：接入 use-agent Hook，替换 Task 8 的临时模拟逻辑。
//
// 主要变化：
//   - 使用 useAgent() 管理 AgentState（messages、isLoading 等）
//   - submit() 启动 agentLoop，abort() 中断当前请求
//   - 流式文字通过 streamingText 字段实时追加到 scrollback
//   - 工具调用状态通过 activeToolCalls Map 追踪
//   - 权限请求通过 pendingPermission 触发 UI（Task 10+ 完善对话框）
import { useApp } from 'ink'
import React, { useCallback, useEffect, useMemo } from 'react'

import type { AgentOptions, LanguageModel } from '@mini-code-cli/core'
import type { DisplayMessage } from '../display-types.js'
import { useAgent } from '../hooks/use-agent.js'
import { ChatInput } from './ChatInput.js'

export interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
}

export function App({ model, options, initialPrompt }: AppProps): React.ReactElement {
  const { exit } = useApp()

  const { state, submit, abort, resolvePermission, resolveQuestion } = useAgent(model, options)

  // ── 初始 prompt 自动提交 ──────────────────────────────────────────────────
  // 若启动时携带 initialPrompt（--print 模式或命令行直接传 prompt），
  // 等组件挂载后自动提交一次。
  const didSubmitInitialRef = React.useRef(false)
  useEffect(() => {
    if (initialPrompt && !didSubmitInitialRef.current) {
      didSubmitInitialRef.current = true
      submit(initialPrompt)
    }
  }, [initialPrompt, submit])

  // ── messages 展示列表合并 ─────────────────────────────────────────────────
  // 将已提交的历史消息 + 当前流式文字片段合并为 ChatInput 所需的 messages 列表。
  // streamingText 作为最后一条 assistant 消息的流式片段展示（streamingChunk = true）。
  const displayMessages: readonly DisplayMessage[] = useMemo(() => {
    if (!state.streamingText) return state.messages
    const streamingMsg: DisplayMessage = {
      role: 'assistant',
      content: state.streamingText,
      streamingChunk: true,
    }
    return [...state.messages, streamingMsg]
  }, [state.messages, state.streamingText])

  // ── 权限对话框 spinner 标签 ────────────────────────────────────────────────
  // Task 10+ 会在这里渲染完整的权限确认 UI。
  // Task 9 简化：权限请求时自动同意（需 trustMode）或在 spinner 中提示。
  const spinnerLabel = useMemo(() => {
    if (state.pendingPermission) {
      const { toolName } = state.pendingPermission
      // trustMode 时自动同意所有权限请求
      if (options.trustMode) {
        return `Executing ${toolName}…`
      }
      return `Allow ${toolName}? (y/n)`
    }
    if (state.pendingQuestion) {
      return 'Waiting for input…'
    }
    if (state.isLoading) return 'Thinking…'
    return null
  }, [state.pendingPermission, state.pendingQuestion, state.isLoading, options.trustMode])

  // ── 自动处理权限（trustMode）────────────────────────────────────────────────
  // trustMode 下自动 resolve 所有权限请求。
  // 非 trustMode 的完整交互式权限对话框在 Task 10+ 实现。
  useEffect(() => {
    if (state.pendingPermission && options.trustMode) {
      resolvePermission('yes')
    }
  }, [state.pendingPermission, options.trustMode, resolvePermission])

  // ── 键盘处理（权限 / 问题 pending 时的简化处理）──────────────────────────
  // Task 10 会在这里替换为完整的对话框 UI。
  // 目前对 pendingQuestion 自动选第一个选项。
  useEffect(() => {
    if (state.pendingQuestion && state.pendingQuestion.options.length > 0) {
      const firstOption = state.pendingQuestion.options[0]
      if (firstOption) {
        resolveQuestion(firstOption.label)
      }
    }
  }, [state.pendingQuestion, resolveQuestion])

  // ── 中断处理 ──────────────────────────────────────────────────────────────
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
        isLoading={state.isLoading}
        spinnerLabel={spinnerLabel}
        disabled={state.isLoading && options.printMode}
      />
    </>
  )
}

// @mini-code-cli/cli — 根 App 组件
//
// Task 8：接入 ChatInput，实现 cell-buffer 渲染的输入框骨架。
// 消息历史暂用本地 state 模拟（Task 9 接入 use-agent 后替换）。
import { useApp } from 'ink'
import React, { useCallback, useState } from 'react'

import type { AgentOptions, LanguageModel } from '@mini-code-cli/core'
import type { DisplayMessage } from '../display-types.js'
import { ChatInput } from './ChatInput.js'

export interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
}

export function App({ options }: AppProps): React.ReactElement {
  const { exit } = useApp()

  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // 处理用户提交：将消息加入历史，模拟 AI 回复（Task 9 替换为 agentLoop）
  const handleSubmit = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
    ])
    setIsLoading(true)

    // 临时模拟：500ms 后添加 AI 回复
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `[Task 9 起接入 agentLoop]\n收到：${text}`,
        },
      ])
      setIsLoading(false)
    }, 500)
  }, [])

  // Ctrl+C 双击退出逻辑（简化版：直接退出）
  const handleInterrupt = useCallback(() => {
    exit()
  }, [exit])

  return (
    <>
      <ChatInput
        messages={messages}
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        isLoading={isLoading}
        spinnerLabel={isLoading ? 'Thinking…' : null}
        disabled={isLoading && options.printMode}
      />
    </>
  )
}

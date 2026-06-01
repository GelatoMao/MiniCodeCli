// @mini-code-cli/cli — 根 App 组件（最简版本，Task 7）
// 任务 7 阶段：仅挂载，不渲染可见内容。
// 后续 Task 8-11 逐步补全 ChatInput、流式渲染、Markdown 等。
import { Box } from 'ink'
import React from 'react'

import type { AgentOptions, LanguageModel } from '@mini-code-cli/core'

export interface AppProps {
  model: LanguageModel
  options: AgentOptions
  initialPrompt?: string
}

export function App(_props: AppProps): React.ReactElement {
  // Task 7：最简骨架，仅返回空 Box
  // Task 8 起逐步添加 ChatInput 和 use-agent Hook
  return <Box />
}

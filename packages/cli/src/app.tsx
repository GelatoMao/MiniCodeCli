// @mini-code-cli/cli — Ink render 入口（Task 7）
import { render } from 'ink'
import React from 'react'

import type { AgentOptions, LanguageModel } from '@mini-code-cli/core'

import { App } from './ui/components/App.js'

export function startApp(
  model: LanguageModel,
  options: AgentOptions,
  initialPrompt?: string,
): () => Promise<void> {
  const { waitUntilExit } = render(
    <App model={model} options={options} initialPrompt={initialPrompt} />,
    { exitOnCtrlC: false },
  )
  return waitUntilExit
}

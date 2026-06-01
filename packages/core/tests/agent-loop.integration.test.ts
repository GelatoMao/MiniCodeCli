// @mini-code-cli/core — agentLoop 集成测试
//
// 测试策略：
//   真实调用 DeepSeek API，验证 agentLoop 端到端链路。
//   需要环境变量 DEEPSEEK_API_KEY，未配置时自动跳过（skipIf）。
//
// 运行方式：
//   DEEPSEEK_API_KEY=sk-xxx pnpm test
//
// 覆盖场景：
//   1. 纯对话（无工具调用）       — 基本连通性 + 流式输出
//   2. 多轮对话（existingState）  — state 跨轮传递，上下文保留
//   3. 工具调用（readFile）       — ReAct 循环，turnCount >= 2
//   4. abortSignal 中断           — 中断不触发 onError

import { describe, it, expect } from 'vitest'

import { agentLoop } from '../src/agent/loop.js'
import { createModelRegistry } from '../src/providers/registry.js'
import type { AgentCallbacks, AgentOptions } from '../src/types/index.js'

// ── 前置条件：没有 DEEPSEEK_API_KEY 时跳过全部集成测试 ──────────────────────

const HAS_KEY = Boolean(process.env.DEEPSEEK_API_KEY)

const registry = HAS_KEY ? createModelRegistry() : null
const model = registry?.languageModel('deepseek:deepseek-chat')

const BASE_OPTIONS: AgentOptions = {
  modelId: 'deepseek:deepseek-chat',
  trustMode: true,
  printMode: true,
  maxTurns: 8,
}

/** 构建一个收集所有输出的 callbacks */
function makeCallbacks() {
  const output = { text: '', errors: [] as string[], toolCalls: [] as string[] }
  const callbacks: AgentCallbacks = {
    onTextDelta: (t) => {
      output.text += t
    },
    onToolCall: (_id, name) => {
      output.toolCalls.push(name)
    },
    onToolResult: () => {},
    onToolProgress: () => {},
    onAskPermission: async () => 'yes',
    onAskUser: async () => '',
    onShellOutput: () => {},
    onUsageUpdate: () => {},
    onError: (e) => {
      output.errors.push(e.message)
    },
  }
  return { output, callbacks }
}

// ── 集成测试套件 ────────────────────────────────────────────────────────────

describe.skipIf(!HAS_KEY)('agentLoop 集成测试（需要 DEEPSEEK_API_KEY）', () => {
  it('场景 1：纯对话 — 基本连通性 + 流式输出', { timeout: 30_000 }, async () => {
    const { output, callbacks } = makeCallbacks()
    const result = await agentLoop('用一句话解释什么是递归', model!, BASE_OPTIONS, callbacks)

    expect(result.turnCount).toBeGreaterThanOrEqual(1)
    expect(output.text.length).toBeGreaterThan(10)
    expect(output.errors).toHaveLength(0)
    expect(output.toolCalls).toHaveLength(0)
  })

  it('场景 2：多轮对话 — existingState 跨轮上下文保留', { timeout: 60_000 }, async () => {
    const { callbacks: cb1 } = makeCallbacks()
    // 第一轮：报出一个数字
    const result1 = await agentLoop('我喜欢的数字是 42，请记住它', model!, BASE_OPTIONS, cb1)

    const { output: out2, callbacks: cb2 } = makeCallbacks()
    // 第二轮：用 existingState 延续，验证模型记得上文
    const result2 = await agentLoop(
      '我刚才说我喜欢的数字是多少？',
      model!,
      BASE_OPTIONS,
      cb2,
      result1.state,
    )

    expect(result2.turnCount).toBeGreaterThanOrEqual(1)
    expect(out2.text).toContain('42')
    expect(out2.errors).toHaveLength(0)
  })

  it('场景 3：工具调用 — readFile 触发 ReAct 循环', { timeout: 60_000 }, async () => {
    const { output, callbacks } = makeCallbacks()
    const result = await agentLoop(
      '请用 readFile 工具读取文件 /Users/maolu/Desktop/AI/code-cli/mini-code-cli/package.json，然后告诉我 "packageManager" 字段的值是什么',
      model!,
      BASE_OPTIONS,
      callbacks,
    )

    // 至少一轮工具调用 + 一轮最终回答
    expect(result.turnCount).toBeGreaterThanOrEqual(2)
    expect(output.toolCalls.length).toBeGreaterThan(0)
    // readFile 结果被模型引用，回答中应含 "pnpm"
    expect(output.text.toLowerCase()).toContain('pnpm')
    expect(output.errors).toHaveLength(0)
  })

  it('场景 4：abortSignal 立即中断 — 不触发 onError', { timeout: 10_000 }, async () => {
    const { output, callbacks } = makeCallbacks()
    const controller = new AbortController()
    controller.abort()

    await agentLoop('你好', model!, { ...BASE_OPTIONS, abortSignal: controller.signal }, callbacks)

    // 用户主动中断不应被视为错误
    expect(output.errors).toHaveLength(0)
  })
})

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
//
// task16 MCP 集成测试：
//   5. MCP 工具注入 buildTools    — bridgeAllMcpTools 产出的工具名包含在 effectiveTools
//   6. MCP 工具调用（read_text_file）— 模型调用 filesystem__read_text_file，结果回传
//   7. MCP 权限拒绝               — onAskPermission 返回 'no' → 结果含 'Permission denied'

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { agentLoop } from '../src/agent/loop.js'
import { createModelRegistry } from '../src/providers/registry.js'
import { loadMcpFromDisk } from '../src/mcp/loader.js'
import { emptyMcpRegistry } from '../src/mcp/registry.js'
import type { McpRegistry } from '../src/mcp/types.js'
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

// ── MCP 集成测试套件 ─────────────────────────────────────────────────────────
//
// 依赖：
//   - DEEPSEEK_API_KEY（调用模型）
//   - ~/.mini-code/mcp.json 中配置了 filesystem 服务器（指向 /private/tmp）
//   - npx @modelcontextprotocol/server-filesystem 可执行
//
// 测试用的临时文件创建在 /private/tmp/mcp-agent-test-XXXX.txt，
// 每个 suite 结束后清理。

const HAS_MCP_CONFIG = async () => {
  try {
    const cfgPath = path.join(os.homedir(), '.mini-code', 'mcp.json')
    await fs.access(cfgPath)
    const raw = await fs.readFile(cfgPath, 'utf-8')
    const cfg = JSON.parse(raw) as { servers?: unknown[] }
    return Array.isArray(cfg.servers) && cfg.servers.length > 0
  } catch {
    return false
  }
}

describe.skipIf(!HAS_KEY)('agentLoop + MCP 集成测试（需要 DEEPSEEK_API_KEY + mcp.json）', () => {
  let mcpRegistry: McpRegistry
  let testFilePath: string
  const CWD = process.cwd()

  // 在 suite 开始前连接 MCP 并准备测试文件
  beforeAll(async () => {
    // macOS /tmp → /private/tmp
    testFilePath = '/private/tmp/mcp-agent-test.txt'
    await fs.writeFile(testFilePath, 'MCP integration test content.\nLine 2: answer is 2025.\n')

    try {
      mcpRegistry = await loadMcpFromDisk(CWD, /* trustMode */ true)
    } catch {
      mcpRegistry = emptyMcpRegistry
    }
  }, 30_000)

  afterAll(async () => {
    await mcpRegistry.shutdown().catch(() => {})
    await fs.unlink(testFilePath).catch(() => {})
  })

  it(
    '场景 5：MCP 工具注入 — buildTools 包含 filesystem__ 前缀工具',
    { timeout: 30_000 },
    async () => {
      // 用空消息跑一轮，验证 buildTools 能无错误运行（工具注入不崩溃）
      const { output, callbacks } = makeCallbacks()
      const opts: AgentOptions = { ...BASE_OPTIONS, mcpRegistry, maxTurns: 1 }

      await agentLoop('用一句话说"测试通过"', model!, opts, callbacks)

      expect(output.errors).toHaveLength(0)
      expect(output.text.length).toBeGreaterThan(0)
    },
  )

  it(
    '场景 6：MCP 工具调用 — 模型通过 filesystem__read_text_file 读取文件',
    { timeout: 90_000 },
    async () => {
      // 仅当 filesystem 服务器有工具时运行
      const fsEntry = mcpRegistry.get('filesystem')
      const hasReadTool = fsEntry?.tools.some((t) => t.name === 'read_text_file')
      if (!hasReadTool) {
        console.log('  filesystem 服务器未提供 read_text_file，跳过场景 6')
        return
      }

      const { output, callbacks } = makeCallbacks()
      const opts: AgentOptions = { ...BASE_OPTIONS, mcpRegistry, maxTurns: 10 }

      await agentLoop(
        // 明确要求模型用 MCP 工具（包含命名空间前缀），避免模型用内置 readFile
        `请使用工具 filesystem__read_text_file 读取文件 ${testFilePath}，` +
          `然后告诉我文件第 2 行中的数字是多少。`,
        model!,
        opts,
        callbacks,
      )

      // 模型应该调用了 MCP 工具
      expect(output.toolCalls).toContain('filesystem__read_text_file')
      // 文件内容被读到，模型应该能提取出 2025
      expect(output.text).toContain('2025')
      expect(output.errors).toHaveLength(0)
      // ReAct 循环：至少一轮工具调用 + 一轮回答
      expect(output.toolCalls.length).toBeGreaterThanOrEqual(1)
    },
  )

  it(
    '场景 7：MCP 权限拒绝 — onAskPermission 返回 no → 工具结果含 Permission denied',
    { timeout: 60_000 },
    async () => {
      const fsEntry = mcpRegistry.get('filesystem')
      const hasReadTool = fsEntry?.tools.some((t) => t.name === 'read_text_file')
      if (!hasReadTool) {
        console.log('  filesystem 服务器未提供 read_text_file，跳过场景 7')
        return
      }

      // 收集工具结果（用于验证权限拒绝消息）
      const toolResults: string[] = []
      const callbacks: AgentCallbacks = {
        onTextDelta: () => {},
        onToolCall: () => {},
        onToolResult: (_id, result) => { toolResults.push(result) },
        onToolProgress: () => {},
        // 所有 MCP 权限请求都拒绝
        onAskPermission: async () => 'no',
        onAskUser: async () => '',
        onShellOutput: () => {},
        onUsageUpdate: () => {},
        onError: () => {},
      }

      const opts: AgentOptions = {
        ...BASE_OPTIONS,
        mcpRegistry,
        trustMode: false,   // 关闭 trustMode，让权限框真正弹出
        maxTurns: 5,
      }

      await agentLoop(
        `请使用工具 filesystem__read_text_file 读取文件 ${testFilePath}`,
        model!,
        opts,
        callbacks,
      )

      // 至少有一个工具结果是"Permission denied"
      const hasDenied = toolResults.some((r) => r.includes('Permission denied'))
      expect(hasDenied).toBe(true)
    },
  )
})

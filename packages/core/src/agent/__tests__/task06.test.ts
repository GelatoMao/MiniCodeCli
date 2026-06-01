// @mini-code-cli/core — Task-06 本地验证测试
//
// 覆盖 task6 新增的三个核心模块：
//   1. messages.ts        — 消息构造 + 错误字符串约定
//   2. loop-guard.ts      — 死循环检测（hashToolCall / checkForLoop / recordToolCall）
//   3. tool-result-sanitize.ts — repairOrphanToolCalls / truncateToolResultsInMessages
//
// 特点：零 API Key 依赖，纯逻辑单元测试，毫秒级运行。
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  HARD_LOOP_THRESHOLD,
  LOOP_WINDOW_SIZE,
  SOFT_LOOP_THRESHOLD,
  checkForLoop,
  hashToolCall,
  recordToolCall,
} from '../loop-guard.js'
import { createLoopState } from '../loop-state.js'
import { isToolErrorString, toolErrorFromUnknown, toolErrorString, toolResultMessage } from '../messages.js'
import { repairOrphanToolCalls, truncateToolResultsInMessages } from '../tool-result-sanitize.js'

// ─────────────────────────────────────────────────────────────────────────────
// messages.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('messages — toolResultMessage', () => {
  it('构建符合 AI SDK 格式的 tool 消息', () => {
    const msg = toolResultMessage('call-1', 'readFile', '文件内容')
    expect(msg.role).toBe('tool')
    expect(Array.isArray(msg.content)).toBe(true)
    const part = (msg.content as Array<Record<string, unknown>>)[0]
    expect(part?.type).toBe('tool-result')
    expect(part?.toolCallId).toBe('call-1')
    expect(part?.toolName).toBe('readFile')
    expect((part?.output as Record<string, unknown>)?.type).toBe('text')
    expect((part?.output as Record<string, unknown>)?.value).toBe('文件内容')
  })
})

describe('messages — toolErrorString / isToolErrorString', () => {
  it('toolErrorString 添加 "Error: " 前缀', () => {
    expect(toolErrorString('file not found')).toBe('Error: file not found')
  })

  it('isToolErrorString 识别 "Error: " 前缀', () => {
    expect(isToolErrorString('Error: something')).toBe(true)
    expect(isToolErrorString('success')).toBe(false)
    expect(isToolErrorString('')).toBe(false)
  })

  it('toolErrorFromUnknown 处理 Error 对象', () => {
    const result = toolErrorFromUnknown(new Error('boom'))
    expect(result).toBe('Error: boom')
  })

  it('toolErrorFromUnknown 处理字符串', () => {
    const result = toolErrorFromUnknown('raw string')
    expect(result).toBe('Error: raw string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// loop-guard.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('hashToolCall', () => {
  it('相同工具名 + 相同输入 → 相同哈希', () => {
    const h1 = hashToolCall('shell', { command: 'ls -la' })
    const h2 = hashToolCall('shell', { command: 'ls -la' })
    expect(h1).toBe(h2)
  })

  it('不同输入 → 不同哈希', () => {
    const h1 = hashToolCall('shell', { command: 'ls' })
    const h2 = hashToolCall('shell', { command: 'pwd' })
    expect(h1).not.toBe(h2)
  })

  it('stable stringify：键序不同 → 相同哈希', () => {
    const h1 = hashToolCall('readFile', { filePath: '/a', offset: 0 })
    const h2 = hashToolCall('readFile', { offset: 0, filePath: '/a' })
    expect(h1).toBe(h2)
  })

  it('不同工具名（相同输入）→ 不同哈希', () => {
    const h1 = hashToolCall('writeFile', { filePath: '/a' })
    const h2 = hashToolCall('readFile', { filePath: '/a' })
    expect(h1).not.toBe(h2)
  })

  it('哈希长度为 16 个十六进制字符', () => {
    const h = hashToolCall('glob', { pattern: '**/*.ts' })
    expect(h).toHaveLength(16)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })
})

describe('checkForLoop + recordToolCall', () => {
  it('首次调用 → ok', () => {
    const state = createLoopState()
    const result = checkForLoop(state, 'shell', { command: 'ls' }, 'id-1')
    expect(result.kind).toBe('ok')
  })

  it(`重复 ${SOFT_LOOP_THRESHOLD} 次 → soft-block`, () => {
    const state = createLoopState()
    const input = { command: 'failing-cmd' }

    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      const check = checkForLoop(state, 'shell', input, `id-${i}`)
      expect(check.kind).toBe('ok')
      recordToolCall(state, 'shell', input, check.hash)
    }

    const final = checkForLoop(state, 'shell', input, `id-${SOFT_LOOP_THRESHOLD}`)
    expect(final.kind).toBe('soft-block')
  })

  it(`重复 ${HARD_LOOP_THRESHOLD} 次 → hard-block`, () => {
    const state = createLoopState()
    const input = { command: 'bad-cmd' }

    for (let i = 0; i < HARD_LOOP_THRESHOLD - 1; i++) {
      const check = checkForLoop(state, 'shell', input, `id-${i}`)
      recordToolCall(state, 'shell', input, check.hash)
    }

    const final = checkForLoop(state, 'shell', input, `id-${HARD_LOOP_THRESHOLD}`)
    expect(final.kind).toBe('hard-block')
  })

  it('不同工具名（相同输入）不互相干扰', () => {
    const state = createLoopState()
    const input = { filePath: '/same/path' }

    // writeFile 调用 SOFT 次
    for (let i = 0; i < SOFT_LOOP_THRESHOLD - 1; i++) {
      const check = checkForLoop(state, 'writeFile', input, `wf-${i}`)
      recordToolCall(state, 'writeFile', input, check.hash)
    }

    // readFile 用相同输入——不应触发 writeFile 的计数
    const readCheck = checkForLoop(state, 'readFile', input, 'rf-1')
    expect(readCheck.kind).toBe('ok')
  })

  it('滑动窗口：旧记录超出 LOOP_WINDOW_SIZE*2 后被淘汰', () => {
    const state = createLoopState()
    const staleInput = { command: 'stale' }
    const freshInput = { command: 'fresh' }

    // 先记录 stale 调用使其超出窗口
    for (let i = 0; i < LOOP_WINDOW_SIZE * 2 + 2; i++) {
      recordToolCall(state, 'shell', staleInput)
    }
    // 再用新输入填满窗口
    for (let i = 0; i < LOOP_WINDOW_SIZE; i++) {
      recordToolCall(state, 'shell', freshInput)
    }

    // stale 应该已被淘汰，重新调用不触发循环守卫
    const result = checkForLoop(state, 'shell', staleInput, 'new-stale-id')
    expect(result.kind).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tool-result-sanitize.ts — repairOrphanToolCalls
// ─────────────────────────────────────────────────────────────────────────────

function makeAssistantWithToolCall(toolCallId: string, toolName = 'shell'): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
  } as ModelMessage
}

function makeToolResult(toolCallId: string, toolName = 'shell', value = 'ok'): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } }],
  } as ModelMessage
}

describe('repairOrphanToolCalls — 正向孤立（tool_call 无 result）', () => {
  it('为孤立 tool_call 合成错误 result', () => {
    const messages: ModelMessage[] = [makeAssistantWithToolCall('id-1')]
    repairOrphanToolCalls(messages)

    // 应该出现一条 tool 消息
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBeGreaterThan(0)

    // 找到 id-1 的 result
    const found = toolMsgs.some((m) =>
      (m.content as Array<Record<string, unknown>>).some(
        (p) => p.type === 'tool-result' && p.toolCallId === 'id-1',
      ),
    )
    expect(found).toBe(true)
  })

  it('多个孤立 tool_call 合并进同一条 tool 消息', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'id-1', toolName: 'readFile', input: {} },
          { type: 'tool-call', toolCallId: 'id-2', toolName: 'glob', input: {} },
        ],
      } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(1) // 合并进一条
    expect((toolMsgs[0]!.content as unknown[]).length).toBe(2)
  })
})

describe('repairOrphanToolCalls — 反向孤立（tool_result 无对应 tool_call）', () => {
  it('删除孤立 tool_result 消息', () => {
    const messages: ModelMessage[] = [
      // 只有 result，没有对应的 assistant tool_call
      makeToolResult('ghost-id'),
    ]
    repairOrphanToolCalls(messages)
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(0)
  })

  it('前后都是 assistant 时用 user 占位替代删除', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: 'first' } as ModelMessage,
      makeToolResult('ghost-id'), // 孤立，应被替换为 user 占位
      { role: 'assistant', content: 'second' } as ModelMessage,
    ]
    repairOrphanToolCalls(messages)
    expect(messages[1]?.role).toBe('user') // 替换为 user 占位
  })
})

describe('repairOrphanToolCalls — 正常配对（不应修改）', () => {
  it('配对完整时不修改消息', () => {
    const messages: ModelMessage[] = [
      makeAssistantWithToolCall('id-1'),
      makeToolResult('id-1'),
    ]
    const originalLength = messages.length
    repairOrphanToolCalls(messages)
    expect(messages.length).toBe(originalLength)
    // result 仍在
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(1)
  })

  it('幂等性：调用两次结果相同', () => {
    const messages: ModelMessage[] = [makeAssistantWithToolCall('id-1')]
    repairOrphanToolCalls(messages)
    const after1 = JSON.stringify(messages)
    repairOrphanToolCalls(messages)
    const after2 = JSON.stringify(messages)
    expect(after1).toBe(after2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tool-result-sanitize.ts — truncateToolResultsInMessages
// ─────────────────────────────────────────────────────────────────────────────

describe('truncateToolResultsInMessages', () => {
  it('不超长时不修改内容', () => {
    const value = 'short result'
    const messages: ModelMessage[] = [makeToolResult('id-1', 'readFile', value)]
    truncateToolResultsInMessages(messages)
    const part = (messages[0]!.content as Array<Record<string, unknown>>)[0]
    expect((part?.output as Record<string, unknown>)?.value).toBe(value)
  })

  it('超长内容被截断（readFile head-tail 策略）', () => {
    // 生成远超 MAX_TOOL_RESULT_LINES（2000）行的内容
    // 用 5000 行确保截断后的字符数明显少于原始内容（头尾各取少量，中间丢弃）
    const longValue = Array.from({ length: 5000 }, (_, i) => `line content here ${i}`).join('\n')
    const messages: ModelMessage[] = [makeToolResult('id-1', 'readFile', longValue)]
    truncateToolResultsInMessages(messages)
    const part = (messages[0]!.content as Array<Record<string, unknown>>)[0]
    const truncated = (part?.output as Record<string, unknown>)?.value as string
    // 截断后比原来短（5000 行被截为 2000 行，净减约 60%）
    expect(truncated.length).toBeLessThan(longValue.length)
    // 包含截断提示
    expect(truncated).toContain('truncated')
  })

  it('glob 使用 head 策略，超长时截断', () => {
    const longValue = Array.from({ length: 2000 }, (_, i) => `/path/to/file-${i}.ts`).join('\n')
    const messages: ModelMessage[] = [makeToolResult('id-1', 'glob', longValue)]
    truncateToolResultsInMessages(messages)
    const part = (messages[0]!.content as Array<Record<string, unknown>>)[0]
    const truncated = (part?.output as Record<string, unknown>)?.value as string
    expect(truncated.length).toBeLessThan(longValue.length)
  })

  it('非 tool 消息不受影响', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' } as ModelMessage,
      { role: 'assistant', content: 'world' } as ModelMessage,
    ]
    truncateToolResultsInMessages(messages)
    expect((messages[0] as { content: string }).content).toBe('hello')
    expect((messages[1] as { content: string }).content).toBe('world')
  })
})

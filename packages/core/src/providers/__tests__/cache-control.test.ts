// @mini-code-cli/core — cache-control 属性测试 + 单元测试
//
// 覆盖 task 13.1 要求的 Property 2：
//   "对任意相同参数，applyCacheControl 注入的 Anthropic cache_control
//    断点总数不超过 4 个（MAX_ANTHROPIC_CACHE_BREAKPOINTS）。"
//
// Feature: x-code-cli, Property 2: Anthropic 断点数 ≤ 4 不变量
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { applyCacheControl } from '../cache-control.js'

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 统计一次 applyCacheControl 结果中注入的总 cache_control 断点数。
 *  包含系统消息 + 所有普通消息上的断点。*/
function countBreakpoints(
  systemMessage: ReturnType<typeof applyCacheControl>['systemMessage'],
  messages: ModelMessage[],
): number {
  let count = 0

  // 系统消息断点
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((systemMessage.providerOptions?.anthropic as any)?.cacheControl) {
    count++
  }

  // 普通消息断点
  for (const msg of messages) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((msg.providerOptions?.anthropic as any)?.cacheControl) {
      count++
    }
  }

  return count
}

/** 构造 N 条简单 user 消息 */
function makeMessages(n: number): ModelMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: 'user' as const,
    content: `message ${i}`,
  }))
}

// ── Property 2：Anthropic 断点数 ≤ 4 ─────────────────────────────────────────

describe('Property 2 — Anthropic cache_control 断点数不超过 4', () => {
  // 边界：0 条消息
  it('0 条消息时只有系统消息断点（总数 = 1）', () => {
    const { systemMessage, messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system prompt',
      [],
      'session-1',
    )
    const total = countBreakpoints(systemMessage, messages)
    expect(total).toBe(1)
    expect(total).toBeLessThanOrEqual(4)
  })

  it('1 条消息：系统 + 1 条消息 = 2 个断点', () => {
    const { systemMessage, messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system prompt',
      makeMessages(1),
      'session-1',
    )
    const total = countBreakpoints(systemMessage, messages)
    expect(total).toBe(2)
    expect(total).toBeLessThanOrEqual(4)
  })

  it('3 条消息：系统 + 3 条 = 4 个断点（恰好达到上限）', () => {
    const { systemMessage, messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system prompt',
      makeMessages(3),
      'session-1',
    )
    const total = countBreakpoints(systemMessage, messages)
    expect(total).toBe(4)
    expect(total).toBeLessThanOrEqual(4)
  })

  it('5 条消息：断点总数仍 ≤ 4', () => {
    const { systemMessage, messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system prompt',
      makeMessages(5),
      'session-1',
    )
    const total = countBreakpoints(systemMessage, messages)
    expect(total).toBeLessThanOrEqual(4)
  })

  it('10 条消息：断点总数 ≤ 4', () => {
    const { systemMessage, messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system prompt',
      makeMessages(10),
      'session-1',
    )
    const total = countBreakpoints(systemMessage, messages)
    expect(total).toBeLessThanOrEqual(4)
  })

  it('100 条消息：断点总数 ≤ 4', () => {
    const { systemMessage, messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system prompt',
      makeMessages(100),
      'session-1',
    )
    const total = countBreakpoints(systemMessage, messages)
    expect(total).toBeLessThanOrEqual(4)
  })

  // 穷举 1-20 条消息，确保任意长度都 ≤ 4
  for (let n = 1; n <= 20; n++) {
    it(`${n} 条消息：断点总数 ≤ 4`, () => {
      const { systemMessage, messages } = applyCacheControl(
        'anthropic:claude-sonnet-4-5',
        'system prompt',
        makeMessages(n),
        'session-1',
      )
      expect(countBreakpoints(systemMessage, messages)).toBeLessThanOrEqual(4)
    })
  }
})

// ── Property 2b：已有断点的消息不重复注入 ────────────────────────────────────
//
// 设计约定：applyCacheControl 接收的是 state.messages（原始未注入版本）。
// loop.ts 中 cachedMessages 只传给 streamText，不存回 state，
// 所以正常使用路径不会出现"对已注入消息再次注入"的情况。
// 这里测试的是：即使消息已有断点，函数也不会在同一条消息上重复添加。

describe('Property 2b — 已有断点的消息不重复注入（单条消息级别幂等）', () => {
  it('已有 cacheControl 的消息不会被重复注入', () => {
    // 手动预置一条已有断点的消息
    const preAnnotated: ModelMessage[] = [
      {
        role: 'user' as const,
        content: 'msg with existing breakpoint',
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      },
      { role: 'user' as const, content: 'msg without breakpoint' },
    ]

    const { messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system',
      preAnnotated,
      'sess',
    )

    // 第一条消息已有断点，不应被再次注入（跳过）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg0Breakpoints = (messages[0]?.providerOptions?.anthropic as any)?.cacheControl
    expect(msg0Breakpoints).toEqual({ type: 'ephemeral' })  // 保持原有，不是第二个

    // 统计该消息上 anthropic 对象的 key 数量，确保没有多余字段
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anthropicOpts = messages[0]?.providerOptions?.anthropic as any
    expect(Object.keys(anthropicOpts ?? {}).length).toBe(1)  // 只有 cacheControl
  })
})

// ── OpenAI：注入 promptCacheKey ───────────────────────────────────────────────

describe('OpenAI — promptCacheKey 注入', () => {
  it('系统消息携带 promptCacheKey = sessionId', () => {
    const sessionId = '20260608-120000-001'
    const { systemMessage, messages } = applyCacheControl(
      'openai:gpt-4o',
      'system prompt',
      makeMessages(3),
      sessionId,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((systemMessage.providerOptions?.openai as any)?.promptCacheKey).toBe(sessionId)
    // OpenAI 模式不注入 anthropic cache_control
    expect(countBreakpoints(systemMessage, messages)).toBe(0)
  })

  it('messages 内容不被修改（OpenAI 只改系统消息）', () => {
    const original = makeMessages(3)
    const { messages } = applyCacheControl('openai:gpt-4o', 'system', original, 'sess')
    // messages 内容与原始一致
    expect(messages).toEqual(original)
  })
})

// ── 不支持 prompt cache 的 provider：原样返回 ────────────────────────────────

describe('不支持 prompt cache 的 provider（google / alibaba）', () => {
  it('google:gemini-2.0-flash 不注入任何标记', () => {
    const original = makeMessages(5)
    const { systemMessage, messages } = applyCacheControl(
      'google:gemini-2.0-flash',
      'system',
      original,
      'sess',
    )
    expect(systemMessage.providerOptions).toBeUndefined()
    expect(messages).toBe(original)  // 原样返回（同一引用）
  })

  it('alibaba:qwen-plus 不注入任何标记', () => {
    const original = makeMessages(3)
    const { systemMessage, messages } = applyCacheControl(
      'alibaba:qwen-plus',
      'system',
      original,
      'sess',
    )
    expect(systemMessage.providerOptions).toBeUndefined()
    expect(messages).toBe(original)
  })
})

// ── 断点只注入在 messages 末尾（策略正确性）────────────────────────────────────

describe('Anthropic 断点位置 — 只注入 messages 末尾', () => {
  it('5 条消息时，前 2 条无断点，末 3 条有断点', () => {
    const { messages } = applyCacheControl(
      'anthropic:claude-sonnet-4-5',
      'system',
      makeMessages(5),
      'sess',
    )
    // 前 2 条（index 0, 1）不应有断点
    for (let i = 0; i < 2; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((messages[i]?.providerOptions?.anthropic as any)?.cacheControl).toBeUndefined()
    }
    // 末 3 条（index 2, 3, 4）应有断点
    for (let i = 2; i < 5; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((messages[i]?.providerOptions?.anthropic as any)?.cacheControl).toBeDefined()
    }
  })
})

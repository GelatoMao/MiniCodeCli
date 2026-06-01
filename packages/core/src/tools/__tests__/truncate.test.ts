// @mini-code-cli/core — truncateToolResult 单元测试
//
// 测试覆盖：
//   1. 未超限内容原样返回
//   2. 行数超限时触发截断，结果包含 '[truncated:'
//   3. head-tail 模式：截断标记在头部和尾部之间
//   4. head 模式：截断标记在末尾
//   5. tail 模式：截断标记在开头
//   6. 字节超限时也触发截断
//   7. 截断标记中包含丢弃的行数信息

import { describe, it, expect } from 'vitest'

import { truncateToolResult } from '../truncate.js'

// 生成 N 行内容（每行内容为 "line<i>"）
function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n')
}

describe('truncateToolResult', () => {
  it('未超限时原样返回，不插入截断标记', () => {
    const input = makeLines(10)
    const result = truncateToolResult(input, { maxLines: 20, maxBytes: 10 * 1024 * 1024 })
    expect(result).toBe(input)
    expect(result).not.toContain('[truncated:')
  })

  it('行数超限时触发截断，结果包含截断标记', () => {
    const input = makeLines(30)
    const result = truncateToolResult(input, { maxLines: 10 })
    expect(result).toContain('[truncated:')
  })

  it('head-tail 模式：截断标记在头部和尾部之间，首尾均有内容', () => {
    const input = makeLines(30)
    const result = truncateToolResult(input, { maxLines: 10, direction: 'head-tail' })

    expect(result).toContain('[truncated:')
    // 标记前后都应有内容（头部 line1，尾部 line30）
    const markerIdx = result.indexOf('[truncated:')
    expect(markerIdx).toBeGreaterThan(0)
    expect(result.slice(markerIdx + 1)).toBeTruthy()
    expect(result).toContain('line1')
    expect(result).toContain('line30')
  })

  it('head 模式：截断标记在末尾，只保留开头内容', () => {
    const input = makeLines(30)
    const result = truncateToolResult(input, { maxLines: 5, direction: 'head' })

    expect(result).toContain('[truncated:')
    // 标记在最后
    const markerIdx = result.indexOf('[truncated:')
    const afterMarker = result.slice(markerIdx + '[truncated:'.length)
    // 标记后面没有新的数字行（line26 等尾部内容不应出现）
    expect(result).toContain('line1')
    expect(result).not.toContain('line30')
    // 末尾包含标记
    expect(result.trim()).toMatch(/\[truncated:.*\]$/)
  })

  it('tail 模式：截断标记在开头，只保留末尾内容', () => {
    const input = makeLines(30)
    const result = truncateToolResult(input, { maxLines: 5, direction: 'tail' })

    expect(result).toContain('[truncated:')
    // 开头是截断标记
    expect(result.trimStart()).toMatch(/^\[truncated:/)
    expect(result).toContain('line30')
    expect(result).not.toContain('line1')
  })

  it('字节超限时触发截断', () => {
    // 构造一行超过 maxBytes 的内容
    const bigLine = 'A'.repeat(1000)
    const input = Array.from({ length: 10 }, () => bigLine).join('\n')
    const result = truncateToolResult(input, { maxLines: 9999, maxBytes: 2000 })
    expect(result).toContain('[truncated:')
  })

  it('截断标记中包含丢弃的行数信息（lines 字样）', () => {
    const input = makeLines(30)
    const result = truncateToolResult(input, { maxLines: 10 })
    // 超行数截断时，标记中应包含 "lines" 字样
    expect(result).toMatch(/\d+ lines/)
  })

  it('行数刚好等于 maxLines 时不截断', () => {
    const input = makeLines(10)
    const result = truncateToolResult(input, { maxLines: 10, maxBytes: 10 * 1024 * 1024 })
    expect(result).toBe(input)
  })
})

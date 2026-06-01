// @mini-code-cli/core — edit 工具单元测试
//
// edit 是 schema-only 工具（无 execute），由 agent loop 手动分发。
// 测试重点：
//   1. inputSchema 包含正确的字段定义
//   2. execute 为 undefined（确认是手动分发工具）
//   3. replaceAll 为可选 boolean 字段

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { edit } from '../edit.js'

describe('edit 工具定义', () => {
  it('execute 为 undefined（手动分发工具，不由 AI SDK 自动执行）', () => {
    expect(edit.execute).toBeUndefined()
  })

  it('inputSchema 包含 filePath 字段（string）', () => {
    const result = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
    })
    expect(result.success).toBe(true)
  })

  it('inputSchema 包含 oldString 和 newString 必填字段', () => {
    // 缺少 oldString 时校验失败
    const missingOld = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      newString: 'bar',
    })
    expect(missingOld.success).toBe(false)

    // 缺少 newString 时校验失败
    const missingNew = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
    })
    expect(missingNew.success).toBe(false)
  })

  it('replaceAll 为可选字段：不传时校验通过', () => {
    const result = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      // replaceAll 未传
    })
    expect(result.success).toBe(true)
  })

  it('replaceAll 传入 boolean 时校验通过', () => {
    const withTrue = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: true,
    })
    expect(withTrue.success).toBe(true)

    const withFalse = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: false,
    })
    expect(withFalse.success).toBe(true)
  })

  it('replaceAll 传入非 boolean 时校验失败', () => {
    const result = edit.inputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: 'yes', // 错误类型
    })
    expect(result.success).toBe(false)
  })
})

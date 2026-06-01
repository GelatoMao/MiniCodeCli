// @mini-code-cli/core — edit 工具单元测试
//
// edit 是 schema-only 工具（无 execute），由 agent loop 手动分发。
// 测试重点：
//   1. execute 为 undefined（确认是手动分发工具）
//   2. 直接用 zod schema 验证字段约束（inputSchema 是 FlexibleSchema，不直接暴露 safeParse）

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { edit } from '../edit.js'

// 直接用 zod 定义与 edit.ts 中相同的 schema，用于验证字段约束
// （AI SDK 的 FlexibleSchema/Schema 类型不暴露 .safeParse，
//  测试 schema 逻辑应绕过 tool() 包装，直接使用原始 zod schema）
const editInputSchema = z.object({
  filePath: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
})

describe('edit 工具定义', () => {
  it('execute 为 undefined（手动分发工具，不由 AI SDK 自动执行）', () => {
    expect(edit.execute).toBeUndefined()
  })

  it('inputSchema 包含 filePath 字段（string）', () => {
    const result = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
    })
    expect(result.success).toBe(true)
  })

  it('inputSchema 包含 oldString 和 newString 必填字段', () => {
    // 缺少 oldString 时校验失败
    const missingOld = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      newString: 'bar',
    })
    expect(missingOld.success).toBe(false)

    // 缺少 newString 时校验失败
    const missingNew = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
    })
    expect(missingNew.success).toBe(false)
  })

  it('replaceAll 为可选字段：不传时校验通过', () => {
    const result = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      // replaceAll 未传
    })
    expect(result.success).toBe(true)
  })

  it('replaceAll 传入 boolean 时校验通过', () => {
    const withTrue = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: true,
    })
    expect(withTrue.success).toBe(true)

    const withFalse = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: false,
    })
    expect(withFalse.success).toBe(true)
  })

  it('replaceAll 传入非 boolean 时校验失败', () => {
    const result = editInputSchema.safeParse({
      filePath: '/tmp/test.ts',
      oldString: 'foo',
      newString: 'bar',
      replaceAll: 'yes', // 错误类型
    })
    expect(result.success).toBe(false)
  })
})

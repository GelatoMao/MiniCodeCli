// @mini-code-cli/core — readFile 工具单元测试
//
// 测试覆盖：
//   1. 正常读取文件 → 带行号格式 `<行号>\t<内容>`
//   2. 文件不存在（ENOENT）→ 返回错误字符串，不抛出异常
//   3. offset / limit 范围读取
//   4. 超过 2000 行时自动截断，附加截断提示
//   5. 输出超过 256 KB 时停止并附加字节上限提示

import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// readFile 工具的 execute 函数封装在 tool({ execute }) 内，
// 通过 tool.execute 拿到实际的异步函数。
import { readFile } from '../read-file.js'

// --------------------------------
// 辅助：创建/清理临时文件
// --------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-code-cli-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeTmp(filename: string, content: string): Promise<string> {
  const p = path.join(tmpDir, filename)
  await fs.writeFile(p, content, 'utf-8')
  return p
}

// --------------------------------
// 辅助：调用 readFile.execute
// --------------------------------
// tool() 返回的对象中 execute 是一个函数，第二个参数需要 ToolExecutionOptions。
// 测试只关心返回值，传入最小必要参数即可。

const FAKE_OPTIONS = { toolCallId: 'test-call', messages: [], abortSignal: new AbortController().signal }

async function callReadFile(args: {
  filePath: string
  offset?: number
  limit?: number
}): Promise<string> {
  // vitest 环境下 tool.execute 一定存在（readFile 是 auto-execute 工具）
  const result = await readFile.execute!(args, FAKE_OPTIONS)
  return result as string
}

// ================================
// 测试用例
// ================================

describe('readFile', () => {
  it('正常读取文件时返回带行号格式的字符串', async () => {
    const filePath = await writeTmp('sample.txt', 'line1\nline2\nline3')
    const result = await callReadFile({ filePath })

    expect(result).toContain('1\tline1')
    expect(result).toContain('2\tline2')
    expect(result).toContain('3\tline3')
  })

  it('文件不存在时返回错误字符串而非抛出异常', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.txt')
    const result = await callReadFile({ filePath })

    // 应返回格式为 "Error reading file: ..." 的字符串
    expect(typeof result).toBe('string')
    expect(result).toMatch(/Error reading file:/i)
    expect(result).toMatch(/ENOENT/i)
  })

  it('指定 offset=2 limit=1 时只返回第 2 行', async () => {
    const filePath = await writeTmp('lines.txt', 'AAA\nBBB\nCCC\nDDD')
    const result = await callReadFile({ filePath, offset: 2, limit: 1 })

    expect(result).toContain('2\tBBB')
    expect(result).not.toContain('AAA')
    expect(result).not.toContain('CCC')
  })

  it('文件超过 2000 行时自动截断并附加提示', async () => {
    // 生成 2001 行内容
    const lines = Array.from({ length: 2001 }, (_, i) => `line${i + 1}`).join('\n')
    const filePath = await writeTmp('large.txt', lines)
    const result = await callReadFile({ filePath })

    // 应包含截断提示
    expect(result).toMatch(/showing first 2000/)
    // 不应包含第 2001 行
    expect(result).not.toContain('line2001')
  })

  it('offset=1 从第一行开始', async () => {
    const filePath = await writeTmp('abc.txt', 'A\nB\nC')
    const result = await callReadFile({ filePath, offset: 1, limit: 2 })

    expect(result).toContain('1\tA')
    expect(result).toContain('2\tB')
    expect(result).not.toContain('3\tC')
  })

  it('超过 256 KB 的输出附加字节上限提示', async () => {
    // 生成多行内容，每行 10KB，共 30 行 = 300KB，触发字节截断
    // 注意：行数需在 2000 以内，确保是字节截断而非行数截断
    const longLine = 'x'.repeat(10 * 1024)
    const content = Array.from({ length: 30 }, () => longLine).join('\n')
    const filePath = await writeTmp('huge.txt', content)
    const result = await callReadFile({ filePath })

    expect(result).toMatch(/capped at 256 KB/i)
  })
})

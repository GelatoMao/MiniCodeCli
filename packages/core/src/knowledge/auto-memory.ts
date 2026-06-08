// @mini-code-cli/core — Auto Memory 读写模块
//
// auto-memory.md 是由 MemoryExtractor 自动维护的"知识备忘录"，
// 每次 agentLoop 正常结束后异步提取关键事实并追加到此文件。
//
// 文件位置：
//   - 项目级：<cwd>/.mini-code/auto-memory.md
//   - 用户级：~/.mini-code/auto-memory.md
//
// 格式约定：
//   - 每条事实以 Markdown 列表行形式追加（- YYYY-MM-DD: <fact>）
//   - 读取时不解析格式，直接返回原始文本（作为 context 注入系统提示）
//   - 写入时追加到文件末尾，不修改已有内容

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { MINI_CODE_DIR } from '../utils.js'

// ── 路径计算 ──────────────────────────────────────────────────────────────────

/** 项目级 auto-memory.md 的路径。
 *  @param cwd 工作目录（默认 process.cwd()）*/
export function getProjectAutoMemoryPath(cwd: string = process.cwd()): string {
  return path.join(cwd, MINI_CODE_DIR, 'auto-memory.md')
}

/** 用户级 auto-memory.md 的路径（~/.mini-code/auto-memory.md）。*/
export function getUserAutoMemoryPath(): string {
  return path.join(os.homedir(), MINI_CODE_DIR, 'auto-memory.md')
}

// ── 读取 ──────────────────────────────────────────────────────────────────────

/** 读取 auto-memory.md 文件内容。
 *  文件不存在时返回空字符串（正常情况，不报错）。
 *  @param filePath auto-memory.md 的绝对路径*/
export function readAutoMemory(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    // ENOENT：文件不存在 → 返回空字符串（正常情况）
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }
    // 其他错误（权限不足等）：静默忽略，避免影响主流程
    return ''
  }
}

// ── 写入 ──────────────────────────────────────────────────────────────────────

/** 向 auto-memory.md 追加一批新事实。
 *
 *  写入格式：每条事实单独一行，以 "- " 开头。
 *  如果文件不存在，自动创建（及其父目录）。
 *
 *  @param filePath auto-memory.md 的绝对路径
 *  @param facts    新事实列表（每条是一个字符串，不含前缀）*/
export function appendAutoMemory(filePath: string, facts: string[]): void {
  if (facts.length === 0) return

  const dir = path.dirname(filePath)
  // 确保目录存在
  fs.mkdirSync(dir, { recursive: true })

  const dateStr = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const lines = facts.map((f) => `- ${dateStr}: ${f.trim()}`).join('\n')
  // 追加时在末尾加换行，避免下次追加时行首粘连
  const toAppend = lines + '\n'

  fs.appendFileSync(filePath, toAppend, 'utf-8')
}

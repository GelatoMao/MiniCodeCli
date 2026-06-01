// @mini-code-cli/core — session-store 单元测试
//
// 测试覆盖：
//   SessionPermissionStore — addRule / matches / clear（内存存储）
//   buildAllowRule         — shell 精确匹配 / 其他工具 tool 级别
//   suggestRuleLabel       — 标签文本
//   persistRule / loadPersistedRules — 磁盘持久化（使用临时目录）

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addSessionAllowRule,
  buildAllowRule,
  clearSessionRules,
  loadPersistedRules,
  persistRule,
  sessionRulesMatch,
  suggestRuleLabel,
} from '../session-store.js'

afterEach(() => {
  clearSessionRules()
})

// ─── 内存存储：非 shell 工具 ──────────────────────────────────────────────────

describe('SessionPermissionStore — 非 shell 工具', () => {
  it('初始状态：任何工具都不匹配', () => {
    expect(sessionRulesMatch('edit', {})).toBe(false)
    expect(sessionRulesMatch('writeFile', {})).toBe(false)
  })

  it('添加 tool 级别规则后，同工具任意 input 都匹配', () => {
    addSessionAllowRule({ tool: 'edit', pattern: '*', type: 'tool' })
    expect(sessionRulesMatch('edit', {})).toBe(true)
    expect(sessionRulesMatch('edit', { filePath: '/tmp/foo.ts' })).toBe(true)
  })

  it('tool 规则不跨工具匹配', () => {
    addSessionAllowRule({ tool: 'edit', pattern: '*', type: 'tool' })
    expect(sessionRulesMatch('writeFile', {})).toBe(false)
    expect(sessionRulesMatch('shell', { command: 'ls' })).toBe(false)
  })

  it('clear 后规则失效', () => {
    addSessionAllowRule({ tool: 'edit', pattern: '*', type: 'tool' })
    expect(sessionRulesMatch('edit', {})).toBe(true)
    clearSessionRules()
    expect(sessionRulesMatch('edit', {})).toBe(false)
  })

  it('重复添加相同规则不累积', () => {
    addSessionAllowRule({ tool: 'edit', pattern: '*', type: 'tool' })
    addSessionAllowRule({ tool: 'edit', pattern: '*', type: 'tool' })
    // 仍然匹配（去重不影响功能）
    expect(sessionRulesMatch('edit', {})).toBe(true)
  })
})

// ─── 内存存储：shell 工具 ─────────────────────────────────────────────────────

describe('SessionPermissionStore — shell 工具', () => {
  it('shell tool 级别规则：匹配所有命令', () => {
    addSessionAllowRule({ tool: 'shell', pattern: '*', type: 'tool' })
    expect(sessionRulesMatch('shell', { command: 'npm install' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git commit -m "fix"' })).toBe(true)
  })

  it('shell 精确匹配规则：只匹配完全相同的命令', () => {
    addSessionAllowRule({ tool: 'shell', pattern: 'npm test', type: 'exact' })
    expect(sessionRulesMatch('shell', { command: 'npm test' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'npm run test' })).toBe(false)
    expect(sessionRulesMatch('shell', { command: 'npm test --watch' })).toBe(false)
  })

  it('shell 前缀匹配规则：命令以前缀开头即匹配', () => {
    addSessionAllowRule({ tool: 'shell', pattern: 'npm run', type: 'prefix' })
    expect(sessionRulesMatch('shell', { command: 'npm run build' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'npm run test' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'npm install' })).toBe(false)
  })

  it('空 command 字段不匹配精确规则', () => {
    addSessionAllowRule({ tool: 'shell', pattern: 'npm test', type: 'exact' })
    expect(sessionRulesMatch('shell', {})).toBe(false)
    expect(sessionRulesMatch('shell', { command: '' })).toBe(false)
  })
})

// ─── buildAllowRule ───────────────────────────────────────────────────────────

describe('buildAllowRule', () => {
  it('shell：返回精确匹配规则，persist=true', () => {
    const result = buildAllowRule('shell', { command: 'npm test' })
    expect(result).not.toBeNull()
    expect(result!.persist).toBe(true)
    expect(result!.rules).toHaveLength(1)
    expect(result!.rules[0]).toMatchObject({ tool: 'shell', pattern: 'npm test', type: 'exact' })
  })

  it('shell：空命令返回 null', () => {
    expect(buildAllowRule('shell', { command: '' })).toBeNull()
    expect(buildAllowRule('shell', {})).toBeNull()
  })

  it('edit：返回 tool 级别规则，persist=false', () => {
    const result = buildAllowRule('edit', { filePath: '/tmp/foo.ts' })
    expect(result).not.toBeNull()
    expect(result!.persist).toBe(false)
    expect(result!.rules[0]).toMatchObject({ tool: 'edit', pattern: '*', type: 'tool' })
  })

  it('writeFile：返回 tool 级别规则，persist=false', () => {
    const result = buildAllowRule('writeFile', { filePath: '/tmp/foo.ts' })
    expect(result!.persist).toBe(false)
    expect(result!.rules[0].type).toBe('tool')
  })
})

// ─── suggestRuleLabel ────────────────────────────────────────────────────────

describe('suggestRuleLabel', () => {
  it('shell → "this exact command"', () => {
    expect(suggestRuleLabel('shell', { command: 'npm test' })).toBe('this exact command')
  })

  it('edit → "all edits this session"', () => {
    expect(suggestRuleLabel('edit', {})).toBe('all edits this session')
  })

  it('writeFile → "all edits this session"', () => {
    expect(suggestRuleLabel('writeFile', {})).toBe('all edits this session')
  })
})

// ─── 磁盘持久化 ───────────────────────────────────────────────────────────────

describe('persistRule / loadPersistedRules', () => {
  let testDir: string

  beforeEach(() => {
    // 每个测试用独立的临时目录，防止状态污染
    testDir = path.join(tmpdir(), `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    clearSessionRules()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    clearSessionRules()
  })

  it('持久化后重新加载可以匹配', () => {
    const rule = { tool: 'shell', pattern: 'npm test', type: 'exact' as const }
    persistRule(testDir, rule)

    clearSessionRules()
    expect(sessionRulesMatch('shell', { command: 'npm test' })).toBe(false)

    loadPersistedRules(testDir)
    expect(sessionRulesMatch('shell', { command: 'npm test' })).toBe(true)
  })

  it('重复持久化相同规则不重复写入', () => {
    const rule = { tool: 'shell', pattern: 'npm test', type: 'exact' as const }
    persistRule(testDir, rule)
    persistRule(testDir, rule)

    clearSessionRules()
    loadPersistedRules(testDir)
    // 只有一条规则被加载（去重）
    expect(sessionRulesMatch('shell', { command: 'npm test' })).toBe(true)
  })

  it('持久化多条不同规则后全部可以加载', () => {
    persistRule(testDir, { tool: 'shell', pattern: 'npm test', type: 'exact' })
    persistRule(testDir, { tool: 'shell', pattern: 'git commit', type: 'prefix' })
    persistRule(testDir, { tool: 'edit', pattern: '*', type: 'tool' })

    clearSessionRules()
    loadPersistedRules(testDir)

    expect(sessionRulesMatch('shell', { command: 'npm test' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git commit -m "fix"' })).toBe(true)
    expect(sessionRulesMatch('edit', {})).toBe(true)
  })

  it('目录不存在时 loadPersistedRules 静默不报错', () => {
    expect(() => loadPersistedRules('/nonexistent/path/nowhere')).not.toThrow()
  })

  it('自动在 local/ 目录创建 .gitignore', () => {
    const rule = { tool: 'shell', pattern: 'npm test', type: 'exact' as const }
    persistRule(testDir, rule)

    const gitignorePath = path.join(testDir, '.mini-code', 'local', '.gitignore')
    expect(existsSync(gitignorePath)).toBe(true)
    expect(readFileSync(gitignorePath, 'utf-8')).toBe('*\n')
  })
})

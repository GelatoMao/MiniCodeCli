// @mini-code-cli/core — 权限系统单元测试
//
// 测试覆盖：
//   getPermissionLevel  — 各工具的基础权限级别
//   isPathWithinProject — 路径边界判断
//   checkPermission     — trustMode / acceptEdits / deny / session 规则的完整决策链
//
// Property 3（任务5.1）：
//   trustMode=true 时除 deny 外永远返回 true
//   plan 模式对写工具仍然走 ask 流程（不自动放行）

import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearSessionRules, addSessionAllowRule } from '../session-store.js'
import { checkPermission, getPermissionLevel, isPathWithinProject } from '../index.js'

// 每个测试后清空会话规则，防止状态污染
afterEach(() => {
  clearSessionRules()
})

// ─── getPermissionLevel ───────────────────────────────────────────────────────

describe('getPermissionLevel', () => {
  it.each([
    ['readFile',  {},                          'always-allow'],
    ['glob',      {},                          'always-allow'],
    ['grep',      {},                          'always-allow'],
    ['listDir',   {},                          'always-allow'],
    ['edit',      {},                          'ask'],
    ['writeFile', {},                          'ask'],
    ['unknownTool', {},                        'ask'],
  ] as [string, Record<string, unknown>, string][])('%s → %s', (tool, input, expected) => {
    expect(getPermissionLevel(tool, input)).toBe(expected)
  })

  it('shell 只读命令 → always-allow', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'cat README.md' })).toBe('always-allow')
  })

  it('shell 普通命令 → ask', () => {
    expect(getPermissionLevel('shell', { command: 'npm install' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'git commit -m "fix"' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'tsc --noEmit' })).toBe('ask')
  })

  it('shell 破坏性命令 → deny', () => {
    expect(getPermissionLevel('shell', { command: 'rm -rf /tmp' })).toBe('deny')
    expect(getPermissionLevel('shell', { command: 'git push --force' })).toBe('deny')
    expect(getPermissionLevel('shell', { command: 'sudo apt install vim' })).toBe('deny')
  })

  it('复合命令：含破坏性子命令 → deny', () => {
    expect(getPermissionLevel('shell', { command: 'ls && rm -rf /tmp' })).toBe('deny')
  })

  it('复合命令：全只读 → always-allow', () => {
    expect(getPermissionLevel('shell', { command: 'cd /tmp && ls -la' })).toBe('always-allow')
  })

  it('复合命令：含普通命令 → ask', () => {
    expect(getPermissionLevel('shell', { command: 'ls && npm install' })).toBe('ask')
  })
})

// ─── isPathWithinProject ─────────────────────────────────────────────────────

describe('isPathWithinProject', () => {
  const proj = '/Users/alice/my-project'

  it('路径等于项目目录 → true', () => {
    expect(isPathWithinProject(proj, proj)).toBe(true)
  })

  it('路径在项目目录内 → true', () => {
    expect(isPathWithinProject(`${proj}/src/index.ts`, proj)).toBe(true)
    expect(isPathWithinProject(`${proj}/packages/core/src/index.ts`, proj)).toBe(true)
  })

  it('路径在项目目录外 → false', () => {
    expect(isPathWithinProject('/Users/alice/other-project/file.ts', proj)).toBe(false)
    expect(isPathWithinProject('/tmp/file.ts', proj)).toBe(false)
  })

  it('路径以目录名开头但不是子目录（前缀攻击）→ false', () => {
    // /Users/alice/my-project-evil 不是 /Users/alice/my-project 的子目录
    expect(isPathWithinProject('/Users/alice/my-project-evil/file.ts', proj)).toBe(false)
  })

  it('末尾斜杠不影响结果', () => {
    expect(isPathWithinProject(`${proj}/src/`, `${proj}/`)).toBe(true)
  })
})

// ─── checkPermission ─────────────────────────────────────────────────────────

// 辅助：构造标准 toolCall 对象
function makeToolCall(toolName: string, input: Record<string, unknown> = {}) {
  return { toolCallId: 'tc-1', toolName, input }
}

// 辅助：不应被调用的 onAskPermission（用于验证"没有弹框"的路径）
const neverAsk = vi.fn(async () => 'yes' as const)

describe('checkPermission — deny 优先', () => {
  it('破坏性 shell 命令：即使 trustMode=true 也拒绝', async () => {
    const result = await checkPermission(
      makeToolCall('shell', { command: 'rm -rf /' }),
      true,   // trustMode
      neverAsk,
    )
    expect(result).toBe(false)
    expect(neverAsk).not.toHaveBeenCalled()
  })
})

describe('checkPermission — trustMode', () => {
  it('trustMode=true：always-allow 工具直接放行', async () => {
    const result = await checkPermission(makeToolCall('readFile'), true, neverAsk)
    expect(result).toBe(true)
    expect(neverAsk).not.toHaveBeenCalled()
  })

  it('trustMode=true：ask 级别工具也直接放行，不弹框', async () => {
    const result = await checkPermission(makeToolCall('edit', { filePath: '/tmp/foo.ts' }), true, neverAsk)
    expect(result).toBe(true)
    expect(neverAsk).not.toHaveBeenCalled()
  })

  it('trustMode=true：shell 普通命令直接放行', async () => {
    const result = await checkPermission(
      makeToolCall('shell', { command: 'npm install' }),
      true,
      neverAsk,
    )
    expect(result).toBe(true)
    expect(neverAsk).not.toHaveBeenCalled()
  })

  it('Property 3a：trustMode=true 时，除 deny 外所有工具都返回 true', async () => {
    const nonDenyTools = [
      makeToolCall('readFile'),
      makeToolCall('glob'),
      makeToolCall('edit', { filePath: '/tmp/foo.ts' }),
      makeToolCall('writeFile', { filePath: '/tmp/foo.ts' }),
      makeToolCall('shell', { command: 'npm install' }),
      makeToolCall('shell', { command: 'git status' }),
    ]
    for (const tc of nonDenyTools) {
      const r = await checkPermission(tc, true, neverAsk)
      expect(r, `trustMode 下 ${tc.toolName} 应返回 true`).toBe(true)
    }
    expect(neverAsk).not.toHaveBeenCalled()
  })
})

describe('checkPermission — acceptEdits 模式', () => {
  const cwd = tmpdir()

  it('项目内普通文件：自动放行，不弹框', async () => {
    const filePath = path.join(cwd, 'src', 'index.ts')
    const result = await checkPermission(
      makeToolCall('edit', { filePath }),
      false,
      neverAsk,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(neverAsk).not.toHaveBeenCalled()
  })

  it('项目外文件：回退到弹框', async () => {
    const askFn = vi.fn(async () => 'yes' as const)
    const result = await checkPermission(
      makeToolCall('edit', { filePath: '/etc/passwd' }),
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalledOnce()
  })

  it('敏感文件（.bashrc）：即使在项目内也弹框', async () => {
    const askFn = vi.fn(async () => 'yes' as const)
    const filePath = path.join(cwd, '.bashrc')
    const result = await checkPermission(
      makeToolCall('edit', { filePath }),
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalledOnce()
  })

  it('敏感文件（.ssh/config）：弹框', async () => {
    const askFn = vi.fn(async () => 'no' as const)
    const filePath = path.join(cwd, '.ssh', 'config')
    const result = await checkPermission(
      makeToolCall('edit', { filePath }),
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalledOnce()
  })

  it('Property 3b：plan 模式下写工具仍走 ask 流程（不自动放行）', async () => {
    const askFn = vi.fn(async () => 'yes' as const)
    const filePath = path.join(cwd, 'src', 'index.ts')
    // plan 模式不影响权限层——写工具仍然是 ask 级别，需要弹框
    await checkPermission(
      makeToolCall('writeFile', { filePath }),
      false,
      askFn,
      'plan',
      cwd,
    )
    expect(askFn).toHaveBeenCalledOnce()
  })
})

describe('checkPermission — 用户决策', () => {
  it('用户选 yes → 返回 true，不保存规则', async () => {
    const askFn = vi.fn(async () => 'yes' as const)
    const result = await checkPermission(makeToolCall('edit', { filePath: '/tmp/a.ts' }), false, askFn)
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalledOnce()
  })

  it('用户选 no → 返回 false', async () => {
    const askFn = vi.fn(async () => 'no' as const)
    const result = await checkPermission(makeToolCall('edit', { filePath: '/tmp/a.ts' }), false, askFn)
    expect(result).toBe(false)
  })

  it('用户选 always → 返回 true，后续同工具不再弹框', async () => {
    const askFn = vi.fn(async () => 'always' as const)
    const tc = makeToolCall('edit', { filePath: '/tmp/a.ts' })

    // 第一次：弹框，选 always
    const r1 = await checkPermission(tc, false, askFn)
    expect(r1).toBe(true)
    expect(askFn).toHaveBeenCalledOnce()

    // 第二次：会话规则命中，不再弹框
    const r2 = await checkPermission(tc, false, neverAsk)
    expect(r2).toBe(true)
    expect(neverAsk).not.toHaveBeenCalled()
  })
})

describe('checkPermission — 会话规则预设', () => {
  it('预先添加会话规则后不弹框', async () => {
    addSessionAllowRule({ tool: 'shell', pattern: 'npm test', type: 'exact' })
    const result = await checkPermission(
      makeToolCall('shell', { command: 'npm test' }),
      false,
      neverAsk,
    )
    expect(result).toBe(true)
    expect(neverAsk).not.toHaveBeenCalled()
  })
})
